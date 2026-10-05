import { sql } from "../database/sql.js";

/** 4-20 letters, numbers, - or _, starting and ending with a letter or number; stored in capitals. */
export const INVITE_CODE = /^[A-Z0-9][A-Z0-9_-]{2,18}[A-Z0-9]$/;

/**
 * Remembers who invited someone new, inside the transaction that creates them. A code that means
 * nothing (wrong, or the person's own) is ignored without a word, so signing up can never be used to
 * test which codes exist.
 */
export async function recordReferral(
  tx: Parameters<typeof sql>[0],
  inviteeId: string,
  rawCode: string | undefined,
): Promise<void> {
  const upper = rawCode?.toUpperCase();
  if (!upper || !INVITE_CODE.test(upper)) return;
  await sql(
    tx,
    `INSERT INTO referrals (invitee_id, inviter_id)
     SELECT $1, l.user_id FROM invite_links l WHERE l.code = $2 AND l.user_id <> $1
     ON CONFLICT DO NOTHING`,
    [inviteeId, upper],
  );
}
