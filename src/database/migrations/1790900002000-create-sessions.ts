import type { MigrationInterface, QueryRunner } from "typeorm";

/** Login lockout fields, sessions, and rotating refresh tokens (stored as hashes). */
export class CreateSessions1790900002000 implements MigrationInterface {
  name = "CreateSessions1790900002000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
        ADD COLUMN locked_until timestamptz`);
    await queryRunner.query(`
      CREATE TABLE sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        revoked_reason text CHECK (revoked_reason IN ('logout', 'logout_all', 'refresh_reuse', 'password_reset', 'admin')),
        ip inet,
        user_agent text CHECK (char_length(user_agent) <= 512)
      )`);
    await queryRunner.query(`CREATE INDEX sessions_user_id_idx ON sessions (user_id)`);
    await queryRunner.query(`
      CREATE TABLE refresh_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX refresh_tokens_session_id_idx ON refresh_tokens (session_id)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE refresh_tokens`);
    await queryRunner.query(`DROP TABLE sessions`);
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN locked_until, DROP COLUMN failed_login_count`,
    );
  }
}
