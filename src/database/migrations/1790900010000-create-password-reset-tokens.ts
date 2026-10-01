import type { MigrationInterface, QueryRunner } from "typeorm";

/** Single-use password reset links; like every token here, only a hash is stored. */
export class CreatePasswordResetTokens1790900010000 implements MigrationInterface {
  name = "CreatePasswordResetTokens1790900010000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE password_reset_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE password_reset_tokens`);
  }
}
