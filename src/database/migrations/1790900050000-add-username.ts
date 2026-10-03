import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A public handle for each person (friends will find each other by it). Case-insensitive and unique
 * (citext), and the database itself refuses anything that is not three to twenty lowercase letters,
 * digits or underscores starting with a letter, so the rule holds even if application code is wrong.
 * Empty until the person chooses one during onboarding.
 */
export class AddUsername1790900050000 implements MigrationInterface {
  name = "AddUsername1790900050000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN username citext,
        ADD CONSTRAINT users_username_key UNIQUE (username),
        ADD CONSTRAINT users_username_format CHECK (username::text ~ '^[a-z][a-z0-9_]{2,19}$')`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        DROP CONSTRAINT users_username_format,
        DROP CONSTRAINT users_username_key,
        DROP COLUMN username`);
  }
}
