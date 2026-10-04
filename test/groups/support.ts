import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes, randomUUID } from "node:crypto";
import { GroupRunner } from "../../src/groups/group-runner.js";
import { addDays, todayIn } from "../../src/savings/savings-rules.js";
import { friendsHarness, type Member } from "../friends/support.js";
import { PIN } from "../payments/support.js";

export { PIN };
export type { Member };
export const key = () => `k_${randomUUID()}`;

/** Everything a circle test needs: people with wallets, mandates and trust, circles, and a clock we can wind. */
export function groupsHarness(app: NestExpressApplication) {
  const f = friendsHarness(app);
  const { t } = f;
  const runner = app.get(GroupRunner);

  const mandate = async (userId: string) => {
    await t.db.query(
      `INSERT INTO mandates (user_id, provider, status, reference, authorization_code) VALUES ($1, 'fake', 'active', $2, $3)`,
      [userId, `ajm_${randomBytes(8).toString("hex")}`, `AUTH_${randomBytes(6).toString("hex")}`],
    );
  };

  /** Eight on-time payments on record: trusted. */
  const trusted = async (userId: string) => {
    for (let i = 0; i < 8; i += 1) {
      await t.db.query(
        `INSERT INTO trust_events (user_id, kind, ref) VALUES ($1, 'payment_on_time', $2)`,
        [userId, `seed:${randomUUID()}`],
      );
    }
  };

  /** A verified person with an auto-debit and money in their wallet; `trust` puts a good record behind them. */
  async function person(
    wallet = "10000000",
    options: { trust?: boolean; name?: string; mandate?: boolean } = {},
  ) {
    const who = await f.member({ name: options.name });
    if (options.mandate !== false) await mandate(who.id);
    if (wallet !== "0") await t.giveMoney(who.id, wallet);
    if (options.trust) await trusted(who.id);
    return who;
  }

  const body = (over: Record<string, unknown> = {}) => ({
    name: "Cousins",
    contribution: "500000",
    frequency: "monthly",
    size: 3,
    startDate: addDays(todayIn("NGN"), 5),
    orderMethod: "join_order",
    visibility: "private",
    ...over,
  });

  async function create(who: Member, over: Record<string, unknown> = {}) {
    const res = await who
      .call("post", "/groups")
      .set("Idempotency-Key", key())
      .send(body(over))
      .expect(201);
    return res.body as Detail;
  }

  const join = (who: Member, code: string) => who.call("post", "/groups/join").send({ code });

  /** A circle that has filled: its creator and the people who join, in that order. */
  async function filled(creator: Member, others: Member[], over: Record<string, unknown> = {}) {
    const g = await create(creator, { size: others.length + 1, ...over });
    for (const o of others) await join(o, g.inviteCode!).expect(200);
    return g;
  }

  const detail = async (who: Member, id: string) =>
    (await who.call("get", `/groups/${id}`).expect(200)).body as Detail;
  const row = async (id: string) =>
    (await t.db.query("SELECT * FROM groups WHERE id = $1", [id]))[0];
  const members = (id: string) =>
    t.db.query(
      "SELECT user_id, spot, status, deposit_required::text AS deposit_required FROM group_members WHERE group_id = $1 ORDER BY join_seq",
      [id],
    );
  const contributions = (id: string, round?: number) =>
    t.db.query(
      "SELECT member_id, round_no, status, attempts, note, pull_key, topup_intent_id FROM group_contributions WHERE group_id = $1 AND ($2::int IS NULL OR round_no = $2) ORDER BY round_no, member_id",
      [id, round ?? null],
    );
  const rounds = (id: string) =>
    t.db.query("SELECT * FROM group_rounds WHERE group_id = $1 ORDER BY round_no", [id]);

  /** Winds the clock to a round's day: it is due now (and `daysAgo` days ago if we want it late). */
  async function dueRound(id: string, round: number, daysAgo = 0) {
    await t.db.query(
      "UPDATE group_rounds SET due_on = (now() - make_interval(days => $3::int))::date WHERE group_id = $1 AND round_no = $2",
      [id, round, daysAgo],
    );
    await t.db.query(
      "UPDATE group_contributions SET next_attempt_at = now() - interval '1 minute' WHERE group_id = $1 AND round_no = $2 AND status = 'scheduled'",
      [id, round],
    );
  }

  async function locked(userId: string, groupId: string) {
    const account = await t.ledger.userAccount(userId, "locked", "NGN", `group:${groupId}:deposit`);
    return t.ledger.balance(account);
  }
  const trustCounts = (userId: string) =>
    t.db.query(
      "SELECT kind, count(*)::int AS n FROM trust_events WHERE user_id = $1 GROUP BY kind ORDER BY kind",
      [userId],
    );
  const notices = (userId: string) =>
    t.db.query(
      "SELECT kind, title, body, email_status FROM notifications WHERE user_id = $1 ORDER BY seq",
      [userId],
    );

  return {
    f,
    t,
    runner,
    person,
    mandate,
    trusted,
    body,
    create,
    join,
    filled,
    detail,
    row,
    members,
    contributions,
    rounds,
    dueRound,
    locked,
    trustCounts,
    notices,
  };
}

export type Detail = {
  id: string;
  status: string;
  inviteCode: string | null;
  memberCount: number;
  mySpot: number | null;
  size: number;
  members: {
    username: string;
    spot: number | null;
    isYou: boolean;
    trust: { level: string; score: number };
    current: string | null;
  }[];
  rounds: {
    roundNo: number;
    recipient: string | null;
    status: string;
    paid: number;
    payout: { amount: string } | null;
    board: { username: string; status: string | null }[];
  }[];
  draws: {
    kind: string;
    seed: string;
    order: { username: string | null; spot: number | null }[];
  }[];
  myDeposit: { amount: string } | null;
  pickDeadline: string | null;
  [k: string]: unknown;
};
