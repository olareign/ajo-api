import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Friends. A friendship is one row for a pair of people, stored low id first, so two people can never
 * have two rows however their requests cross (`UNIQUE (low_id, high_id)` is what makes simultaneous
 * requests in opposite directions end as one friendship). Declining, cancelling and removing delete
 * the row. Blocks, reports and invite links sit beside it.
 */
export class CreateFriends1790900120000 implements MigrationInterface {
  name = "CreateFriends1790900120000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE friendships (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        low_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        high_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        requester_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
        created_at timestamptz NOT NULL DEFAULT now(),
        responded_at timestamptz,
        CHECK (low_id < high_id),
        CHECK (requester_id IN (low_id, high_id)),
        UNIQUE (low_id, high_id)
      )`);
    await q.query(`CREATE INDEX friendships_low_idx ON friendships (low_id, status)`);
    await q.query(`CREATE INDEX friendships_high_idx ON friendships (high_id, status)`);

    await q.query(`
      CREATE TABLE blocks (
        blocker_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        blocked_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (blocker_id, blocked_id),
        CHECK (blocker_id <> blocked_id)
      )`);
    await q.query(`CREATE INDEX blocks_blocked_idx ON blocks (blocked_id)`);

    await q.query(`
      CREATE TABLE reports (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        reporter_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        reported_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        reason text NOT NULL CHECK (reason IN ('spam', 'harassment', 'fake_account', 'scam', 'other')),
        details text CHECK (details IS NULL OR char_length(details) <= 500),
        status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (reporter_id <> reported_id)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX reports_one_open_idx ON reports (reporter_id, reported_id) WHERE status = 'open'`,
    );
    await q.query(`CREATE INDEX reports_open_idx ON reports (created_at) WHERE status = 'open'`);

    await q.query(`
      CREATE TABLE invite_links (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
        code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{8}$'),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE referrals (
        invitee_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
        inviter_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (invitee_id <> inviter_id)
      )`);
    await q.query(`CREATE INDEX referrals_inviter_idx ON referrals (inviter_id)`);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const table of ["referrals", "invite_links", "reports", "blocks", "friendships"]) {
      await q.query(`DROP TABLE ${table}`);
    }
  }
}
