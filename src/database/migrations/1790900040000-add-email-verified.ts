import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * An explicit `email_verified` flag beside the `email_verified_at` timestamp: the flag is what
 * queries and sign-in check, the timestamp says when. A constraint keeps the two in agreement.
 *
 * Safe to run before the new code is deployed: the trigger sets the flag when older code
 * writes only the timestamp, so a person verifying during a deploy is not refused.
 */
export class AddEmailVerified1790900040000 implements MigrationInterface {
  name = "AddEmailVerified1790900040000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `UPDATE users SET email_verified = true WHERE email_verified_at IS NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE users ADD CONSTRAINT users_email_verified_matches_timestamp
        CHECK (email_verified = (email_verified_at IS NOT NULL))`);
    await queryRunner.query(`
      CREATE FUNCTION users_flag_email_verified() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.email_verified_at IS NULL AND NEW.email_verified_at IS NOT NULL THEN
          NEW.email_verified := true;
        END IF;
        RETURN NEW;
      END $$`);
    await queryRunner.query(`
      CREATE TRIGGER users_flag_email_verified BEFORE UPDATE OF email_verified_at ON users
        FOR EACH ROW EXECUTE FUNCTION users_flag_email_verified()`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TRIGGER users_flag_email_verified ON users`);
    await queryRunner.query(`DROP FUNCTION users_flag_email_verified()`);
    await queryRunner.query(
      `ALTER TABLE users DROP CONSTRAINT users_email_verified_matches_timestamp`,
    );
    await queryRunner.query(`ALTER TABLE users DROP COLUMN email_verified`);
  }
}
