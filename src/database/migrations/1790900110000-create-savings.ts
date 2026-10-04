import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Solo saving plans. A plan's money lives in its own ledger account (kind `savings`, ref
 * `plan:<id>`), so what is saved is always read from the ledger, never from a counter that could
 * drift. A plan has one row per scheduled debit, made when the plan is created; `UNIQUE (plan_id, seq)`
 * and the ledger's idempotency key (`savings-debit:<debit id>`) are what make a debit happen once.
 */
export class CreateSavings1790900110000 implements MigrationInterface {
  name = "CreateSavings1790900110000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE savings_plans (
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
      )`);
    await q.query(
      `CREATE INDEX savings_plans_user_idx ON savings_plans (user_id, created_at DESC)`,
    );

    await q.query(`
      CREATE TABLE savings_debits (
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
      )`);
    await q.query(
      `CREATE INDEX savings_debits_due_idx ON savings_debits (next_attempt_at) WHERE status = 'scheduled'`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE savings_debits`);
    await q.query(`DROP TABLE savings_plans`);
  }
}
