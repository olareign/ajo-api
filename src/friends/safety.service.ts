import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { normalizeUsername } from "../identity/username-policy.js";
import { coded } from "../payments/payment-intents.js";
import { lockPair, reachable } from "./people.js";

export const REPORT_REASONS = ["spam", "harassment", "fake_account", "scam", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/**
 * Keeping people safe from each other. A block ends any friendship or request between the two and
 * hides each from the other everywhere; the blocked person is never told. A report goes to the
 * admin queue (E9) and nobody else sees it.
 */
@Injectable()
export class Safety {
  constructor(
    private readonly db: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async block(me: string, username: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Someone already blocked, or no longer reachable some other way, can still be blocked.
      const [them] = await sql<{ id: string }>(
        tx,
        `SELECT id FROM users WHERE username = $1 AND status = 'active' AND id <> $2`,
        [normalizeUsername(username), me],
      );
      if (!them)
        throw coded(HttpStatus.NOT_FOUND, "We couldn't find that person.", "person_not_found");
      const { low, high } = await lockPair(tx, me, them.id);
      await sql(
        tx,
        `INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [me, them.id],
      );
      await sql(tx, `DELETE FROM friendships WHERE low_id = $1 AND high_id = $2`, [low, high]);
    });
  }

  async unblock(me: string, username: string): Promise<void> {
    await this.db.query(
      `DELETE FROM blocks WHERE blocker_id = $1
          AND blocked_id = (SELECT id FROM users WHERE username = $2)`,
      [me, normalizeUsername(username)],
    );
  }

  async blocked(
    me: string,
  ): Promise<{ username: string; display_name: string; created_at: Date }[]> {
    return this.db.query(
      `SELECT u.username::text AS username, u.display_name, b.created_at
         FROM blocks b JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = $1 AND u.username IS NOT NULL ORDER BY b.created_at DESC`,
      [me],
    );
  }

  /** One open report per pair: reporting again while one is open changes nothing. */
  async report(
    me: string,
    username: string,
    reason: ReportReason,
    details?: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const them = await reachable(tx, me, username, this.env.KYC_AUTO_APPROVE).catch(
        async (error) => {
          // You can report someone you have blocked.
          const [blocked] = await sql<{ id: string }>(
            tx,
            `SELECT u.id FROM users u JOIN blocks b ON b.blocked_id = u.id
            WHERE u.username = $1 AND b.blocker_id = $2`,
            [normalizeUsername(username), me],
          );
          if (!blocked) throw error;
          return { id: blocked.id };
        },
      );
      await sql(
        tx,
        `INSERT INTO reports (reporter_id, reported_id, reason, details) VALUES ($1, $2, $3, $4)
         ON CONFLICT (reporter_id, reported_id) WHERE status = 'open' DO NOTHING`,
        [me, them.id, reason, details?.trim() || null],
      );
    });
  }
}
