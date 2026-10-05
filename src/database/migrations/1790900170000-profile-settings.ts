import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * More of the profile: a phone number (not verified until SMS checks arrive), which optional emails a
 * person wants, and closing an account. A closed account can't sign in; its records stay as the law
 * requires (the ledger is never touched).
 */
export class ProfileSettings1790900170000 implements MigrationInterface {
  name = "ProfileSettings1790900170000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN phone text UNIQUE CHECK (phone ~ '^\\+[1-9][0-9]{7,14}$'),
        ADD COLUMN phone_verified_at timestamptz,
        ADD COLUMN closed_at timestamptz`);
    await queryRunner.query(`
      ALTER TABLE users DROP CONSTRAINT users_status_check,
        ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'locked', 'suspended', 'closed'))`);
    await queryRunner.query(`
      CREATE TABLE notification_settings (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        reminders boolean NOT NULL DEFAULT true,
        savings boolean NOT NULL DEFAULT true,
        circles boolean NOT NULL DEFAULT true,
        friends boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      ALTER TABLE security_events DROP CONSTRAINT security_events_kind_check,
        ADD CONSTRAINT security_events_kind_check CHECK (kind IN (
          'signed_in', 'new_device', 'password_changed', 'password_reset', 'pin_changed',
          'pin_reset', 'mfa_on', 'mfa_off', 'recovery_codes_renewed', 'device_signed_out',
          'signed_out_everywhere', 'device_forgotten', 'phone_changed', 'account_closed'))`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM security_events WHERE kind IN ('phone_changed', 'account_closed')`,
    );
    await queryRunner.query(`
      ALTER TABLE security_events DROP CONSTRAINT security_events_kind_check,
        ADD CONSTRAINT security_events_kind_check CHECK (kind IN (
          'signed_in', 'new_device', 'password_changed', 'password_reset', 'pin_changed',
          'pin_reset', 'mfa_on', 'mfa_off', 'recovery_codes_renewed', 'device_signed_out',
          'signed_out_everywhere', 'device_forgotten'))`);
    await queryRunner.query(`DROP TABLE notification_settings`);
    // A closed account comes back as suspended: still unable to sign in.
    await queryRunner.query(`UPDATE users SET status = 'suspended' WHERE status = 'closed'`);
    await queryRunner.query(`
      ALTER TABLE users DROP CONSTRAINT users_status_check,
        ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'locked', 'suspended'))`);
    await queryRunner.query(
      `ALTER TABLE users DROP COLUMN phone, DROP COLUMN phone_verified_at, DROP COLUMN closed_at`,
    );
  }
}
