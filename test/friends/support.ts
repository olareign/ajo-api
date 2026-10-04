import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes, randomUUID } from "node:crypto";
import { paymentsHarness } from "../payments/support.js";

export type Member = Awaited<ReturnType<ReturnType<typeof friendsHarness>["member"]>>;

export function friendsHarness(app: NestExpressApplication) {
  const t = paymentsHarness(app);

  /** A verified person with a username, signed in. */
  async function member(options: { kyc?: boolean; name?: string } = {}) {
    const who = await t.ready("NG", { mfa: false, kyc: options.kyc });
    const [row] = await t.db.query("SELECT username::text AS username FROM users WHERE id = $1", [
      who.id,
    ]);
    if (options.name)
      await t.db.query("UPDATE users SET display_name = $2 WHERE id = $1", [who.id, options.name]);
    return { ...who, username: row.username as string };
  }

  /** People who exist only as rows (no sign-in): enough to be found, befriended or blocked. Fast, for crowds. */
  async function crowd(n: number, prefix = "crowd", options: { approved?: boolean } = {}) {
    const stamp = randomBytes(3).toString("hex");
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const id = randomUUID();
      ids.push(id);
      await t.db.query(
        `INSERT INTO users (id, email, email_verified, email_verified_at, password_hash, display_name, username)
         VALUES ($1, $2, true, now(), 'x', $3, $4)`,
        [
          id,
          `${prefix}-${stamp}-${i}@example.com`,
          `${prefix} ${i}`,
          `${prefix}${stamp}${String(i).padStart(3, "0")}`.slice(0, 20),
        ],
      );
      if (options.approved !== false) await approve(id);
    }
    return ids;
  }

  const approve = async (userId: string) => {
    for (const step of ["id", "selfie", "address", "location", "bank"]) {
      await t.db.query(
        `INSERT INTO kyc_steps (user_id, step, status) VALUES ($1, $2, 'approved') ON CONFLICT DO NOTHING`,
        [userId, step],
      );
    }
  };

  const pairRows = async (a: string, b: string) =>
    t.db.query(
      "SELECT status, requester_id FROM friendships WHERE low_id = least($1::uuid, $2::uuid) AND high_id = greatest($1::uuid, $2::uuid)",
      [a, b],
    );

  /** Two people who are already friends. */
  async function befriend(a: Member, b: Member) {
    await a.call("post", "/friends/requests").send({ username: b.username }).expect(200);
    await b.call("post", `/friends/requests/${a.username}/accept`).expect(200);
  }

  const notices = (userId: string) =>
    t.db.query("SELECT kind, title, body FROM notifications WHERE user_id = $1 ORDER BY seq", [
      userId,
    ]);

  return { t, member, crowd, approve, pairRows, befriend, notices };
}
