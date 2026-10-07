import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Pushes to a phone or browser that asked for them. A subscription is the browser's own address for
 * us to write to (it is kept private and removed when the browser says it is gone). Messages are sent
 * from the same queue as emails, so a push waits out an outage and gives up after a few tries.
 */
export class WebPush1790900190000 implements MigrationInterface {
  name = "WebPush1790900190000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE push_subscriptions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        endpoint text NOT NULL UNIQUE CHECK (char_length(endpoint) <= 2048 AND endpoint LIKE 'https://%'),
        p256dh text NOT NULL CHECK (char_length(p256dh) BETWEEN 1 AND 200),
        auth text NOT NULL CHECK (char_length(auth) BETWEEN 1 AND 100),
        device text CHECK (char_length(device) <= 100),
        created_at timestamptz NOT NULL DEFAULT now(),
        last_sent_at timestamptz
      )`);
    await queryRunner.query(
      `CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id)`,
    );
    await queryRunner.query(`
      ALTER TABLE notifications
        ADD COLUMN push_status text NOT NULL DEFAULT 'none'
          CHECK (push_status IN ('none', 'pending', 'sent', 'failed')),
        ADD COLUMN push_attempts integer NOT NULL DEFAULT 0`);
    await queryRunner.query(
      `CREATE INDEX notifications_push_pending_idx ON notifications (created_at) WHERE push_status = 'pending'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX notifications_push_pending_idx`);
    await queryRunner.query(
      `ALTER TABLE notifications DROP COLUMN push_status, DROP COLUMN push_attempts`,
    );
    await queryRunner.query(`DROP TABLE push_subscriptions`);
  }
}
