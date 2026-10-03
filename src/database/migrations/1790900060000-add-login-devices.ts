import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The kinds of device each person has signed in from (browser and system, never a fingerprint), so a
 * sign-in from a kind they have not used before can be pointed out to them by email. `alerted_at`
 * lets the number of alerts in a day be capped.
 */
export class AddLoginDevices1790900060000 implements MigrationInterface {
  name = "AddLoginDevices1790900060000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE login_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        device_key char(64) NOT NULL,
        label text NOT NULL CHECK (char_length(label) <= 100),
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        last_ip inet,
        alerted_at timestamptz,
        UNIQUE (user_id, device_key)
      )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE login_devices`);
  }
}
