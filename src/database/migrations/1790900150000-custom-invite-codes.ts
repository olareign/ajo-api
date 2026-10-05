import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * People can choose their own invite code. Codes grow from 8 fixed characters to 4-20 letters,
 * numbers, - or _ (stored in capitals). Every change is kept in invite_code_changes: it limits how
 * often a code can change, and stops a code someone gave up from being claimed by anyone else for a
 * while, so links still going round never start pointing at a stranger.
 */
export class CustomInviteCodes1790900150000 implements MigrationInterface {
  name = "CustomInviteCodes1790900150000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE invite_links DROP CONSTRAINT invite_links_code_check`);
    await queryRunner.query(`
      ALTER TABLE invite_links
        ADD CONSTRAINT invite_links_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{2,18}[A-Z0-9]$')`);
    await queryRunner.query(`
      CREATE TABLE invite_code_changes (
        id bigserial PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        old_code text NOT NULL,
        new_code text NOT NULL,
        changed_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX invite_code_changes_user_idx ON invite_code_changes (user_id, changed_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX invite_code_changes_old_code_idx ON invite_code_changes (old_code, changed_at)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE invite_code_changes`);
    await queryRunner.query(`ALTER TABLE invite_links DROP CONSTRAINT invite_links_code_check`);
    // Chosen codes don't fit the old shape: they get a made-up one (8 capitals and digits) again.
    await queryRunner.query(`
      UPDATE invite_links SET code = upper(substr(md5(random()::text || user_id::text), 1, 8))
       WHERE code !~ '^[A-Z0-9]{8}$'`);
    await queryRunner.query(
      `ALTER TABLE invite_links ADD CONSTRAINT invite_links_code_check CHECK (code ~ '^[A-Z0-9]{8}$')`,
    );
  }
}
