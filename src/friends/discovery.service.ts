import { BadRequestException, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { isValidUsername, normalizeUsername } from "../identity/username-policy.js";
import { approvedSql, blockedSql } from "./people.js";
import type { Relation } from "./friends.service.js";

export type Found = {
  username: string;
  display_name: string;
  relation: Relation;
  mutual: number;
  national: boolean;
};

export type Suggestion = Found & {
  reason: "mutual" | "invited_you" | "you_invited";
  names: string[];
};

const SEARCH_LIMIT = 10;
const SUGGESTION_LIMIT = 20;
export const MIN_QUERY = 3;

/** The two people's relationship, from the side of the person asking. */
const RELATION = `CASE
    WHEN f.id IS NULL THEN 'none'
    WHEN f.status = 'accepted' THEN 'friend'
    WHEN f.requester_id = $1 THEN 'requested'
    ELSE 'incoming' END`;

const JOIN_FRIENDSHIP = `LEFT JOIN friendships f ON f.low_id = least($1::uuid, u.id) AND f.high_id = greatest($1::uuid, u.id)`;

/** How many accepted friends the person asking and this person have in common. */
const MUTUAL = `(SELECT count(*) FROM friendships g1 JOIN friendships g2
        ON g2.status = 'accepted' AND u.id IN (g2.low_id, g2.high_id)
       AND (CASE WHEN g1.low_id = $1 THEN g1.high_id ELSE g1.low_id END)
         = (CASE WHEN g2.low_id = u.id THEN g2.high_id ELSE g2.low_id END)
      WHERE g1.status = 'accepted' AND $1 IN (g1.low_id, g1.high_id))::int`;

const NATIONAL = `EXISTS (SELECT 1 FROM kyc_steps ns WHERE ns.user_id = u.id AND ns.step = 'national_check' AND ns.status = 'approved')`;

/**
 * Finding people. Only verified, active people appear, never anyone who has blocked you or whom you
 * have blocked, and a search needs the start of a real username, so it cannot be used to list everyone.
 */
@Injectable()
export class Discovery {
  constructor(private readonly db: DataSource) {}

  async search(me: string, raw: string): Promise<Found[]> {
    const q = normalizeUsername(raw);
    if (q.length < MIN_QUERY || !isValidUsername(q)) {
      throw new BadRequestException({
        message: `Type at least ${MIN_QUERY} letters of their username.`,
        code: "query_too_short",
      });
    }
    return this.db.query<Found[]>(
      `SELECT u.username::text AS username, u.display_name, ${RELATION} AS relation, ${MUTUAL} AS mutual, ${NATIONAL} AS national
         FROM users u ${JOIN_FRIENDSHIP}
        WHERE u.id <> $1 AND u.status = 'active' AND u.username IS NOT NULL
          AND u.username::text LIKE $2 ESCAPE '\\' AND ${approvedSql("u")} AND NOT ${blockedSql("u.id", "$1::uuid")}
        ORDER BY (u.username::text = $3) DESC, u.username::text LIMIT ${SEARCH_LIMIT}`,
      [me, `${q.replaceAll("_", "\\_")}%`, q],
    );
  }

  /** One person's card, as the person asking sees it; the same "not found" for anyone they should not see. */
  async profile(me: string, raw: string): Promise<Found | null> {
    const username = normalizeUsername(raw);
    const [row] = await this.db.query<Found[]>(
      `SELECT u.username::text AS username, u.display_name, ${RELATION} AS relation, ${MUTUAL} AS mutual, ${NATIONAL} AS national
         FROM users u ${JOIN_FRIENDSHIP}
        WHERE u.id <> $1 AND u.username = $2 AND u.status = 'active'
          AND ${approvedSql("u")} AND NOT ${blockedSql("u.id", "$1::uuid")}`,
      [me, username],
    );
    return row ?? null;
  }

  /**
   * People you may know: friends of your friends, most in common first, then whoever invited you and
   * whoever you invited who has joined. Never someone you already have anything open with, a blocked
   * person, or someone not verified.
   */
  async suggestions(me: string): Promise<Suggestion[]> {
    const mutual = await this.db.query<(Found & { names: string[] })[]>(
      `WITH mine AS (
         SELECT CASE WHEN low_id = $1 THEN high_id ELSE low_id END AS fid
           FROM friendships WHERE status = 'accepted' AND $1 IN (low_id, high_id)),
       cand AS (
         SELECT CASE WHEN g.low_id = mine.fid THEN g.high_id ELSE g.low_id END AS uid,
                count(*)::int AS mutual,
                (array_agg(mu.display_name ORDER BY mu.display_name))[1:2] AS names
           FROM mine
           JOIN friendships g ON g.status = 'accepted' AND mine.fid IN (g.low_id, g.high_id)
           JOIN users mu ON mu.id = mine.fid
          GROUP BY 1)
       SELECT u.username::text AS username, u.display_name, 'none' AS relation, c.mutual AS mutual,
              ${NATIONAL} AS national, c.names AS names
         FROM cand c JOIN users u ON u.id = c.uid
         ${JOIN_FRIENDSHIP}
        WHERE u.id <> $1 AND f.id IS NULL AND u.status = 'active' AND u.username IS NOT NULL
          AND ${approvedSql("u")} AND NOT ${blockedSql("u.id", "$1::uuid")}
        ORDER BY c.mutual DESC, u.username::text LIMIT ${SUGGESTION_LIMIT}`,
      [me],
    );
    const referred = await this.db.query<(Found & { reason: Suggestion["reason"] })[]>(
      `SELECT u.username::text AS username, u.display_name, 'none' AS relation, ${MUTUAL} AS mutual,
              ${NATIONAL} AS national,
              CASE WHEN r.invitee_id = $1 THEN 'invited_you' ELSE 'you_invited' END AS reason
         FROM referrals r
         JOIN users u ON u.id = CASE WHEN r.invitee_id = $1 THEN r.inviter_id ELSE r.invitee_id END
         ${JOIN_FRIENDSHIP}
        WHERE $1 IN (r.invitee_id, r.inviter_id) AND f.id IS NULL AND u.status = 'active'
          AND u.username IS NOT NULL AND ${approvedSql("u")} AND NOT ${blockedSql("u.id", "$1::uuid")}
        ORDER BY r.created_at DESC LIMIT 10`,
      [me],
    );
    const seen = new Set<string>();
    const out: Suggestion[] = [];
    for (const r of referred) {
      seen.add(r.username);
      out.push({ ...r, names: [] });
    }
    for (const m of mutual) {
      if (seen.has(m.username)) continue;
      out.push({ ...m, reason: "mutual", names: m.names ?? [] });
    }
    return out.slice(0, SUGGESTION_LIMIT);
  }
}
