import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Authenticator-app second factor: one secret per user (stored encrypted; the CHECK makes the
 * database refuse a plain-text value), single-use recovery codes (hashes only), and short-lived
 * challenges that carry a password-verified sign-in to its second step.
 */
export class CreateMfa1790900011000 implements MigrationInterface {
  name = "CreateMfa1790900011000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE user_mfa (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        totp_secret text NOT NULL CHECK (left(totp_secret, 3) = 'v1.'),
        confirmed_at timestamptz,
        last_used_step bigint,
        failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        locked_until timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      CREATE TABLE mfa_recovery_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        code_hash char(64) NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, code_hash)
      )`);
    await queryRunner.query(`
      CREATE TABLE mfa_challenges (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX mfa_challenges_user_id_idx ON mfa_challenges (user_id)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE mfa_challenges`);
    await queryRunner.query(`DROP TABLE mfa_recovery_codes`);
    await queryRunner.query(`DROP TABLE user_mfa`);
  }
}
