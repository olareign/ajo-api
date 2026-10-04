import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { MoneyActionGuard } from "../../src/auth/money-action.guard.js";
import { createTestApp } from "../support/test-app.js";
import { paymentsHarness, PIN } from "./support.js";

let app: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" }, [], (builder) =>
    builder.overrideGuard(MoneyActionGuard).useValue({ canActivate: () => true }),
  );
  t = paymentsHarness(app);
});
afterAll(async () => {
  await app?.close();
});
afterEach(async () => {
  t.fake("NG").behaviour.transfer = "pending";
  t.fake("NG").behaviour.transfers.clear();
  await t.expectBooksBalance();
});

type Who = Awaited<ReturnType<typeof t.ready>>;
const key = () => `k_${randomUUID()}`;
const withdraw = (who: Who, amount: string, idempotencyKey = key()) =>
  who
    .call("post", "/payments/withdraw")
    .set("Idempotency-Key", idempotencyKey)
    .send({ amount, pin: PIN });
const many = <T>(n: number, make: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => make(i)));
const transfers = () => t.fake("NG").calls.filter(([m]) => m === "transfer").length;

async function withMoney(balance: string) {
  const who = await t.ready();
  await t.giveMoney(who.id, balance);
  await t.payoutAccount(who);
  return who;
}

describe("spending the same money twice", () => {
  it("lets exactly as many withdrawals through as the balance pays for, however many arrive together", async () => {
    const who = await withMoney("100000");
    const before = transfers();
    const answers = await many(8, () => withdraw(who, "40000"));

    const ok = answers.filter((a) => a.status === 200);
    const refused = answers.filter((a) => a.status === 422);
    expect(ok).toHaveLength(2);
    expect(refused).toHaveLength(6);
    expect(refused.every((r) => r.body.code === "insufficient_funds")).toBe(true);
    expect(await t.balance(who.id)).toBe("20000");
    expect(transfers()).toBe(before + 2);
    expect(
      await t.db.query("SELECT 1 FROM payment_intents WHERE user_id = $1", [who.id]),
    ).toHaveLength(2);
  });

  it("lets only one of several withdrawals of the whole balance through", async () => {
    const who = await withMoney("100000");
    const answers = await many(10, () => withdraw(who, "100000"));
    expect(answers.filter((a) => a.status === 200)).toHaveLength(1);
    expect(await t.balance(who.id)).toBe("0");
  });

  it("never lets the wallet go below nothing, whatever mix of amounts arrives", async () => {
    const who = await withMoney("100000");
    const amounts = ["30000", "30000", "30000", "30000", "25000", "10000", "10000", "5000", "1"];
    await many(amounts.length, (i) => withdraw(who, amounts[i]!));
    expect(Number(await t.balance(who.id))).toBeGreaterThanOrEqual(0);
    const held = await t.db.query(
      "SELECT coalesce(sum(amount), 0)::text AS total FROM payment_intents WHERE user_id = $1 AND status = 'pending'",
      [who.id],
    );
    expect(Number(held[0].total) + Number(await t.balance(who.id))).toBe(100000);
  });

  it("holds the money once and asks the bank once when the same withdrawal is sent ten times at once", async () => {
    const who = await withMoney("100000");
    const k = key();
    const before = transfers();
    const answers = await many(10, () => withdraw(who, "40000", k));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(new Set(answers.map((a) => a.body.id)).size).toBe(1);
    expect(transfers()).toBe(before + 1);
    expect(await t.balance(who.id)).toBe("60000");
  });

  it("lets two people withdraw at the same time without touching each other's money", async () => {
    const a = await withMoney("50000");
    const b = await withMoney("50000");
    const [a1, b1, a2, b2] = await Promise.all([
      withdraw(a, "50000"),
      withdraw(b, "50000"),
      withdraw(a, "1"),
      withdraw(b, "1"),
    ]);
    // Each person's money pays for exactly one of their two requests (the whole, or the one unit),
    // whichever got there first, and never for both.
    expect([a1, a2].filter((r) => r.status === 200)).toHaveLength(1);
    expect([b1, b2].filter((r) => r.status === 200)).toHaveLength(1);
    expect(await t.balance(a.id)).toBe(a1.status === 200 ? "0" : "49999");
    expect(await t.balance(b.id)).toBe(b1.status === 200 ? "0" : "49999");
  });
});

describe("money arriving while money leaves", () => {
  it("ends in one consistent state, whichever of the credit and the withdrawal gets there first", async () => {
    for (let round = 0; round < 6; round++) {
      const who = await t.ready();
      await t.payoutAccount(who);
      const funding = await t.seedFunding(who.id, "50000");
      const [credit, out] = await Promise.all([
        t.deliver([
          t.event({
            kind: "funding.succeeded",
            reference: funding.reference,
            amount: "50000",
            currency: "NGN",
          }),
        ]),
        withdraw(who, "50000"),
      ]);
      expect(credit.status).toBe(200);
      expect([200, 422]).toContain(out.status);
      // Credited once, and either paid out (nothing left) or refused (everything left).
      expect(await t.balance(who.id)).toBe(out.status === 200 ? "0" : "50000");
      expect(await t.postings(`funding:${funding.id}`)).toHaveLength(1);
    }
  });
});

describe("the bank's answers racing each other", () => {
  it("returns a failed withdrawal's money exactly once when the check-up and many webhooks all say so", async () => {
    const who = await withMoney("100000");
    t.fake("NG").behaviour.transfer = "unavailable";
    const res = await withdraw(who, "40000").expect(200);
    const [{ reference }] = await t.db.query(
      "SELECT reference FROM payment_intents WHERE id = $1",
      [res.body.id],
    );
    t.fake("NG").behaviour.transfers.set(reference, "failed");
    await t.db.query(
      "UPDATE payment_intents SET updated_at = now() - interval '10 minutes' WHERE id = $1",
      [res.body.id],
    );

    await Promise.all([
      ...Array.from({ length: 6 }, () => who.call("get", `/payments/${res.body.id}`)),
      ...Array.from({ length: 6 }, () =>
        t.deliver([t.event({ kind: "payout.failed", reference })]),
      ),
      ...Array.from({ length: 3 }, () =>
        t.deliver([t.event({ kind: "payout.reversed", reference })]),
      ),
    ]);
    expect(await t.balance(who.id)).toBe("100000");
    expect(await t.postings(`withdrawal-reversal:${res.body.id}`)).toHaveLength(1);
    expect((await t.intent(res.body.id)).status).toBe("failed");
  });

  it("settles or returns, never both, when a paid and a failed answer arrive at the same instant", async () => {
    for (let round = 0; round < 5; round++) {
      const who = await withMoney("100000");
      t.fake("NG").behaviour.transfer = "unavailable";
      const res = await withdraw(who, "40000").expect(200);
      const [{ reference }] = await t.db.query(
        "SELECT reference FROM payment_intents WHERE id = $1",
        [res.body.id],
      );
      await Promise.all([
        ...Array.from({ length: 4 }, () =>
          t.deliver([t.event({ kind: "payout.succeeded", reference })]),
        ),
        ...Array.from({ length: 4 }, () =>
          t.deliver([t.event({ kind: "payout.failed", reference })]),
        ),
      ]);
      const status = (await t.intent(res.body.id)).status;
      expect(["succeeded", "failed"]).toContain(status);
      expect(await t.balance(who.id)).toBe(status === "succeeded" ? "60000" : "100000");
      const settled = (await t.postings(`withdrawal-settled:${res.body.id}`)).length;
      const returned = (await t.postings(`withdrawal-reversal:${res.body.id}`)).length;
      expect(settled + returned).toBe(1);
    }
  });
});
