import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The double-entry ledger. The database enforces the rules itself, so they hold even if application
 * code has a bug: amounts are positive whole numbers, an entry's currency is its account's, every
 * transaction balances in each currency at commit, and posted rows can never be changed or removed.
 * Corrections are new, opposite entries.
 */
export class CreateLedger1790900020000 implements MigrationInterface {
  name = "CreateLedger1790900020000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE ledger_accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_type text NOT NULL CHECK (owner_type IN ('user', 'system')),
        owner_id uuid REFERENCES users (id) ON DELETE RESTRICT,
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        kind text NOT NULL CHECK (kind IN
          ('available', 'locked', 'savings', 'pot', 'fees', 'exchange', 'settlement', 'suspense')),
        ref text CHECK (char_length(ref) <= 100),
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((owner_type = 'user') = (owner_id IS NOT NULL))
      )`);
    await q.query(`
      CREATE UNIQUE INDEX ledger_accounts_identity ON ledger_accounts
        (owner_type, (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)), currency, kind, (coalesce(ref, '')))`);

    await q.query(`
      CREATE TABLE ledger_transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        type text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 64),
        idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
        request_hash char(64),
        reference text CHECK (char_length(reference) <= 200),
        reverses uuid UNIQUE REFERENCES ledger_transactions (id),
        reason text CHECK (char_length(reason) <= 500),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE ledger_entries (
        id bigserial PRIMARY KEY,
        transaction_id uuid NOT NULL REFERENCES ledger_transactions (id),
        account_id uuid NOT NULL REFERENCES ledger_accounts (id),
        currency char(3) NOT NULL,
        amount bigint NOT NULL CHECK (amount > 0),
        direction text NOT NULL CHECK (direction IN ('debit', 'credit')),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id)`);
    await q.query(`CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id)`);

    // Posted rows are immutable.
    await q.query(`
      CREATE FUNCTION ledger_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ledger rows are immutable: % on % is not allowed', TG_OP, TG_TABLE_NAME;
      END $$`);
    for (const table of ["ledger_entries", "ledger_transactions"]) {
      await q.query(`CREATE TRIGGER ${table}_immutable BEFORE UPDATE OR DELETE ON ${table}
                     FOR EACH ROW EXECUTE FUNCTION ledger_reject_change()`);
      await q.query(`CREATE TRIGGER ${table}_no_truncate BEFORE TRUNCATE ON ${table}
                     FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_change()`);
    }
    // An account's identity (owner, currency, kind) never changes.
    await q.query(`
      CREATE FUNCTION ledger_account_identity_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.owner_type, NEW.owner_id, NEW.currency, NEW.kind, NEW.ref)
           IS DISTINCT FROM (OLD.owner_type, OLD.owner_id, OLD.currency, OLD.kind, OLD.ref) THEN
          RAISE EXCEPTION 'ledger account identity is immutable';
        END IF;
        RETURN NEW;
      END $$`);
    await q.query(`CREATE TRIGGER ledger_accounts_frozen BEFORE UPDATE ON ledger_accounts
                   FOR EACH ROW EXECUTE FUNCTION ledger_account_identity_frozen()`);

    // An entry's currency is its account's, and entries can only join a transaction created in the
    // same database transaction, so a posted transaction cannot be added to later.
    await q.query(`
      CREATE FUNCTION ledger_check_entry() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END $$`);
    await q.query(`CREATE TRIGGER ledger_entries_check BEFORE INSERT ON ledger_entries
                   FOR EACH ROW EXECUTE FUNCTION ledger_check_entry()`);

    // At commit: at least two entries, and debits equal credits in each currency.
    await q.query(`
      CREATE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
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
      END $$`);
    await q.query(`CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON ledger_entries
                   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced()`);
    await q.query(`CREATE CONSTRAINT TRIGGER ledger_transactions_have_entries AFTER INSERT ON ledger_transactions
                   DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced()`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE ledger_entries`);
    await q.query(`DROP TABLE ledger_transactions`);
    await q.query(`DROP TABLE ledger_accounts`);
    for (const fn of [
      "ledger_reject_change",
      "ledger_account_identity_frozen",
      "ledger_check_entry",
      "ledger_check_balanced",
    ]) {
      await q.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  }
}
