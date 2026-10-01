import type { MigrationInterface, QueryRunner } from "typeorm";

/** Users (email sign-in) and single-use email verification tokens, stored as hashes. */
export class CreateUsers1790900001000 implements MigrationInterface {
  name = "CreateUsers1790900001000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email citext NOT NULL UNIQUE CHECK (char_length(email) <= 254),
        email_verified_at timestamptz,
        password_hash text NOT NULL,
        display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'suspended')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      CREATE TABLE email_verification_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX email_verification_tokens_user_id_idx ON email_verification_tokens (user_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE email_verification_tokens`);
    await queryRunner.query(`DROP TABLE users`);
  }
}
