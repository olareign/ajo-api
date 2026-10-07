import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The staff back office. Staff are a separate set of people from customers (their own table, their own
 * sessions, their own sign-in with a mandatory authenticator code), so nothing a customer holds can
 * ever open an admin route. Everything staff do is written to `admin_audit`, which the database itself
 * refuses to change or empty.
 */
export class AdminBackOffice1790900200000 implements MigrationInterface {
  name = "AdminBackOffice1790900200000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE admin_users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email citext NOT NULL UNIQUE CHECK (char_length(email) <= 254),
        display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
        role text NOT NULL CHECK (role IN ('owner', 'support', 'compliance', 'finance')),
        status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
        password_hash text,
        totp_secret text,
        totp_confirmed_at timestamptz,
        totp_last_step bigint,
        setup_token_hash text,
        setup_expires_at timestamptz,
        failed_login_count integer NOT NULL DEFAULT 0,
        locked_until timestamptz,
        last_login_at timestamptz,
        created_by uuid REFERENCES admin_users (id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`
      CREATE TABLE admin_sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        ip inet,
        device text CHECK (char_length(device) <= 100),
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      )`);
    await queryRunner.query(`CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id)`);
    await queryRunner.query(`
      CREATE TABLE admin_audit (
        id bigserial PRIMARY KEY,
        at timestamptz NOT NULL DEFAULT now(),
        admin_id uuid REFERENCES admin_users (id) ON DELETE RESTRICT,
        admin_email text NOT NULL,
        role text NOT NULL,
        action text NOT NULL CHECK (char_length(action) <= 60),
        target_type text CHECK (char_length(target_type) <= 40),
        target_id text CHECK (char_length(target_id) <= 80),
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        ip inet,
        outcome text NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed'))
      )`);
    await queryRunner.query(`CREATE INDEX admin_audit_at_idx ON admin_audit (id DESC)`);
    await queryRunner.query(
      `CREATE INDEX admin_audit_target_idx ON admin_audit (target_type, target_id, id DESC)`,
    );
    await queryRunner.query(`
      CREATE FUNCTION admin_audit_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'the admin audit log cannot be changed: % is not allowed', TG_OP;
      END $$`);
    await queryRunner.query(`
      CREATE TRIGGER admin_audit_immutable BEFORE UPDATE OR DELETE ON admin_audit
        FOR EACH ROW EXECUTE FUNCTION admin_audit_reject_change()`);
    await queryRunner.query(`
      CREATE TRIGGER admin_audit_no_truncate BEFORE TRUNCATE ON admin_audit
        FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_reject_change()`);
    await queryRunner.query(`
      CREATE TABLE recovery_case_notes (
        id bigserial PRIMARY KEY,
        case_id uuid NOT NULL REFERENCES recovery_cases (id) ON DELETE RESTRICT,
        admin_id uuid NOT NULL REFERENCES admin_users (id) ON DELETE RESTRICT,
        note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 1000),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX recovery_case_notes_case_idx ON recovery_case_notes (case_id, id)`,
    );
    await queryRunner.query(`
      ALTER TABLE users ADD COLUMN status_note text CHECK (char_length(status_note) <= 300)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP COLUMN status_note`);
    await queryRunner.query(`DROP TABLE recovery_case_notes`);
    await queryRunner.query(`DROP TRIGGER admin_audit_no_truncate ON admin_audit`);
    await queryRunner.query(`DROP TRIGGER admin_audit_immutable ON admin_audit`);
    await queryRunner.query(`DROP FUNCTION admin_audit_reject_change()`);
    await queryRunner.query(`DROP TABLE admin_audit`);
    await queryRunner.query(`DROP TABLE admin_sessions`);
    await queryRunner.query(`DROP TABLE admin_users`);
  }
}
