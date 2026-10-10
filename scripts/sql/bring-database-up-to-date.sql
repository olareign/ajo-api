-- ============================================================================================
-- Àjọ — bring a database up to date by hand (Neon SQL editor, psql, any client).
--
-- This is the same schema the TypeORM migrations in src/database/migrations build, written so it
-- is safe to run on:
--   * an empty database           -> creates everything
--   * a database part-way through -> adds only what is missing (e.g. no email_verified yet)
--   * an up-to-date database      -> changes nothing
-- Run it as often as you like. It all happens in one transaction: if any statement fails,
-- nothing is applied. The last statement lists what ended up in place, so you can check.
--
-- email_verified: ends up as `boolean NOT NULL DEFAULT false`. If the column is missing it is
-- added; if it exists with another type (text, integer, a timestamp) it is converted. Anyone who
-- is already confirmed (flag true OR email_verified_at set) stays confirmed; everyone else is
-- false. A CHECK constraint and a trigger then keep it in step with email_verified_at.
--
-- It also records each migration in TypeORM's `migrations` table, so the API's own
-- `pnpm migration:run` (Render's pre-deploy command) sees them as done and does not run them twice.
--
-- Keep in step with src/database/migrations/*.ts: when you add a migration, add it here too.
-- ============================================================================================

BEGIN;

-- Lock every existing table before changing anything. The steps below lock tables one at a time
-- (even a step with nothing to do, like adding a column that is already there), so with the app
-- running, a request holding one table and waiting for another could deadlock with this script.
-- Taking all the locks at once, without waiting, rules that out: if any table is busy, the
-- attempt lets go of everything, pauses and tries again. Once held, the app's requests wait a
-- moment until COMMIT. On an empty database there is nothing to lock.
DO $$
DECLARE
  tables text;
  attempt int := 0;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename)
    INTO tables
    FROM pg_tables
   WHERE schemaname = current_schema();
  IF tables IS NULL THEN
    RETURN;
  END IF;
  LOOP
    BEGIN
      EXECUTE 'LOCK TABLE ' || tables || ' IN ACCESS EXCLUSIVE MODE NOWAIT';
      RETURN;
    EXCEPTION WHEN lock_not_available THEN
      attempt := attempt + 1;
      IF attempt >= 300 THEN
        RAISE EXCEPTION 'The app kept the database busy for 30 seconds, so nothing was changed. Run the script again, or pause ajo-api and ajo-worker on Render while it runs.';
      END IF;
      PERFORM pg_sleep(0.1);
    END;
  END LOOP;
END $$;

-- 1790900000000 EnableExtensions ------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- 1790900001000 CreateUsers -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE CHECK (char_length(email) <= 254),
  email_verified_at timestamptz,
  password_hash text NOT NULL,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_verification_tokens_user_id_idx ON email_verification_tokens (user_id);

-- 1790900002000 CreateSessions --------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IN ('logout', 'logout_all', 'refresh_reuse', 'password_reset', 'admin')),
  ip inet,
  user_agent text CHECK (char_length(user_agent) <= 512)
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refresh_tokens_session_id_idx ON refresh_tokens (session_id);

-- 1790900010000 CreatePasswordResetTokens ---------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

-- 1790900011000 CreateMfa -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  totp_secret text NOT NULL CHECK (left(totp_secret, 3) = 'v1.'),
  confirmed_at timestamptz,
  last_used_step bigint,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_challenges_user_id_idx ON mfa_challenges (user_id);

-- 1790900020000 CreateLedger ----------------------------------------------------------------
-- The database enforces the money rules itself: positive whole amounts, an entry's currency is
-- its account's, every transaction balances per currency at commit, posted rows never change.
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type text NOT NULL CHECK (owner_type IN ('user', 'system')),
  owner_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  kind text NOT NULL CHECK (kind IN
    ('available', 'locked', 'savings', 'pot', 'fees', 'exchange', 'settlement', 'suspense')),
  ref text CHECK (char_length(ref) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner_type = 'user') = (owner_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_identity ON ledger_accounts
  (owner_type, (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), currency, kind, (coalesce(ref, '')));

CREATE TABLE IF NOT EXISTS ledger_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 64),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_hash char(64),
  reference text CHECK (char_length(reference) <= 200),
  reverses uuid UNIQUE REFERENCES ledger_transactions (id),
  reason text CHECK (char_length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES ledger_transactions (id),
  account_id uuid NOT NULL REFERENCES ledger_accounts (id),
  currency char(3) NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries (account_id, id);
CREATE INDEX IF NOT EXISTS ledger_entries_transaction_idx ON ledger_entries (transaction_id);

-- Posted rows are immutable.
CREATE OR REPLACE FUNCTION ledger_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger rows are immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;
DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();
DROP TRIGGER IF EXISTS ledger_entries_no_truncate ON ledger_entries;
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_change();
DROP TRIGGER IF EXISTS ledger_transactions_immutable ON ledger_transactions;
CREATE TRIGGER ledger_transactions_immutable BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_change();
DROP TRIGGER IF EXISTS ledger_transactions_no_truncate ON ledger_transactions;
CREATE TRIGGER ledger_transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_change();

-- An account's identity (owner, currency, kind) never changes.
CREATE OR REPLACE FUNCTION ledger_account_identity_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.owner_type, NEW.owner_id, NEW.currency, NEW.kind, NEW.ref)
     IS DISTINCT FROM (OLD.owner_type, OLD.owner_id, OLD.currency, OLD.kind, OLD.ref) THEN
    RAISE EXCEPTION 'ledger account identity is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ledger_accounts_frozen ON ledger_accounts;
CREATE TRIGGER ledger_accounts_frozen BEFORE UPDATE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_account_identity_frozen();

-- An entry's currency is its account's, and entries can only join a transaction created in the
-- same database transaction, so a posted transaction cannot be added to later.
CREATE OR REPLACE FUNCTION ledger_check_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_currency char(3); created_xid bigint;
BEGIN
  SELECT currency INTO account_currency FROM ledger_accounts WHERE id = NEW.account_id;
  IF account_currency IS DISTINCT FROM NEW.currency THEN
    RAISE EXCEPTION 'entry currency % does not match its account (%)', NEW.currency, account_currency;
  END IF;
  SELECT xmin::text::bigint INTO created_xid FROM ledger_transactions WHERE id = NEW.transaction_id;
  IF created_xid IS DISTINCT FROM (txid_current() & 4294967295) THEN
    RAISE EXCEPTION 'entries can only be added when the transaction is created';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ledger_entries_check ON ledger_entries;
CREATE TRIGGER ledger_entries_check BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_check_entry();

-- At commit: at least two entries, and debits equal credits in each currency.
CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tx uuid;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    tx := NEW.transaction_id;
  ELSE
    tx := NEW.id;
  END IF;
  IF (SELECT count(*) FROM ledger_entries WHERE transaction_id = tx) < 2 THEN
    RAISE EXCEPTION 'transaction % needs at least two entries to balance', tx;
  END IF;
  IF EXISTS (
    SELECT 1 FROM ledger_entries WHERE transaction_id = tx GROUP BY currency
    HAVING sum(CASE direction WHEN 'debit' THEN amount ELSE -amount END) <> 0
  ) THEN
    RAISE EXCEPTION 'transaction % does not balance in every currency', tx;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries;
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
DROP TRIGGER IF EXISTS ledger_transactions_have_entries ON ledger_transactions;
CREATE CONSTRAINT TRIGGER ledger_transactions_have_entries AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- 1790900030000 CreateOnboarding ------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS country char(2) CHECK (country IN ('NG', 'GB')),
  ADD COLUMN IF NOT EXISTS goal text CHECK (goal IN ('solo', 'circle', 'both'));
CREATE TABLE IF NOT EXISTS transaction_pins (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  pin_hash text NOT NULL,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 1790900040000 AddEmailVerified ------------------------------------------------------------
-- The flag must be a boolean. Add it, or convert it if it exists as something else.
DO $do$
DECLARE current_type text;
BEGIN
  SELECT data_type INTO current_type FROM information_schema.columns
   WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'email_verified';

  IF current_type IS NULL THEN
    ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false;
  ELSIF current_type <> 'boolean' THEN
    -- Drop what depends on the old type, then convert. Text 'true'/'t'/'yes'/'1' and any
    -- timestamp or number other than 0 count as verified; everything else, including NULL, does not.
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_verified_matches_timestamp;
    ALTER TABLE users ALTER COLUMN email_verified DROP DEFAULT;
    ALTER TABLE users ALTER COLUMN email_verified TYPE boolean USING (
      CASE WHEN email_verified IS NULL THEN false
           WHEN lower(email_verified::text) IN ('false', 'f', 'no', 'n', '0', '') THEN false
           ELSE true END);
    UPDATE users SET email_verified = false WHERE email_verified IS NULL;
    ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false;
    ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL;
  ELSE
    ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false;
    UPDATE users SET email_verified = false WHERE email_verified IS NULL;
    ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL;
  END IF;
END $do$;

-- Reconcile the flag and the timestamp, never un-verifying anyone:
--   confirmed by timestamp but flag false -> flag true
--   flag true but no timestamp            -> stamp it now
-- (The trigger below does not exist yet on a first run, so these two are plain updates.)
DROP TRIGGER IF EXISTS users_flag_email_verified ON users;
UPDATE users SET email_verified = true WHERE email_verified_at IS NOT NULL AND NOT email_verified;
UPDATE users SET email_verified_at = now() WHERE email_verified AND email_verified_at IS NULL;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'users_email_verified_matches_timestamp'
                    AND conrelid = 'users'::regclass) THEN
    ALTER TABLE users ADD CONSTRAINT users_email_verified_matches_timestamp
      CHECK (email_verified = (email_verified_at IS NOT NULL));
  END IF;
END $do$;

-- Older code that sets only the timestamp still flips the flag, so nobody is refused mid-deploy.
CREATE OR REPLACE FUNCTION users_flag_email_verified() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.email_verified_at IS NULL AND NEW.email_verified_at IS NOT NULL THEN
    NEW.email_verified := true;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_flag_email_verified BEFORE UPDATE OF email_verified_at ON users
  FOR EACH ROW EXECUTE FUNCTION users_flag_email_verified();

-- 1790900041000 AddRetentionSupport ---------------------------------------------------------
-- It also widens the reasons a session ends with 'session_limit'. That list is set once, in full,
-- under 1790900160000 below: setting this shorter list here would fail on a re-run once sessions
-- have ended for the newer reasons.
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS sessions_revoked_at_idx ON sessions (revoked_at) WHERE revoked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);
CREATE INDEX IF NOT EXISTS email_verification_tokens_expires_at_idx ON email_verification_tokens (expires_at);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_at_idx ON password_reset_tokens (expires_at);
CREATE INDEX IF NOT EXISTS mfa_challenges_expires_at_idx ON mfa_challenges (expires_at);

-- 1790900050000 AddUsername -----------------------------------------------------------------
-- A public handle: case-insensitive unique, and the database refuses anything that is not 3 to 20
-- lowercase letters, digits or underscores starting with a letter. Empty until chosen at onboarding.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username citext;
DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'users_username_key' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'users_username_format' AND conrelid = 'users'::regclass) THEN
    ALTER TABLE users ADD CONSTRAINT users_username_format
      CHECK (username::text ~ '^[a-z][a-z0-9_]{2,19}$');
  END IF;
END $do$;

-- 1790900060000 AddLoginDevices -------------------------------------------------------------
-- The kinds of device each person has signed in from, so a new kind can be pointed out by email.
CREATE TABLE IF NOT EXISTS login_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_key char(64) NOT NULL,
  label text NOT NULL CHECK (char_length(label) <= 100),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_ip inet,
  alerted_at timestamptz,
  UNIQUE (user_id, device_key)
);

-- 1790900070000 AddTrustedDevices -----------------------------------------------------------
-- Devices remembered after an authenticator code, so the next sign-in from them skips it. Only a
-- hash of the device's secret is kept.
CREATE TABLE IF NOT EXISTS trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  label text NOT NULL CHECK (char_length(label) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS trusted_devices_user_idx ON trusted_devices (user_id);
CREATE INDEX IF NOT EXISTS trusted_devices_expires_idx ON trusted_devices (expires_at);

-- 1790900080000 CreateKycSteps --------------------------------------------------------------
-- One row per person per verification step (waiting, approved or refused with a reason). Overall
-- status and tier are worked out from these rows, never stored.
CREATE TABLE IF NOT EXISTS kyc_steps (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  step text NOT NULL
    CHECK (step IN ('id', 'selfie', 'address', 'location', 'bank', 'national_check')),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  reason text CHECK (char_length(reason) <= 300),
  provider_ref text CHECK (char_length(provider_ref) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, step)
);

-- 1790900090000 CreatePayments --------------------------------------------------------------
-- Money moving through payment partners: payment attempts, the webhook inbox, where withdrawals go,
-- and standing collection permissions (mandates). The rules that protect money live here too: one
-- open mandate per person, one attempt per idempotency key, one stored copy of each partner event.
CREATE TABLE IF NOT EXISTS payment_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('funding', 'withdrawal')),
  provider text NOT NULL CHECK (provider IN ('paystack', 'fake')),
  method text NOT NULL CHECK (method IN ('card', 'transfer', 'ussd', 'direct_debit', 'bank_account')),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL CHECK (status IN ('created', 'pending', 'succeeded', 'failed', 'reversed')),
  reference text NOT NULL UNIQUE CHECK (char_length(reference) BETWEEN 16 AND 50),
  provider_id text CHECK (char_length(provider_id) <= 200),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  request_hash char(64) NOT NULL,
  action jsonb,
  recipient_code text CHECK (char_length(recipient_code) <= 100),
  failure_reason text CHECK (char_length(failure_reason) <= 300),
  ledger_transaction_id uuid REFERENCES ledger_transactions (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, idempotency_key)
);
CREATE INDEX IF NOT EXISTS payment_intents_user_idx ON payment_intents (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payment_intents_provider_id_idx ON payment_intents (provider, provider_id)
  WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_intents_pending_idx ON payment_intents (updated_at)
  WHERE status IN ('created', 'pending');

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('paystack', 'fake')),
  event_id text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
  kind text NOT NULL,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'processed', 'ignored', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text CHECK (char_length(last_error) <= 500),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_open_idx ON webhook_events (received_at)
  WHERE status IN ('received', 'failed');

CREATE TABLE IF NOT EXISTS payout_accounts (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('paystack', 'fake')),
  bank_code text NOT NULL CHECK (char_length(bank_code) BETWEEN 2 AND 20),
  bank_name text NOT NULL CHECK (char_length(bank_name) <= 100),
  last4 char(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
  account_name text NOT NULL CHECK (char_length(account_name) <= 200),
  recipient_code text NOT NULL CHECK (char_length(recipient_code) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mandates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('paystack', 'fake')),
  status text NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'failed')),
  reference text NOT NULL UNIQUE CHECK (char_length(reference) BETWEEN 16 AND 50),
  provider_id text CHECK (char_length(provider_id) <= 200),
  provider_mandate_id text CHECK (char_length(provider_mandate_id) <= 200),
  authorization_code text CHECK (char_length(authorization_code) <= 200),
  action jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS mandates_one_open_per_user ON mandates (user_id)
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS mandates_provider_idx ON mandates (provider, provider_id)
  WHERE provider_id IS NOT NULL;

-- 1790900100000 CreateNotifications ---------------------------------------------------------
-- Messages to a person: shown in the app and optionally emailed from a queue. The same message key
-- for the same person is only ever saved once.
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 64),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  link text CHECK (link IS NULL OR (char_length(link) <= 200 AND link LIKE '/%')),
  dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  email_status text NOT NULL DEFAULT 'none' CHECK (email_status IN ('none', 'pending', 'sent', 'failed')),
  email_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, seq DESC);
CREATE INDEX IF NOT EXISTS notifications_email_pending_idx ON notifications (created_at)
  WHERE email_status = 'pending';

-- 1790900110000 CreateSavings ----------------------------------------------------------------
-- Solo saving plans and their scheduled debits. A plan's money sits in its own ledger account, so
-- what is saved is always read from the ledger, never counted.
CREATE TABLE IF NOT EXISTS savings_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount bigint NOT NULL CHECK (amount > 0),
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  total_debits integer NOT NULL CHECK (total_debits BETWEEN 2 AND 366),
  start_date date NOT NULL,
  topup_from_bank boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  paused_at timestamptz,
  closed_at timestamptz,
  payout_amount bigint CHECK (payout_amount IS NULL OR payout_amount >= 0),
  penalty_amount bigint NOT NULL DEFAULT 0 CHECK (penalty_amount >= 0),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS savings_plans_user_idx ON savings_plans (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS savings_debits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES savings_plans (id) ON DELETE RESTRICT,
  seq integer NOT NULL CHECK (seq >= 1),
  due_on date NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'paid', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  pull_key text CHECK (char_length(pull_key) <= 120),
  topup_intent_id uuid REFERENCES payment_intents (id) ON DELETE RESTRICT,
  ledger_transaction_id uuid REFERENCES ledger_transactions (id),
  paid_at timestamptz,
  note text CHECK (char_length(note) <= 200),
  UNIQUE (plan_id, seq)
);
CREATE INDEX IF NOT EXISTS savings_debits_due_idx ON savings_debits (next_attempt_at)
  WHERE status = 'scheduled';

-- 1790900120000 CreateFriends ----------------------------------------------------------------
-- Friendships (one row per pair, lowest id first, so crossing requests can never make two), blocks,
-- reports for the admin queue, invite links, and who invited whom.
CREATE TABLE IF NOT EXISTS friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  low_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  high_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  requester_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (low_id < high_id),
  CHECK (requester_id IN (low_id, high_id)),
  UNIQUE (low_id, high_id)
);
CREATE INDEX IF NOT EXISTS friendships_low_idx ON friendships (low_id, status);
CREATE INDEX IF NOT EXISTS friendships_high_idx ON friendships (high_id, status);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  blocked_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reported_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (reason IN ('spam', 'harassment', 'fake_account', 'scam', 'other')),
  details text CHECK (details IS NULL OR char_length(details) <= 500),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reporter_id <> reported_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS reports_one_open_idx ON reports (reporter_id, reported_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS reports_open_idx ON reports (created_at) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS invite_links (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{8}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS referrals (
  invitee_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  inviter_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (invitee_id <> inviter_id)
);
CREATE INDEX IF NOT EXISTS referrals_inviter_idx ON referrals (inviter_id);

-- 1790900130000 CreateGroups -----------------------------------------------------------------
-- Èsúsú groups and the trust that goes with them. Money is never counted here: each round's pot is its
-- own ledger account and each member's deposit sits in their own locked account.
CREATE TABLE IF NOT EXISTS groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  community text CHECK (community IS NULL OR char_length(community) BETWEEN 1 AND 40),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  contribution bigint NOT NULL CHECK (contribution > 0),
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly')),
  size integer NOT NULL CHECK (size BETWEEN 3 AND 30),
  start_date date NOT NULL,
  time_zone text NOT NULL CHECK (char_length(time_zone) <= 40),
  order_method text NOT NULL CHECK (order_method IN ('random', 'pick', 'join_order')),
  visibility text NOT NULL CHECK (visibility IN ('private', 'public')),
  invite_code text NOT NULL UNIQUE CHECK (invite_code ~ '^[A-Z0-9]{8}$'),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'picking', 'running', 'completed', 'cancelled')),
  deposit_base bigint NOT NULL CHECK (deposit_base >= 0),
  deposit_early bigint NOT NULL CHECK (deposit_early >= 0),
  fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 2000),
  late_fee_bps integer NOT NULL CHECK (late_fee_bps BETWEEN 0 AND 2000),
  grace_days integer NOT NULL CHECK (grace_days BETWEEN 0 AND 14),
  pick_deadline timestamptz,
  locked_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 200),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
  request_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS groups_open_public_idx ON groups (start_date) WHERE status = 'open' AND visibility = 'public';
CREATE INDEX IF NOT EXISTS groups_status_idx ON groups (status);
CREATE TABLE IF NOT EXISTS group_members (
  group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  join_seq integer NOT NULL CHECK (join_seq >= 1),
  spot integer CHECK (spot IS NULL OR spot >= 1),
  deposit_required bigint NOT NULL DEFAULT 0 CHECK (deposit_required >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (group_id, user_id),
  UNIQUE (group_id, join_seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS group_members_spot_idx ON group_members (group_id, spot) WHERE spot IS NOT NULL;
CREATE INDEX IF NOT EXISTS group_members_user_idx ON group_members (user_id, status);
CREATE TABLE IF NOT EXISTS group_draws (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('random', 'pick_leftover')),
  seed text NOT NULL CHECK (seed ~ '^[0-9a-f]{64}$'),
  input jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_draws_group_idx ON group_draws (group_id);
CREATE TABLE IF NOT EXISTS group_rounds (
  group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
  round_no integer NOT NULL CHECK (round_no >= 1),
  due_on date NOT NULL,
  recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'paid_out', 'paid_out_short')),
  payout_amount bigint CHECK (payout_amount IS NULL OR payout_amount >= 0),
  fee_amount bigint CHECK (fee_amount IS NULL OR fee_amount >= 0),
  paid_out_at timestamptz,
  PRIMARY KEY (group_id, round_no)
);
CREATE TABLE IF NOT EXISTS group_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
  round_no integer NOT NULL,
  member_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  amount bigint NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'paid', 'late', 'covered', 'missed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  pull_key text CHECK (char_length(pull_key) <= 120),
  topup_intent_id uuid REFERENCES payment_intents (id) ON DELETE RESTRICT,
  ledger_transaction_id uuid REFERENCES ledger_transactions (id),
  paid_at timestamptz,
  note text CHECK (char_length(note) <= 200),
  FOREIGN KEY (group_id, round_no) REFERENCES group_rounds (group_id, round_no),
  UNIQUE (group_id, round_no, member_id)
);
CREATE INDEX IF NOT EXISTS group_contributions_due_idx ON group_contributions (next_attempt_at) WHERE status = 'scheduled';
CREATE TABLE IF NOT EXISTS trust_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('payment_on_time', 'payment_late', 'payment_missed', 'group_completed')),
  group_id uuid REFERENCES groups (id) ON DELETE RESTRICT,
  ref text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, ref)
);
CREATE INDEX IF NOT EXISTS trust_events_user_idx ON trust_events (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS defaulter_blocks (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  blocked_until timestamptz NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) <= 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recovery_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
  member_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  round_no integer NOT NULL,
  amount_owed bigint NOT NULL CHECK (amount_owed >= 0),
  covered_by_deposit bigint NOT NULL CHECK (covered_by_deposit >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'written_off')),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (group_id, round_no, member_id)
);
CREATE INDEX IF NOT EXISTS recovery_cases_open_idx ON recovery_cases (created_at) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS group_swaps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
  from_user uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  to_user uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CHECK (from_user <> to_user)
);
CREATE UNIQUE INDEX IF NOT EXISTS group_swaps_one_pending_idx ON group_swaps (group_id, from_user, to_user) WHERE status = 'pending';

-- 1790900140000 AddKycOverride ---------------------------------------------------------------
-- The owner can approve (or hold back) one person without the identity checks while those checks
-- are pended. Every change is logged by the database itself, however it is made.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS kyc_override text CHECK (kyc_override IN ('approved', 'denied'));
CREATE TABLE IF NOT EXISTS kyc_override_log (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  previous_value text,
  new_value text,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kyc_override_log_user_id_idx ON kyc_override_log (user_id);
CREATE OR REPLACE FUNCTION log_kyc_override() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO kyc_override_log (user_id, previous_value, new_value, changed_by)
  VALUES (NEW.id, OLD.kyc_override, NEW.kyc_override, current_user);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS users_log_kyc_override ON users;
CREATE TRIGGER users_log_kyc_override
  AFTER UPDATE OF kyc_override ON users
  FOR EACH ROW WHEN (OLD.kyc_override IS DISTINCT FROM NEW.kyc_override)
  EXECUTE FUNCTION log_kyc_override();

-- 1790900150000 CustomInviteCodes ------------------------------------------------------------
-- People choose their own invite code (4-20 letters, numbers, - or _, in capitals); each change is
-- kept, which limits how often it changes and holds a given-up code for its owner for 90 days.
ALTER TABLE invite_links DROP CONSTRAINT IF EXISTS invite_links_code_check;
ALTER TABLE invite_links
  ADD CONSTRAINT invite_links_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,18}[A-Z0-9]$');
CREATE TABLE IF NOT EXISTS invite_code_changes (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  old_code text NOT NULL,
  new_code text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invite_code_changes_user_idx ON invite_code_changes (user_id, changed_at);
CREATE INDEX IF NOT EXISTS invite_code_changes_old_code_idx ON invite_code_changes (old_code, changed_at);

-- 1790900160000 AccountSecurity --------------------------------------------------------------
-- A record of what happens to an account (sign-ins, new devices, password, PIN and authenticator
-- changes), and two more reasons a session ends.
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_revoked_reason_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_revoked_reason_check CHECK (revoked_reason IN
  ('logout', 'logout_all', 'refresh_reuse', 'password_reset', 'admin', 'session_limit',
   'password_changed', 'signed_out_by_user'));
CREATE TABLE IF NOT EXISTS security_events (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'signed_in', 'new_device', 'password_changed', 'password_reset', 'pin_changed',
    'pin_reset', 'mfa_on', 'mfa_off', 'recovery_codes_renewed', 'device_signed_out',
    'signed_out_everywhere', 'device_forgotten')),
  device text CHECK (char_length(device) <= 100),
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_user_idx ON security_events (user_id, created_at DESC, id DESC);

-- 1790900170000 ProfileSettings --------------------------------------------------------------
-- A phone number (not verified until SMS checks arrive), which optional emails a person wants, and
-- closing an account. A closed account can't sign in; its records stay (the ledger is never touched).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS phone text UNIQUE CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users
  ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'locked', 'suspended', 'closed'));
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  reminders boolean NOT NULL DEFAULT true,
  savings boolean NOT NULL DEFAULT true,
  circles boolean NOT NULL DEFAULT true,
  friends boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE security_events DROP CONSTRAINT IF EXISTS security_events_kind_check;
ALTER TABLE security_events ADD CONSTRAINT security_events_kind_check CHECK (kind IN (
  'signed_in', 'new_device', 'password_changed', 'password_reset', 'pin_changed',
  'pin_reset', 'mfa_on', 'mfa_off', 'recovery_codes_renewed', 'device_signed_out',
  'signed_out_everywhere', 'device_forgotten', 'phone_changed', 'account_closed'));

-- 1790900180000 ProfilePhoto -----------------------------------------------------------------
-- When a profile picture was last set (null = none). The picture itself is a file in private storage.
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_updated_at timestamptz;

-- 1790900190000 WebPush ----------------------------------------------------------------------
-- Pushes to a phone or browser that asked for them: the browser's own address for us to write to,
-- and a queue on each message, like email's.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE CHECK (char_length(endpoint) <= 2048 AND endpoint LIKE 'https://%'),
  p256dh text NOT NULL CHECK (char_length(p256dh) BETWEEN 1 AND 200),
  auth text NOT NULL CHECK (char_length(auth) BETWEEN 1 AND 100),
  device text CHECK (char_length(device) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS push_status text NOT NULL DEFAULT 'none'
    CHECK (push_status IN ('none', 'pending', 'sent', 'failed')),
  ADD COLUMN IF NOT EXISTS push_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS notifications_push_pending_idx ON notifications (created_at) WHERE push_status = 'pending';

-- 1790900200000 AdminBackOffice --------------------------------------------------------------
-- Staff are a separate set of people from customers, with their own sessions and a mandatory
-- authenticator code. Everything they do is written to admin_audit, which the database refuses to
-- change or empty.
CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE CHECK (char_length(email) <= 254),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  role text NOT NULL CHECK (role IN ('owner', 'support', 'compliance', 'finance')),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  password_hash text,
  totp_secret text,
  totp_confirmed_at timestamptz,
  totp_last_step bigint,
  setup_token_hash text,
  setup_expires_at timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_by uuid REFERENCES admin_users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  ip inet,
  device text CHECK (char_length(device) <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS admin_sessions_admin_idx ON admin_sessions (admin_id);
CREATE TABLE IF NOT EXISTS admin_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  admin_id uuid REFERENCES admin_users (id) ON DELETE RESTRICT,
  admin_email text NOT NULL,
  role text NOT NULL,
  action text NOT NULL CHECK (char_length(action) <= 60),
  target_type text CHECK (char_length(target_type) <= 40),
  target_id text CHECK (char_length(target_id) <= 80),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed'))
);
CREATE INDEX IF NOT EXISTS admin_audit_at_idx ON admin_audit (id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_target_idx ON admin_audit (target_type, target_id, id DESC);
CREATE OR REPLACE FUNCTION admin_audit_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the admin audit log cannot be changed: % is not allowed', TG_OP;
END $$;
DROP TRIGGER IF EXISTS admin_audit_immutable ON admin_audit;
CREATE TRIGGER admin_audit_immutable BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION admin_audit_reject_change();
DROP TRIGGER IF EXISTS admin_audit_no_truncate ON admin_audit;
CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON admin_audit
  FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_reject_change();
CREATE TABLE IF NOT EXISTS recovery_case_notes (
  id bigserial PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES recovery_cases (id) ON DELETE RESTRICT,
  admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS recovery_case_notes_case_idx ON recovery_case_notes (case_id, id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS status_note text CHECK (char_length(status_note) <= 300);

-- 1790900210000 StripePartner ----------------------------------------------------------------
-- Stripe joins Paystack as a payment partner (for the UK).
ALTER TABLE payment_intents DROP CONSTRAINT IF EXISTS payment_intents_provider_check;
ALTER TABLE payment_intents ADD CONSTRAINT payment_intents_provider_check CHECK (provider IN ('paystack', 'stripe', 'fake'));
ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_provider_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_provider_check CHECK (provider IN ('paystack', 'stripe', 'fake'));
ALTER TABLE payout_accounts DROP CONSTRAINT IF EXISTS payout_accounts_provider_check;
ALTER TABLE payout_accounts ADD CONSTRAINT payout_accounts_provider_check CHECK (provider IN ('paystack', 'stripe', 'fake'));
ALTER TABLE mandates DROP CONSTRAINT IF EXISTS mandates_provider_check;
ALTER TABLE mandates ADD CONSTRAINT mandates_provider_check CHECK (provider IN ('paystack', 'stripe', 'fake'));

-- 1790900220000 SiteSettings ----------------------------------------------------------------
-- Settings staff change from the back office without a deploy; the first is the support email.
CREATE TABLE IF NOT EXISTS site_settings (
  key text PRIMARY KEY CHECK (key IN ('support_email')),
  value text NOT NULL CHECK (char_length(value) BETWEEN 3 AND 254),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL
);

-- Tell TypeORM these migrations are done ----------------------------------------------------
-- Same table and columns TypeORM creates itself; skipped for any already recorded.
CREATE TABLE IF NOT EXISTS migrations (
  id serial NOT NULL,
  "timestamp" bigint NOT NULL,
  name character varying NOT NULL,
  CONSTRAINT "PK_8c82d7f526340ab734260ea46be" PRIMARY KEY (id)
);
INSERT INTO migrations ("timestamp", name)
SELECT v.ts, v.name
  FROM (VALUES
    (1790900000000::bigint, 'EnableExtensions1790900000000'),
    (1790900001000::bigint, 'CreateUsers1790900001000'),
    (1790900002000::bigint, 'CreateSessions1790900002000'),
    (1790900010000::bigint, 'CreatePasswordResetTokens1790900010000'),
    (1790900011000::bigint, 'CreateMfa1790900011000'),
    (1790900020000::bigint, 'CreateLedger1790900020000'),
    (1790900030000::bigint, 'CreateOnboarding1790900030000'),
    (1790900040000::bigint, 'AddEmailVerified1790900040000'),
    (1790900041000::bigint, 'AddRetentionSupport1790900041000'),
    (1790900050000::bigint, 'AddUsername1790900050000'),
    (1790900060000::bigint, 'AddLoginDevices1790900060000'),
    (1790900070000::bigint, 'AddTrustedDevices1790900070000'),
    (1790900080000::bigint, 'CreateKycSteps1790900080000'),
    (1790900090000::bigint, 'CreatePayments1790900090000'),
    (1790900100000::bigint, 'CreateNotifications1790900100000'),
    (1790900110000::bigint, 'CreateSavings1790900110000'),
    (1790900120000::bigint, 'CreateFriends1790900120000'),
    (1790900130000::bigint, 'CreateGroups1790900130000'),
    (1790900140000::bigint, 'AddKycOverride1790900140000'),
    (1790900150000::bigint, 'CustomInviteCodes1790900150000'),
    (1790900160000::bigint, 'AccountSecurity1790900160000'),
    (1790900170000::bigint, 'ProfileSettings1790900170000'),
    (1790900180000::bigint, 'ProfilePhoto1790900180000'),
    (1790900190000::bigint, 'WebPush1790900190000'),
    (1790900200000::bigint, 'AdminBackOffice1790900200000'),
    (1790900210000::bigint, 'StripePartner1790900210000'),
    (1790900220000::bigint, 'SiteSettings1790900220000')
  ) AS v (ts, name)
 WHERE NOT EXISTS (SELECT 1 FROM migrations m WHERE m.name = v.name);

COMMIT;

-- Check (shows in the results pane): email_verified must read `boolean`, NO nullable, default false;
-- `username` must be there (citext, nullable); `kyc_override` must be there (text, nullable); and all twenty-seven migrations must be listed.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = current_schema() AND table_name = 'users' AND (column_name LIKE 'email_verified%' OR column_name IN ('username', 'kyc_override'))
 ORDER BY column_name;

SELECT count(*) AS migrations_recorded,
       (SELECT name FROM migrations ORDER BY "timestamp" DESC LIMIT 1) AS latest
  FROM migrations;
