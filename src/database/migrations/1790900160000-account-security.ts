import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Account security from Me: a record of what happened to the account (sign-ins, new devices,
 * password, PIN and authenticator changes, devices signed out) for the person to look over (it goes
 * with the account, like the other personal records), and two
 * more reasons a session can end (the password was changed; the person signed that device out).
 */
export class AccountSecurity1790900160000 implements MigrationInterface {
  name = "AccountSecurity1790900160000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check,
        ADD CONSTRAINT sessions_revoked_reason_check CHECK (revoked_reason IN
          ('logout', 'logout_all', 'refresh_reuse', 'password_reset', 'admin', 'session_limit',
           'password_changed', 'signed_out_by_user'))`);
    await queryRunner.query(`
      CREATE TABLE security_events (
        id bigserial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN (
          'signed_in', 'new_device', 'password_changed', 'password_reset', 'pin_changed',
          'pin_reset', 'mfa_on', 'mfa_off', 'recovery_codes_renewed', 'device_signed_out',
          'signed_out_everywhere', 'device_forgotten')),
        device text CHECK (char_length(device) <= 100),
        ip inet,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX security_events_user_idx ON security_events (user_id, created_at DESC, id DESC)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE security_events`);
    // Sessions that ended for the new reasons are recorded under the nearest old one.
    await queryRunner.query(`
      UPDATE sessions SET revoked_reason = CASE revoked_reason
        WHEN 'password_changed' THEN 'password_reset' ELSE 'logout' END
       WHERE revoked_reason IN ('password_changed', 'signed_out_by_user')`);
    await queryRunner.query(`
      ALTER TABLE sessions DROP CONSTRAINT sessions_revoked_reason_check,
        ADD CONSTRAINT sessions_revoked_reason_check CHECK (revoked_reason IN
          ('logout', 'logout_all', 'refresh_reuse', 'password_reset', 'admin', 'session_limit'))`);
  }
}
