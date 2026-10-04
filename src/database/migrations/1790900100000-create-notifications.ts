import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Messages to a person: shown in the app, and optionally emailed. `dedupe_key` makes sending the
 * same message twice a no-op (a retried job must not tell someone twice), and the email goes out
 * from this table by a scheduled task, so a mail outage delays an email and never loses it.
 */
export class CreateNotifications1790900100000 implements MigrationInterface {
  name = "CreateNotifications1790900100000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        seq bigint GENERATED ALWAYS AS IDENTITY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        kind text NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 64),
        title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
        body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
        link text CHECK (link IS NULL OR (char_length(link) <= 200 AND link LIKE '/%')),
        dedupe_key text NOT NULL CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
        email_status text NOT NULL DEFAULT 'none' CHECK (email_status IN ('none', 'pending', 'sent', 'failed')),
        email_attempts integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        read_at timestamptz,
        UNIQUE (user_id, dedupe_key)
      )`);
    await q.query(`CREATE INDEX notifications_user_idx ON notifications (user_id, seq DESC)`);
    await q.query(
      `CREATE INDEX notifications_email_pending_idx ON notifications (created_at) WHERE email_status = 'pending'`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE notifications`);
  }
}
