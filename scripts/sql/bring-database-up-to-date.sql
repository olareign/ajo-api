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
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_revoked_reason_check,
  ADD CONSTRAINT sessions_revoked_reason_check CHECK (revoked_reason IN
    ('logout', 'logout_all', 'refresh_reuse', 'password_reset', 'admin', 'session_limit'));
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
    (1790900090000::bigint, 'CreatePayments1790900090000')
  ) AS v (ts, name)
 WHERE NOT EXISTS (SELECT 1 FROM migrations m WHERE m.name = v.name);

COMMIT;

-- Check (shows in the results pane): email_verified must read `boolean`, NO nullable, default false;
-- `username` must be there (citext, nullable); and all fourteen migrations must be listed.
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = current_schema() AND table_name = 'users' AND (column_name LIKE 'email_verified%' OR column_name = 'username')
 ORDER BY column_name;

SELECT count(*) AS migrations_recorded,
       (SELECT name FROM migrations ORDER BY "timestamp" DESC LIMIT 1) AS latest
  FROM migrations;
