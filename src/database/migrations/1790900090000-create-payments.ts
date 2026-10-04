import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Money moving through payment partners. Every rule that protects money is in the database as well
 * as in the code, so a bug cannot break it: one open mandate per person, one intent per idempotency
 * key, one provider event stored once, and no person row can be deleted while money records exist.
 *
 * - payment_intents: one row per attempt to add or withdraw money. Its status moves one way.
 * - webhook_events: the inbox. Every signed event from a partner is stored once, before it is acted on.
 * - payout_accounts: where a person's withdrawals go. The partner's recipient code is kept, never the
 *   full account number.
 * - mandates: a person's standing permission to collect money (auto-debit).
 */
export class CreatePayments1790900090000 implements MigrationInterface {
  name = "CreatePayments1790900090000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE payment_intents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        kind text NOT NULL CHECK (kind IN ('funding', 'withdrawal')),
        provider text NOT NULL CHECK (provider IN ('paystack', 'gocardless', 'fake')),
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
      )`);
    await q.query(
      `CREATE INDEX payment_intents_user_idx ON payment_intents (user_id, created_at DESC)`,
    );
    await q.query(
      `CREATE INDEX payment_intents_provider_id_idx ON payment_intents (provider, provider_id)
         WHERE provider_id IS NOT NULL`,
    );
    await q.query(
      `CREATE INDEX payment_intents_pending_idx ON payment_intents (updated_at)
         WHERE status IN ('created', 'pending')`,
    );

    await q.query(`
      CREATE TABLE webhook_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        provider text NOT NULL CHECK (provider IN ('paystack', 'gocardless', 'fake')),
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
      )`);
    await q.query(
      `CREATE INDEX webhook_events_open_idx ON webhook_events (received_at)
         WHERE status IN ('received', 'failed')`,
    );

    await q.query(`
      CREATE TABLE payout_accounts (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
        provider text NOT NULL CHECK (provider IN ('paystack', 'gocardless', 'fake')),
        bank_code text NOT NULL CHECK (char_length(bank_code) BETWEEN 2 AND 20),
        bank_name text NOT NULL CHECK (char_length(bank_name) <= 100),
        last4 char(4) NOT NULL CHECK (last4 ~ '^[0-9]{4}$'),
        account_name text NOT NULL CHECK (char_length(account_name) <= 200),
        recipient_code text NOT NULL CHECK (char_length(recipient_code) <= 100),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE mandates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        provider text NOT NULL CHECK (provider IN ('paystack', 'gocardless', 'fake')),
        status text NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'failed')),
        reference text NOT NULL UNIQUE CHECK (char_length(reference) BETWEEN 16 AND 50),
        provider_id text CHECK (char_length(provider_id) <= 200),
        provider_mandate_id text CHECK (char_length(provider_mandate_id) <= 200),
        authorization_code text CHECK (char_length(authorization_code) <= 200),
        action jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        cancelled_at timestamptz
      )`);
    // However many requests arrive at once, a person has at most one mandate that is not finished.
    await q.query(
      `CREATE UNIQUE INDEX mandates_one_open_per_user ON mandates (user_id)
         WHERE status IN ('pending', 'active')`,
    );
    await q.query(
      `CREATE INDEX mandates_provider_idx ON mandates (provider, provider_id) WHERE provider_id IS NOT NULL`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE mandates`);
    await q.query(`DROP TABLE payout_accounts`);
    await q.query(`DROP TABLE webhook_events`);
    await q.query(`DROP TABLE payment_intents`);
  }
}
