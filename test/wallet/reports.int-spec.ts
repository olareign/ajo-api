import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { LedgerService } from "../../src/ledger/ledger.service.js";
import { paymentsHarness } from "../payments/support.js";
import { createTestApp } from "../support/test-app.js";

let app: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;
let ledger: LedgerService;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  t = paymentsHarness(app);
  ledger = app.get(LedgerService);
});
afterAll(async () => {
  await app?.close();
});

/** Moves money between a person's wallet and their savings, the way a plan debit does. */
async function save(userId: string, amount: string) {
  const wallet = await ledger.userAccount(userId, "available", "NGN");
  const savings = await ledger.userAccount(userId, "savings", "NGN", `plan-${randomUUID()}`);
  await ledger.post({
    type: "savings_debit",
    idempotencyKey: `test-save-${randomUUID()}`,
    entries: [
      { accountId: wallet, direction: "debit", amount },
      { accountId: savings, direction: "credit", amount },
    ],
  });
}
/** Backdates a person's ledger rows (the ledger itself refuses changes, so its guard is set aside for the test). */
async function backdate(userId: string, at: string) {
  await t.db.query("ALTER TABLE ledger_transactions DISABLE TRIGGER ledger_transactions_immutable");
  try {
    await t.db.query(
      `UPDATE ledger_transactions SET created_at = $2 WHERE id IN (
         SELECT e.transaction_id FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.owner_id = $1)`,
      [userId, at],
    );
  } finally {
    await t.db.query(
      "ALTER TABLE ledger_transactions ENABLE TRIGGER ledger_transactions_immutable",
    );
  }
}
const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());

describe("a statement", () => {
  it("lists every line in the range with opening and closing balances and money in and out", async () => {
    const who = await t.ready("NG", { mfa: false });
    await t.giveMoney(who.id, "500000");
    await backdate(who.id, "2026-01-15T10:00:00Z");
    await t.giveMoney(who.id, "200000");
    await save(who.id, "100000");
    const res = await who
      .call("get", `/wallet/statement?from=2026-02-01&to=${today()}`)
      .expect(200);
    expect(res.body.timeZone).toBe("Africa/Lagos");
    expect(res.body.balances).toEqual([
      { currency: "NGN", opening: "500000", closing: "700000", moneyIn: "200000", moneyOut: "0" },
    ]);
    expect(
      res.body.lines.map(
        (l: { type: string; account: string; direction: string; amount: string }) => [
          l.type,
          l.account,
          l.direction,
          l.amount,
        ],
      ),
    ).toEqual([
      ["funding", "available", "in", "200000"],
      ["savings_debit", "available", "out", "100000"],
      ["savings_debit", "savings", "in", "100000"],
    ]);
    expect(res.body.truncated).toBe(false);
  });

  it("counts a day in the person's own time zone, not the server's", async () => {
    const who = await t.ready("NG", { mfa: false });
    await t.giveMoney(who.id, "1000");
    // 23:30 UTC on 31 March is 00:30 on 1 April in Lagos.
    await backdate(who.id, "2026-03-31T23:30:00Z");
    const march = await who
      .call("get", "/wallet/statement?from=2026-03-01&to=2026-03-31")
      .expect(200);
    const april = await who
      .call("get", "/wallet/statement?from=2026-04-01&to=2026-04-30")
      .expect(200);
    expect(march.body.lines).toHaveLength(0);
    expect(april.body.lines).toHaveLength(1);
  });

  it("refuses an impossible, backwards or over-long range, and needs real dates", async () => {
    const who = await t.ready("NG", { mfa: false });
    expect(
      (await who.call("get", "/wallet/statement?from=2026-02-30&to=2026-03-01").expect(400)).body
        .code,
    ).toBe("bad_dates");
    expect(
      (await who.call("get", "/wallet/statement?from=2026-05-01&to=2026-04-01").expect(400)).body
        .code,
    ).toBe("bad_range");
    expect(
      (await who.call("get", "/wallet/statement?from=2024-01-01&to=2026-01-01").expect(400)).body
        .code,
    ).toBe("range_too_long");
    await who.call("get", "/wallet/statement?from=yesterday&to=today").expect(400);
    await who.call("get", "/wallet/statement").expect(400);
  });

  it("shows only the caller's own money", async () => {
    const [mine, theirs] = [
      await t.ready("NG", { mfa: false }),
      await t.ready("NG", { mfa: false }),
    ];
    await t.giveMoney(theirs.id, "777");
    const res = await mine
      .call("get", `/wallet/statement?from=2026-01-01&to=${today()}`)
      .expect(200);
    expect(res.body.lines).toEqual([]);
    expect(res.body.balances).toEqual([]);
  });
});

describe("monthly insights", () => {
  it("gives money in, out, saved and month-end balances for each of the last months, this one included", async () => {
    const who = await t.ready("NG", { mfa: false });
    await t.giveMoney(who.id, "300000");
    await save(who.id, "50000");
    const res = await who.call("get", "/wallet/insights?months=3").expect(200);
    const months = res.body.months as {
      month: string;
      moneyIn: string;
      savedNet: string;
      endAvailable: string;
      endSavings: string;
    }[];
    expect(months).toHaveLength(3);
    const now = months[2]!;
    expect(now.month).toBe(today().slice(0, 7));
    expect([now.moneyIn, now.savedNet, now.endAvailable, now.endSavings]).toEqual([
      "300000",
      "50000",
      "250000",
      "50000",
    ]);
    expect(months[0]!.endAvailable).toBe("0");
  });

  it("is empty for someone with no money yet, and refuses more than two years", async () => {
    const who = await t.ready("NG", { mfa: false });
    expect((await who.call("get", "/wallet/insights").expect(200)).body.months).toEqual([]);
    await who.call("get", "/wallet/insights?months=25").expect(400);
  });
});
