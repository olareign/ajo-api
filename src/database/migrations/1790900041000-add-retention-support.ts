import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Supports clearing out old sessions and tokens: indexes on the columns the purge filters by (so
 * it never scans a whole table), and a revoke reason for sessions ended by the per-person limit.
 */
export class AddRetentionSupport1790900041000 implements MigrationInterface {
  name = "AddRetentionSupport1790900041000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check,
        ADD CONSTRAINT sessions_revoked_reason_check CHECK (revoked_reason IN
          ('logout', 'logout_all', 'refresh_reuse', 'password_reset', 'admin', 'session_limit'))`);
    await queryRunner.query(`CREATE INDEX sessions_expires_at_idx ON sessions (expires_at)`);
    await queryRunner.query(
      `CREATE INDEX sessions_revoked_at_idx ON sessions (revoked_at) WHERE revoked_at IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX email_verification_tokens_expires_at_idx ON email_verification_tokens (expires_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX password_reset_tokens_expires_at_idx ON password_reset_tokens (expires_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX mfa_challenges_expires_at_idx ON mfa_challenges (expires_at)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX mfa_challenges_expires_at_idx`);
    await queryRunner.query(`DROP INDEX password_reset_tokens_expires_at_idx`);
    await queryRunner.query(`DROP INDEX email_verification_tokens_expires_at_idx`);
    await queryRunner.query(`DROP INDEX refresh_tokens_expires_at_idx`);
    await queryRunner.query(`DROP INDEX sessions_revoked_at_idx`);
    await queryRunner.query(`DROP INDEX sessions_expires_at_idx`);
    await queryRunner.query(`
      UPDATE sessions SET revoked_reason = 'logout_all' WHERE revoked_reason = 'session_limit'`);
    await queryRunner.query(`
      ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check,
        ADD CONSTRAINT sessions_revoked_reason_check CHECK (revoked_reason IN
          ('logout', 'logout_all', 'refresh_reuse', 'password_reset', 'admin'))`);
  }
}
