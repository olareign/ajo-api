import type { MigrationInterface, QueryRunner } from "typeorm";

const TABLES = ["payment_intents", "webhook_events", "payout_accounts", "mandates"] as const;

/** Stripe joins Paystack as a payment partner (for the UK), so every table that names the partner accepts it. */
export class StripePartner1790900210000 implements MigrationInterface {
  name = "StripePartner1790900210000";

  async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(`
        ALTER TABLE ${table} DROP CONSTRAINT ${table}_provider_check,
          ADD CONSTRAINT ${table}_provider_check CHECK (provider IN ('paystack', 'stripe', 'fake'))`);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      // Rows from Stripe stay as they are (they record real money). The narrower rule then applies to
      // new rows only: NOT VALID skips checking what is already there.
      const [row] = await queryRunner.query(
        `SELECT count(*)::int AS n FROM ${table} WHERE provider = 'stripe'`,
      );
      await queryRunner.query(`
        ALTER TABLE ${table} DROP CONSTRAINT ${table}_provider_check,
          ADD CONSTRAINT ${table}_provider_check CHECK (provider IN ('paystack', 'fake'))${row.n > 0 ? " NOT VALID" : ""}`);
    }
  }
}
