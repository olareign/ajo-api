import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Extensions the schema relies on: pgcrypto (gen_random_uuid, digests) and citext
 * (case-insensitive emails for sign-in). PostGIS is added in Phase 3 with discovery.
 */
export class EnableExtensions1790900000000 implements MigrationInterface {
  name = "EnableExtensions1790900000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP EXTENSION IF EXISTS citext`);
    await queryRunner.query(`DROP EXTENSION IF EXISTS pgcrypto`);
  }
}
