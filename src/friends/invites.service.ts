import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { DataSource } from "typeorm";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { coded } from "../payments/payment-intents.js";
import {
  CHANGE_WINDOW_DAYS,
  codeProblem,
  MAX_CHANGES,
  normalizeCode,
  RELEASE_HOLD_DAYS,
} from "./invite-code-rules.js";
import { INVITE_CODE } from "./referrals.js";

/** No 0, 1, I, O: a code read aloud or typed from a screenshot is not mistaken. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const newInviteCode = () =>
  Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");

/** A person's invite link, and what joining through one does: it suggests the inviter, nothing more. */
@Injectable()
export class Invites {
  constructor(
    private readonly db: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The person's own code, made the first time it is asked for and the same ever after. */
  async mine(userId: string): Promise<{ code: string; link: string }> {
    let existing = await this.db.query<{ code: string }[]>(
      `SELECT code FROM invite_links WHERE user_id = $1`,
      [userId],
    );
    while (existing.length === 0) {
      // A clash on the code (rare) just tries another; a clash on the person means another request made it first.
      await this.db.query(
        `INSERT INTO invite_links (user_id, code) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [userId, newInviteCode()],
      );
      existing = await this.db.query<{ code: string }[]>(
        `SELECT code FROM invite_links WHERE user_id = $1`,
        [userId],
      );
    }
    return { code: existing[0]!.code, link: `${this.env.WEB_APP_URL}/join/${existing[0]!.code}` };
  }

  /**
   * Sets the person's own invite code. The old code stops working at once (so a leaked link can be
   * killed), can't be claimed by anyone else for RELEASE_HOLD_DAYS, and a code can change at most
   * MAX_CHANGES times in CHANGE_WINDOW_DAYS. Choosing the code you already have changes nothing.
   */
  async setCode(userId: string, raw: string): Promise<{ code: string; link: string }> {
    const code = normalizeCode(raw);
    const problem = codeProblem(code);
    if (problem === "invalid")
      throw coded(
        HttpStatus.BAD_REQUEST,
        "Use 4 to 20 letters or numbers; - and _ are fine in the middle.",
        "code_invalid",
      );
    if (problem === "unavailable")
      throw coded(
        HttpStatus.CONFLICT,
        "That code isn't available. Try another.",
        "code_unavailable",
      );

    const current = await this.mine(userId);
    if (current.code === code) return current;

    try {
      await this.db.transaction(async (tx) => {
        // One change at a time per person, so the limit can't be raced past.
        await sql(tx, `SELECT 1 FROM invite_links WHERE user_id = $1 FOR UPDATE`, [userId]);
        const [counted] = await sql<{ recent: number }>(
          tx,
          `SELECT count(*)::int AS recent FROM invite_code_changes
            WHERE user_id = $1 AND changed_at > now() - make_interval(days => $2)`,
          [userId, CHANGE_WINDOW_DAYS],
        );
        if ((counted?.recent ?? 0) >= MAX_CHANGES)
          throw coded(
            HttpStatus.TOO_MANY_REQUESTS,
            `You can change your code ${MAX_CHANGES} times in ${CHANGE_WINDOW_DAYS} days. Try again later.`,
            "code_change_limit",
          );
        const [held] = await sql<{ held: boolean }>(
          tx,
          `SELECT EXISTS (
             SELECT 1 FROM invite_links WHERE code = $1 AND user_id <> $2
           ) OR EXISTS (
             SELECT 1 FROM invite_code_changes
              WHERE old_code = $1 AND user_id <> $2 AND changed_at > now() - make_interval(days => $3)
           ) AS held`,
          [code, userId, RELEASE_HOLD_DAYS],
        );
        if (held?.held)
          throw coded(
            HttpStatus.CONFLICT,
            "That code isn't available. Try another.",
            "code_unavailable",
          );
        const [old] = await sql<{ code: string }>(
          tx,
          `UPDATE invite_links l SET code = $2 FROM (SELECT code FROM invite_links WHERE user_id = $1) o
            WHERE l.user_id = $1 RETURNING o.code`,
          [userId, code],
        );
        await sql(
          tx,
          `INSERT INTO invite_code_changes (user_id, old_code, new_code) VALUES ($1, $2, $3)`,
          [userId, old!.code, code],
        );
      });
    } catch (error) {
      // Someone else took the same code in the same moment: the unique index decided.
      if ((error as { code?: string }).code === "23505")
        throw coded(
          HttpStatus.CONFLICT,
          "That code isn't available. Try another.",
          "code_unavailable",
        );
      throw error;
    }
    return { code, link: `${this.env.WEB_APP_URL}/join/${code}` };
  }

  /** The people who joined through this person's invite, newest first. */
  async referrals(
    userId: string,
  ): Promise<{ displayName: string; username: string | null; joinedAt: string }[]> {
    const rows = await this.db.query<
      { display_name: string; username: string | null; created_at: Date }[]
    >(
      `SELECT u.display_name, u.username::text AS username, r.created_at
         FROM referrals r JOIN users u ON u.id = r.invitee_id
        WHERE r.inviter_id = $1 AND u.status = 'active'
        ORDER BY r.created_at DESC
        LIMIT 100`,
      [userId],
    );
    return rows.map((r) => ({
      displayName: r.display_name,
      username: r.username,
      joinedAt: r.created_at.toISOString(),
    }));
  }

  /** Who a code belongs to, for the page the link opens: a first name and handle, and only for a live account. */
  async whose(raw: string): Promise<{ name: string; username: string | null } | null> {
    const upper = raw.toUpperCase();
    if (!INVITE_CODE.test(upper)) return null;
    const [row] = await this.db.query<{ display_name: string; username: string | null }[]>(
      `SELECT u.display_name, u.username::text AS username
         FROM invite_links l JOIN users u ON u.id = l.user_id
        WHERE l.code = $1 AND u.status = 'active'`,
      [upper],
    );
    return row ? { name: row.display_name.split(/\s+/)[0]!, username: row.username } : null;
  }
}
