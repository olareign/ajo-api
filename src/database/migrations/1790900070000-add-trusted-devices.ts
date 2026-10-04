import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Devices that have proved themselves with an authenticator code and been told to remember it, so
 * the next sign-in from them skips the code. Trust is a random secret kept in a cookie on the device;
 * only its hash is stored here, so a copy of the database cannot be used to skip anyone's second step.
 */
export class AddTrustedDevices1790900070000 implements MigrationInterface {
  name = "AddTrustedDevices1790900070000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE trusted_devices (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL UNIQUE,
        label text NOT NULL CHECK (char_length(label) <= 100),
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )`);
    await queryRunner.query(`CREATE INDEX trusted_devices_user_idx ON trusted_devices (user_id)`);
    await queryRunner.query(
      `CREATE INDEX trusted_devices_expires_idx ON trusted_devices (expires_at)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE trusted_devices`);
  }
}
