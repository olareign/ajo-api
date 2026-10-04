import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lets the owner approve (or hold back) one person without the identity checks, while those checks
 * are pended: `users.kyc_override`. Every change is written to `kyc_override_log` by the database
 * itself, however it is made (the command, the SQL editor, anything), with who made it.
 */
export class AddKycOverride1790900120000 implements MigrationInterface {
  name = "AddKycOverride1790900120000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN kyc_override text CHECK (kyc_override IN ('approved', 'denied'))`);
    await queryRunner.query(`
      CREATE TABLE kyc_override_log (
        id bigserial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        previous_value text,
        new_value text,
        changed_by text NOT NULL,
        changed_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX kyc_override_log_user_id_idx ON kyc_override_log (user_id)`,
    );
    await queryRunner.query(`
      CREATE FUNCTION log_kyc_override() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO kyc_override_log (user_id, previous_value, new_value, changed_by)
        VALUES (NEW.id, OLD.kyc_override, NEW.kyc_override, current_user);
        RETURN NULL;
      END $$`);
    await queryRunner.query(`
      CREATE TRIGGER users_log_kyc_override
        AFTER UPDATE OF kyc_override ON users
        FOR EACH ROW WHEN (OLD.kyc_override IS DISTINCT FROM NEW.kyc_override)
        EXECUTE FUNCTION log_kyc_override()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER users_log_kyc_override ON users`);
    await queryRunner.query(`DROP FUNCTION log_kyc_override()`);
    await queryRunner.query(`DROP TABLE kyc_override_log`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN kyc_override`);
  }
}
