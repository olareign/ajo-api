import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { Notifications } from "../notifications/notifications.service.js";
import { coded } from "../payments/payment-intents.js";
import {
  assertNotBlocked,
  lockPair,
  lockPeople,
  reachable,
  type Person,
  type Tx,
} from "./people.js";

export const MAX_OUTGOING_REQUESTS = 50;
export const MAX_FRIENDS = 500;

export type Relation = "none" | "friend" | "requested" | "incoming";

type FriendshipRow = {
  id: string;
  requester_id: string;
  status: "pending" | "accepted";
};

export type FriendRow = {
  id: string;
  username: string;
  display_name: string;
  since: Date;
  national: boolean;
};

export type RequestRow = {
  username: string;
  display_name: string;
  created_at: Date;
  national: boolean;
};

const NATIONAL = `EXISTS (SELECT 1 FROM kyc_steps ns WHERE ns.user_id = u.id AND ns.step = 'national_check' AND ns.status = 'approved')`;

/**
 * Friend requests and friendships. Everything that happens between two people is done under a lock on
 * that pair, so a request each way at the same moment, or accepting twice, ends in exactly one
 * friendship and no duplicates.
 */
@Injectable()
export class Friends {
  constructor(
    private readonly db: DataSource,
    private readonly notifications: Notifications,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Asks someone to be friends. Asking twice changes nothing. If they had already asked you, this
   * accepts theirs instead, so two people reaching for each other become friends rather than a stalemate.
   */
  async request(me: string, username: string): Promise<{ relation: Relation }> {
    return this.db.transaction(async (tx) => {
      const them = await reachable(tx, me, username, this.env.KYC_AUTO_APPROVE);
      const { low, high } = await lockPair(tx, me, them.id);
      await assertNotBlocked(tx, me, them.id);
      const [existing] = await sql<FriendshipRow>(
        tx,
        `SELECT id, requester_id, status FROM friendships WHERE low_id = $1 AND high_id = $2`,
        [low, high],
      );
      if (existing?.status === "accepted") return { relation: "friend" as const };
      if (existing) {
        if (existing.requester_id === me) return { relation: "requested" as const };
        await this.checkLimits(tx, me, them.id, true);
        await this.accept(tx, me, them, existing.id);
        return { relation: "friend" as const };
      }
      await this.checkLimits(tx, me, them.id);
      const [created] = await sql<{ id: string }>(
        tx,
        `INSERT INTO friendships (low_id, high_id, requester_id) VALUES ($1, $2, $3) RETURNING id`,
        [low, high, me],
      );
      const [self] = await sql<{ display_name: string; username: string }>(
        tx,
        `SELECT display_name, username::text AS username FROM users WHERE id = $1`,
        [me],
      );
      await this.notifications.notify(
        them.id,
        {
          kind: "friend.request",
          title: `${self!.display_name} wants to be friends`,
          body: `@${self!.username} sent you a friend request.`,
          link: "/friends/requests",
          dedupeKey: `friend-request:${created!.id}`,
        },
        tx,
      );
      return { relation: "requested" as const };
    });
  }

  /** Accepts a request someone sent you. Accepting a friendship you already have changes nothing. */
  async acceptFrom(me: string, username: string): Promise<{ relation: Relation }> {
    return this.db.transaction(async (tx) => {
      const them = await reachable(tx, me, username, this.env.KYC_AUTO_APPROVE);
      const { low, high } = await lockPair(tx, me, them.id);
      const [row] = await sql<FriendshipRow>(
        tx,
        `SELECT id, requester_id, status FROM friendships WHERE low_id = $1 AND high_id = $2`,
        [low, high],
      );
      if (!row)
        throw coded(HttpStatus.NOT_FOUND, "There's no request from that person.", "no_request");
      if (row.status === "accepted") return { relation: "friend" as const };
      if (row.requester_id === me) {
        throw coded(HttpStatus.NOT_FOUND, "There's no request from that person.", "no_request");
      }
      await this.checkLimits(tx, me, them.id, true);
      await this.accept(tx, me, them, row.id);
      return { relation: "friend" as const };
    });
  }

  private async accept(tx: Tx, me: string, them: Person, id: string): Promise<void> {
    await sql(
      tx,
      `UPDATE friendships SET status = 'accepted', responded_at = now() WHERE id = $1`,
      [id],
    );
    const [self] = await sql<{ display_name: string; username: string }>(
      tx,
      `SELECT display_name, username::text AS username FROM users WHERE id = $1`,
      [me],
    );
    await this.notifications.notify(
      them.id,
      {
        kind: "friend.accepted",
        title: `${self!.display_name} accepted your request`,
        body: `You and @${self!.username} are friends now.`,
        link: "/friends",
        dedupeKey: `friend-accepted:${id}`,
      },
      tx,
    );
  }

  /** Says no to a request, quietly: they are not told. */
  async decline(me: string, username: string): Promise<void> {
    await this.removeRow(
      me,
      username,
      (row) => row.status === "pending" && row.requester_id !== me,
    );
  }

  /** Takes back a request you sent. */
  async cancel(me: string, username: string): Promise<void> {
    await this.removeRow(
      me,
      username,
      (row) => row.status === "pending" && row.requester_id === me,
    );
  }

  /** Ends a friendship. Neither is told, and either can ask again. */
  async remove(me: string, username: string): Promise<void> {
    await this.removeRow(me, username, (row) => row.status === "accepted");
  }

  /** Doing it again, or to someone who is no longer there, is not an error: it is already as asked. */
  private async removeRow(
    me: string,
    username: string,
    applies: (row: FriendshipRow) => boolean,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Not `reachable`: you can always tidy up your own lists, even after someone has since been blocked.
      const [them] = await sql<{ id: string }>(tx, `SELECT id FROM users WHERE username = $1`, [
        username.trim().replace(/^@/, "").toLowerCase(),
      ]);
      if (!them || them.id === me) return;
      const { low, high } = await lockPair(tx, me, them.id);
      const [row] = await sql<FriendshipRow>(
        tx,
        `SELECT id, requester_id, status FROM friendships WHERE low_id = $1 AND high_id = $2`,
        [low, high],
      );
      if (row && applies(row)) await sql(tx, `DELETE FROM friendships WHERE id = $1`, [row.id]);
    });
  }

  private async checkLimits(tx: Tx, me: string, them: string, accepting = false): Promise<void> {
    await lockPeople(tx, me, them);
    const count = async (id: string) => {
      const [row] = await sql<{ n: string }>(
        tx,
        `SELECT count(*)::text AS n FROM friendships WHERE status = 'accepted' AND $1 IN (low_id, high_id)`,
        [id],
      );
      return Number(row!.n);
    };
    if ((await count(me)) >= MAX_FRIENDS) {
      throw coded(
        HttpStatus.CONFLICT,
        "You've reached the most friends you can have.",
        "too_many_friends",
      );
    }
    if ((await count(them)) >= MAX_FRIENDS) {
      throw coded(
        HttpStatus.CONFLICT,
        "That person can't take any more friends right now.",
        "too_many_friends",
      );
    }
    if (accepting) return;
    const [out] = await sql<{ n: string }>(
      tx,
      `SELECT count(*)::text AS n FROM friendships WHERE status = 'pending' AND requester_id = $1`,
      [me],
    );
    if (Number(out!.n) >= MAX_OUTGOING_REQUESTS) {
      throw coded(
        HttpStatus.CONFLICT,
        "You have a lot of requests waiting. Cancel some first.",
        "too_many_requests",
      );
    }
  }

  // ---- looking ------------------------------------------------------------------------------------

  async list(me: string): Promise<FriendRow[]> {
    return this.db.query<FriendRow[]>(
      `SELECT u.id, u.username::text AS username, u.display_name, f.responded_at AS since, ${NATIONAL} AS national
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.low_id = $1 THEN f.high_id ELSE f.low_id END
        WHERE f.status = 'accepted' AND $1 IN (f.low_id, f.high_id)
          AND u.status = 'active' AND u.username IS NOT NULL
        ORDER BY lower(u.display_name), u.username`,
      [me],
    );
  }

  async requests(me: string): Promise<{ incoming: RequestRow[]; outgoing: RequestRow[] }> {
    const rows = await this.db.query<(RequestRow & { incoming: boolean })[]>(
      `SELECT u.username::text AS username, u.display_name, f.created_at, ${NATIONAL} AS national,
              (f.requester_id <> $1) AS incoming
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.low_id = $1 THEN f.high_id ELSE f.low_id END
        WHERE f.status = 'pending' AND $1 IN (f.low_id, f.high_id)
          AND u.status = 'active' AND u.username IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = $1 AND bl.blocked_id = u.id)
                                                     OR (bl.blocker_id = u.id AND bl.blocked_id = $1))
        ORDER BY f.created_at DESC`,
      [me],
    );
    return {
      incoming: rows.filter((r) => r.incoming),
      outgoing: rows.filter((r) => !r.incoming),
    };
  }
}
