import type { MigrationInterface, QueryRunner } from "typeorm";

/** Where the user is (decides the currency and rules) and what they came for; plus the transaction PIN. */
export class CreateOnboarding1790900030000 implements MigrationInterface {
  name = "CreateOnboarding1790900030000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN country char(2) CHECK (country IN ('NG', 'GB')),
        ADD COLUMN goal text CHECK (goal IN ('solo', 'circle', 'both'))`);
    await queryRunner.query(`
      CREATE TABLE transaction_pins (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        pin_hash text NOT NULL,
        failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        locked_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE transaction_pins`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN goal, DROP COLUMN country`);
  }
}
