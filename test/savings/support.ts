import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes, randomUUID } from "node:crypto";
import { SavingsRunner } from "../../src/savings/savings-runner.js";
import { addDays, todayIn } from "../../src/savings/savings-rules.js";
import { paymentsHarness, PIN } from "../payments/support.js";

export { PIN };
export const key = () => `k_${randomUUID()}`;

type Person = Awaited<ReturnType<ReturnType<typeof paymentsHarness>["ready"]>>;

/** Everything a savings test needs: signed-in people, money in wallets, plans, and a clock we can wind. */
export function savingsHarness(app: NestExpressApplication) {
  const t = paymentsHarness(app);
  const runner = app.get(SavingsRunner);

  /** Someone approved to save, with the authenticator off (saving does not ask for it) and money in their wallet. */
  async function saver(wallet = "0", country: "NG" | "GB" = "NG") {
    const who = await t.ready(country, { mfa: false });
    if (wallet !== "0") await t.giveMoney(who.id, wallet, who.currency);
    return who;
  }

  const body = (over: Record<string, unknown> = {}) => ({
    name: "Rent",
    amount: "500000",
    frequency: "weekly",
    totalDebits: 4,
    startDate: todayIn("NGN"),
    ...over,
  });

  async function plan(who: Person, over: Record<string, unknown> = {}) {
    const res = await who
      .call("post", "/savings")
      .set("Idempotency-Key", key())
      .send(body(over))
      .expect(201);
    return res.body as { id: string; schedule: { seq: number; dueOn: string; status: string }[] };
  }

  /** Winds the clock: every debit still to come is now due. Optionally only the first `n`. */
  async function makeDue(planId: string, only?: number) {
    await t.db.query(
      `UPDATE savings_debits SET next_attempt_at = now() - interval '1 minute'
        WHERE plan_id = $1 AND status = 'scheduled'
          AND ($2::int IS NULL OR seq IN (SELECT seq FROM savings_debits WHERE plan_id = $1 AND status = 'scheduled' ORDER BY seq LIMIT $2::int))`,
      [planId, only ?? null],
    );
  }

  const debits = (planId: string) =>
    t.db.query(
      "SELECT seq, status, attempts, pull_key, topup_intent_id, note, next_attempt_at FROM savings_debits WHERE plan_id = $1 ORDER BY seq",
      [planId],
    );
  const planRow = async (planId: string) =>
    (await t.db.query("SELECT * FROM savings_plans WHERE id = $1", [planId]))[0];

  /** What is in a plan's own ledger account. */
  async function saved(userId: string, planId: string, currency = "NGN") {
    const account = await t.ledger.userAccount(userId, "savings", currency, `plan:${planId}`);
    return t.ledger.balance(account);
  }

  const notices = (userId: string) =>
    t.db.query(
      "SELECT kind, title, body, email_status FROM notifications WHERE user_id = $1 ORDER BY seq",
      [userId],
    );

  /** An auto-debit the partner has activated, so a bank collection is possible. */
  async function activeMandate(userId: string) {
    await t.db.query(
      `INSERT INTO mandates (user_id, provider, status, reference, authorization_code)
       VALUES ($1, 'fake', 'active', $2, $3)`,
      [userId, `ajm_${randomBytes(8).toString("hex")}`, `AUTH_${randomBytes(6).toString("hex")}`],
    );
  }

  const inDays = (n: number) => addDays(todayIn("NGN"), n);

  return {
    t,
    runner,
    saver,
    plan,
    body,
    makeDue,
    debits,
    planRow,
    saved,
    notices,
    activeMandate,
    inDays,
  };
}
