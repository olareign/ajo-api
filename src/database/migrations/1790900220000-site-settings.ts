import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Settings staff change from the back office without a deploy. Each key is listed in the CHECK, so a
 * new one is a deliberate migration, never something a request can invent. The first is the
 * support email shown on Help and the legal pages.
 */
export class SiteSettings1790900220000 implements MigrationInterface {
  name = "SiteSettings1790900220000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE site_settings (
        key text PRIMARY KEY CHECK (key IN ('support_email')),
        value text NOT NULL CHECK (char_length(value) BETWEEN 3 AND 254),
        updated_at timestamptz NOT NULL DEFAULT now(),
        updated_by uuid REFERENCES admin_users (id) ON DELETE SET NULL
      )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE site_settings`);
  }
}
