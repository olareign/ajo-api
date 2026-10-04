import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { DataSource } from "typeorm";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
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
