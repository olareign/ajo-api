import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A profile photo is a file in private storage under a name made from the person's id; this column is
 * only the moment it was last set (null = no photo), which also versions the picture for caching.
 */
export class ProfilePhoto1790900180000 implements MigrationInterface {
  name = "ProfilePhoto1790900180000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users ADD COLUMN photo_updated_at timestamptz`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP COLUMN photo_updated_at`);
  }
}
