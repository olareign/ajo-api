import { NotFoundException } from "@nestjs/common";
import { sql } from "../database/sql.js";
import { REQUIRED_STEPS } from "../kyc/kyc-status.js";
import { normalizeUsername, isValidUsername } from "../identity/username-policy.js";

export type Tx = Parameters<typeof sql>[0];

/**
 * SQL that is true for a person whose identity checks are all approved. Written once, so "only
 * verified people can be found" means the same thing everywhere it is asked.
 */
export const approvedSql = (alias: string): string =>
  `(SELECT count(*) FROM kyc_steps ks WHERE ks.user_id = ${alias}.id AND ks.status = 'approved'
       AND ks.step IN (${REQUIRED_STEPS.map((s) => `'${s}'`).join(", ")})) = ${REQUIRED_STEPS.length}`;

/** True when either person has blocked the other. */
export const blockedSql = (a: string, b: string): string =>
  `EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ${a} AND bl.blocked_id = ${b})
                                      OR (bl.blocker_id = ${b} AND bl.blocked_id = ${a}))`;

/** A pair of people in the order the table stores them, so one row serves both. */
export function pair(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

/** Serialises everything that happens to one pair of people (requests crossing, accepting, blocking). */
export async function lockPair(
  tx: Tx,
  a: string,
  b: string,
): Promise<{ low: string; high: string }> {
  const p = pair(a, b);
  await sql(tx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `friends:${p.low}:${p.high}`,
  ]);
  return p;
}

export type Person = {
  id: string;
  username: string;
  display_name: string;
};

/**
 * Finds someone by username to act on. Everything that would make them unreachable (no such person,
 * not verified, suspended, blocked either way) is the same answer, so it cannot be used to learn
 * who has blocked whom or who is on the app.
 */
export async function reachable(tx: Tx, me: string, rawUsername: string): Promise<Person> {
  const username = normalizeUsername(rawUsername);
  const [person] = isValidUsername(username)
    ? await sql<Person>(
        tx,
        `SELECT u.id, u.username::text AS username, u.display_name FROM users u
          WHERE u.username = $1 AND u.status = 'active' AND u.id <> $2
            AND ${approvedSql("u")} AND NOT ${blockedSql("u.id", "$2::uuid")}`,
        [username, me],
      )
    : [];
  if (!person)
    throw new NotFoundException({
      message: "We couldn't find that person.",
      code: "person_not_found",
    });
  return person;
}

/**
 * Checks again, now the pair is locked, that neither has blocked the other. The check in `reachable`
 * came before the lock, so a block that landed in between would otherwise be stepped over.
 */
export async function assertNotBlocked(tx: Tx, a: string, b: string): Promise<void> {
  const [blocked] = await sql<{ n: string }>(
    tx,
    `SELECT count(*)::text AS n FROM blocks
      WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
    [a, b],
  );
  if (Number(blocked!.n) > 0) {
    throw new NotFoundException({
      message: "We couldn't find that person.",
      code: "person_not_found",
    });
  }
}

/**
 * Locks both people's rows, lowest id first, so counting their friends and requests and then adding
 * one cannot be done by two requests at once: the second counts after the first has finished.
 */
export async function lockPeople(tx: Tx, a: string, b: string): Promise<void> {
  await sql(tx, `SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [
    [a, b].sort(),
  ]);
}
