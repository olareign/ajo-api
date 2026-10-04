import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { RECENT_DAYS, summarise, type Trust, type TrustKind } from "./trust-rules.js";

type Tx = Parameters<typeof sql>[0];

type CountRow = {
  user_id: string;
  on_time: string;
  late: string;
  missed: string;
  completed: string;
  missed_recently: string;
  blocked: boolean;
};

/** Trust is never stored as a number: it is worked out from what has happened, so it cannot drift. */
@Injectable()
export class TrustService {
  constructor(private readonly db: DataSource) {}

  /** Records something that happened, once: the same `ref` for the same person is a no-op. */
  async record(
    tx: Tx,
    userId: string,
    kind: TrustKind,
    ref: string,
    groupId?: string,
  ): Promise<void> {
    await sql(
      tx,
      `INSERT INTO trust_events (user_id, kind, ref, group_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, ref) DO NOTHING`,
      [userId, kind, ref, groupId ?? null],
    );
  }

  /** Several people at once. Anyone with no record is returned as new. */
  async profiles(userIds: readonly string[], within?: Tx): Promise<Map<string, Trust>> {
    const text = `SELECT u.id AS user_id,
              count(*) FILTER (WHERE e.kind = 'payment_on_time')::text AS on_time,
              count(*) FILTER (WHERE e.kind = 'payment_late')::text AS late,
              count(*) FILTER (WHERE e.kind = 'payment_missed')::text AS missed,
              count(*) FILTER (WHERE e.kind = 'group_completed')::text AS completed,
              count(*) FILTER (WHERE e.kind = 'payment_missed' AND e.created_at > now() - make_interval(days => $2::int))::text AS missed_recently,
              EXISTS (SELECT 1 FROM defaulter_blocks d WHERE d.user_id = u.id AND d.blocked_until > now()) AS blocked
         FROM users u LEFT JOIN trust_events e ON e.user_id = u.id
        WHERE u.id = ANY($1::uuid[]) GROUP BY u.id`;
    const rows = within
      ? await sql<CountRow>(within, text, [userIds, RECENT_DAYS])
      : await this.db.query<CountRow[]>(text, [userIds, RECENT_DAYS]);
    return new Map(
      rows.map((r) => [
        r.user_id,
        summarise({
          onTime: Number(r.on_time),
          late: Number(r.late),
          missed: Number(r.missed),
          completed: Number(r.completed),
          missedRecently: Number(r.missed_recently),
          blocked: r.blocked,
        }),
      ]),
    );
  }

  async profile(userId: string, within?: Tx): Promise<Trust> {
    return (
      (await this.profiles([userId], within)).get(userId) ??
      summarise({ onTime: 0, late: 0, missed: 0, completed: 0, missedRecently: 0, blocked: false })
    );
  }

  /** Someone who defaulted cannot join or start a circle until this has passed. */
  async isBlocked(userId: string, within?: Tx): Promise<boolean> {
    const text = `SELECT 1 FROM defaulter_blocks WHERE user_id = $1 AND blocked_until > now()`;
    const rows = within
      ? await sql(within, text, [userId])
      : await this.db.query<unknown[]>(text, [userId]);
    return rows.length > 0;
  }

  async block(tx: Tx, userId: string, days: number, reason: string): Promise<void> {
    await sql(
      tx,
      `INSERT INTO defaulter_blocks (user_id, blocked_until, reason)
       VALUES ($1, now() + make_interval(days => $2::int), $3)
       ON CONFLICT (user_id) DO UPDATE
         SET blocked_until = greatest(defaulter_blocks.blocked_until, excluded.blocked_until), reason = excluded.reason`,
      [userId, days, reason.slice(0, 200)],
    );
  }
}
