import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Èsúsú groups and the trust that goes with them. Money is never counted here: each round's pot is its
 * own ledger account (`pot`, ref `group:<id>:r<n>`) and each member's deposit sits in their own
 * `locked` account (ref `group:<id>:deposit`), so what is held is read from the ledger.
 * `UNIQUE (group_id, spot)` is what lets only one member take a spot, however many pick at once, and
 * `UNIQUE (group_id, round_no, member_id)` is what makes a member's contribution happen once.
 */
export class CreateGroups1790900130000 implements MigrationInterface {
  name = "CreateGroups1790900130000";

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        creator_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
        community text CHECK (community IS NULL OR char_length(community) BETWEEN 1 AND 40),
        currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        contribution bigint NOT NULL CHECK (contribution > 0),
        frequency text NOT NULL CHECK (frequency IN ('weekly', 'biweekly', 'monthly')),
        size integer NOT NULL CHECK (size BETWEEN 3 AND 30),
        start_date date NOT NULL,
        time_zone text NOT NULL CHECK (char_length(time_zone) <= 40),
        order_method text NOT NULL CHECK (order_method IN ('random', 'pick', 'join_order')),
        visibility text NOT NULL CHECK (visibility IN ('private', 'public')),
        invite_code text NOT NULL UNIQUE CHECK (invite_code ~ '^[A-Z0-9]{8}$'),
        status text NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'picking', 'running', 'completed', 'cancelled')),
        deposit_base bigint NOT NULL CHECK (deposit_base >= 0),
        deposit_early bigint NOT NULL CHECK (deposit_early >= 0),
        fee_bps integer NOT NULL CHECK (fee_bps BETWEEN 0 AND 2000),
        late_fee_bps integer NOT NULL CHECK (late_fee_bps BETWEEN 0 AND 2000),
        grace_days integer NOT NULL CHECK (grace_days BETWEEN 0 AND 14),
        pick_deadline timestamptz,
        locked_at timestamptz,
        completed_at timestamptz,
        cancelled_at timestamptz,
        cancel_reason text CHECK (cancel_reason IS NULL OR char_length(cancel_reason) <= 200),
        idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 100),
        request_hash char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (creator_id, idempotency_key)
      )`);
    await q.query(
      `CREATE INDEX groups_open_public_idx ON groups (start_date) WHERE status = 'open' AND visibility = 'public'`,
    );
    await q.query(`CREATE INDEX groups_status_idx ON groups (status)`);

    await q.query(`
      CREATE TABLE group_members (
        group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        join_seq integer NOT NULL CHECK (join_seq >= 1),
        spot integer CHECK (spot IS NULL OR spot >= 1),
        deposit_required bigint NOT NULL DEFAULT 0 CHECK (deposit_required >= 0),
        status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
        joined_at timestamptz NOT NULL DEFAULT now(),
        left_at timestamptz,
        PRIMARY KEY (group_id, user_id),
        UNIQUE (group_id, join_seq)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX group_members_spot_idx ON group_members (group_id, spot) WHERE spot IS NOT NULL`,
    );
    await q.query(`CREATE INDEX group_members_user_idx ON group_members (user_id, status)`);

    await q.query(`
      CREATE TABLE group_draws (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
        kind text NOT NULL CHECK (kind IN ('random', 'pick_leftover')),
        seed text NOT NULL CHECK (seed ~ '^[0-9a-f]{64}$'),
        input jsonb NOT NULL,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX group_draws_group_idx ON group_draws (group_id)`);

    await q.query(`
      CREATE TABLE group_rounds (
        group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
        round_no integer NOT NULL CHECK (round_no >= 1),
        due_on date NOT NULL,
        recipient_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        status text NOT NULL DEFAULT 'scheduled'
          CHECK (status IN ('scheduled', 'paid_out', 'paid_out_short')),
        payout_amount bigint CHECK (payout_amount IS NULL OR payout_amount >= 0),
        fee_amount bigint CHECK (fee_amount IS NULL OR fee_amount >= 0),
        paid_out_at timestamptz,
        PRIMARY KEY (group_id, round_no)
      )`);

    await q.query(`
      CREATE TABLE group_contributions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
        round_no integer NOT NULL,
        member_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        amount bigint NOT NULL CHECK (amount > 0),
        status text NOT NULL DEFAULT 'scheduled'
          CHECK (status IN ('scheduled', 'paid', 'late', 'covered', 'missed')),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL,
        pull_key text CHECK (char_length(pull_key) <= 120),
        topup_intent_id uuid REFERENCES payment_intents (id) ON DELETE RESTRICT,
        ledger_transaction_id uuid REFERENCES ledger_transactions (id),
        paid_at timestamptz,
        note text CHECK (char_length(note) <= 200),
        FOREIGN KEY (group_id, round_no) REFERENCES group_rounds (group_id, round_no),
        UNIQUE (group_id, round_no, member_id)
      )`);
    await q.query(
      `CREATE INDEX group_contributions_due_idx ON group_contributions (next_attempt_at) WHERE status = 'scheduled'`,
    );

    await q.query(`
      CREATE TABLE trust_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        kind text NOT NULL CHECK (kind IN ('payment_on_time', 'payment_late', 'payment_missed', 'group_completed')),
        group_id uuid REFERENCES groups (id) ON DELETE RESTRICT,
        ref text NOT NULL CHECK (char_length(ref) BETWEEN 1 AND 120),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (user_id, ref)
      )`);
    await q.query(`CREATE INDEX trust_events_user_idx ON trust_events (user_id, created_at DESC)`);

    await q.query(`
      CREATE TABLE defaulter_blocks (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
        blocked_until timestamptz NOT NULL,
        reason text NOT NULL CHECK (char_length(reason) <= 200),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE recovery_cases (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
        member_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        round_no integer NOT NULL,
        amount_owed bigint NOT NULL CHECK (amount_owed >= 0),
        covered_by_deposit bigint NOT NULL CHECK (covered_by_deposit >= 0),
        status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'written_off')),
        notes text CHECK (notes IS NULL OR char_length(notes) <= 1000),
        created_at timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz,
        UNIQUE (group_id, round_no, member_id)
      )`);
    await q.query(
      `CREATE INDEX recovery_cases_open_idx ON recovery_cases (created_at) WHERE status = 'open'`,
    );

    await q.query(`
      CREATE TABLE group_swaps (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        group_id uuid NOT NULL REFERENCES groups (id) ON DELETE RESTRICT,
        from_user uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        to_user uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
        created_at timestamptz NOT NULL DEFAULT now(),
        responded_at timestamptz,
        CHECK (from_user <> to_user)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX group_swaps_one_pending_idx ON group_swaps (group_id, from_user, to_user) WHERE status = 'pending'`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    for (const t of [
      "group_swaps",
      "recovery_cases",
      "defaulter_blocks",
      "trust_events",
      "group_contributions",
      "group_rounds",
      "group_draws",
      "group_members",
      "groups",
    ]) {
      await q.query(`DROP TABLE ${t}`);
    }
  }
}
