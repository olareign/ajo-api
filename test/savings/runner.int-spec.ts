import type { NestExpressApplication } from "@nestjs/platform-express";
import { Scheduler } from "../../src/scheduler/scheduler.service.js";
import { createTestApp } from "../support/test-app.js";
import { savingsHarness } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof savingsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  h = savingsHarness(app);
});
afterAll(async () => {
  await app?.close();
});
afterEach(async () => h.t.expectBooksBalance());

const many = <T>(n: number, make: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => make(i)));

describe("taking a debit from the wallet", () => {
  it("moves the money from the wallet into the plan, marks the debit paid and tells the person", async () => {
    const who = await h.saver("2000000");
    const plan = await h.plan(who, { totalDebits: 4 });
    await h.makeDue(plan.id, 1);
    await h.runner.runDue();
    expect(await h.t.balance(who.id)).toBe("1500000");
    expect(await h.saved(who.id, plan.id)).toBe("500000");
    expect((await h.debits(plan.id)).map((d: { status: string }) => d.status)).toEqual([
      "paid",
      "scheduled",
      "scheduled",
      "scheduled",
    ]);
    const detail = (await who.call("get", `/savings/${plan.id}`).expect(200)).body;
    expect(detail).toMatchObject({ paidDebits: 1, saved: { amount: "500000" } });
    expect(detail.history[0]).toMatchObject({
      type: "savings_debit",
      direction: "in",
      amount: { amount: "500000" },
    });
    expect(
      (await h.notices(who.id)).some((n: { kind: string }) => n.kind === "plan.debit_paid"),
    ).toBe(true);
  });

  it("takes each debit once, however many sweeps race for it", async () => {
    const who = await h.saver("2000000");
    const plan = await h.plan(who, { totalDebits: 4 });
    await h.makeDue(plan.id, 2);
    await many(8, () => h.runner.runDue());
    expect(await h.saved(who.id, plan.id)).toBe("1000000");
    expect(await h.t.balance(who.id)).toBe("1000000");
    const postings = await h.t.db.query(
      "SELECT count(*)::int AS n FROM ledger_transactions WHERE idempotency_key LIKE 'savings-debit:%' AND reference = $1",
      [`plan:${plan.id}`],
    );
    expect(postings[0].n).toBe(2);
  });

  it("leaves a debit alone that is not due yet, or whose plan is paused", async () => {
    const who = await h.saver("2000000");
    const later = await h.plan(who, { startDate: h.inDays(5) });
    await h.runner.runDue();
    expect(await h.saved(who.id, later.id)).toBe("0");

    const paused = await h.plan(who);
    await who.call("post", `/savings/${paused.id}/pause`).expect(200);
    await h.makeDue(paused.id);
    await h.runner.runDue();
    expect(await h.saved(who.id, paused.id)).toBe("0");
    expect(await h.t.balance(who.id)).toBe("2000000");
  });

  it("runs from the shared scheduler too", async () => {
    const who = await h.saver("2000000");
    const plan = await h.plan(who);
    await h.makeDue(plan.id, 1);
    const scheduler = app.get(Scheduler);
    await scheduler.release();
    await scheduler.run(["savings"]);
    expect(await h.saved(who.id, plan.id)).toBe("500000");
  });

  it("finishes the plan after the last debit: everything saved comes back to the wallet, once", async () => {
    const who = await h.saver("2500000");
    const plan = await h.plan(who, { totalDebits: 3 });
    await h.makeDue(plan.id);
    await many(5, () => h.runner.runDue());
    const detail = (await who.call("get", `/savings/${plan.id}`).expect(200)).body;
    expect(detail).toMatchObject({
      status: "completed",
      paidDebits: 3,
      payout: { amount: "1500000" },
      saved: { amount: "0" },
      nextDebit: null,
    });
    expect(await h.t.balance(who.id)).toBe("2500000");
    const payouts = await h.t.db.query(
      "SELECT count(*)::int AS n FROM ledger_transactions WHERE idempotency_key = $1",
      [`savings-maturity:${plan.id}`],
    );
    expect(payouts[0].n).toBe(1);
    expect(
      (await h.notices(who.id)).filter((n: { kind: string }) => n.kind === "plan.matured"),
    ).toHaveLength(1);
    await who.call("post", `/savings/${plan.id}/pause`).expect(409);
  });
});

describe("when the wallet is short", () => {
  it("tries again tomorrow, tells the person to add money, and takes it once they have", async () => {
    const who = await h.saver("100000");
    const plan = await h.plan(who);
    await h.makeDue(plan.id, 1);
    await h.runner.runDue();
    let [first] = await h.debits(plan.id);
    expect(first).toMatchObject({
      status: "scheduled",
      attempts: 1,
      note: "Not enough in your wallet",
    });
    expect(new Date(first.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const short = (await h.notices(who.id)).find(
      (n: { kind: string }) => n.kind === "plan.debit_short",
    );
    expect(short).toMatchObject({ email_status: "pending" });

    // The same pass again changes nothing: it is not due until tomorrow.
    await h.runner.runDue();
    [first] = await h.debits(plan.id);
    expect(first.attempts).toBe(1);

    await h.t.giveMoney(who.id, "500000");
    await h.makeDue(plan.id, 1);
    await h.runner.runDue();
    expect((await h.debits(plan.id))[0]).toMatchObject({ status: "paid" });
    expect(await h.saved(who.id, plan.id)).toBe("500000");
  });

  it("gives up on that debit after three misses, says so, and carries on with the rest", async () => {
    const who = await h.saver("0");
    const plan = await h.plan(who, { totalDebits: 3 });
    for (let pass = 0; pass < 4; pass += 1) {
      await h.makeDue(plan.id, 1);
      await h.runner.runDue();
    }
    const rows = await h.debits(plan.id);
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(rows[1]).toMatchObject({ status: "scheduled", attempts: 0 });
    const kinds = (await h.notices(who.id)).map((n: { kind: string }) => n.kind);
    expect(kinds).toContain("plan.debit_missed");
    expect((await who.call("get", `/savings/${plan.id}`).expect(200)).body).toMatchObject({
      failedDebits: 1,
      status: "active",
    });
  });

  it("closes a plan whose every debit was missed, with nothing to pay out", async () => {
    const who = await h.saver("0");
    const plan = await h.plan(who, { totalDebits: 2 });
    for (let pass = 0; pass < 8; pass += 1) {
      await h.makeDue(plan.id);
      await h.runner.runDue();
    }
    const detail = (await who.call("get", `/savings/${plan.id}`).expect(200)).body;
    expect(detail).toMatchObject({ status: "completed", failedDebits: 2, payout: { amount: "0" } });
  });

  it("gives up on a debit that has been waiting more than five days past its day", async () => {
    const who = await h.saver("0");
    const plan = await h.plan(who, { totalDebits: 2 });
    await h.t.db.query(
      "UPDATE savings_debits SET due_on = (now() - interval '9 days')::date, next_attempt_at = now() - interval '1 minute' WHERE plan_id = $1 AND seq = 1",
      [plan.id],
    );
    await h.runner.runDue();
    expect((await h.debits(plan.id))[0]).toMatchObject({ status: "failed" });
  });
});

describe("topping up from the bank", () => {
  it("collects only what is missing, once, waits for the bank without counting it as a miss, and takes the debit when the money lands", async () => {
    const who = await h.saver("200000");
    await h.activeMandate(who.id);
    const plan = await who
      .call("post", "/savings")
      .set("Idempotency-Key", `k_${Math.random().toString(36).slice(2)}_x`)
      .send(h.body({ topupFromBank: true }))
      .expect(201);
    const fake = h.t.fake("NG");
    const before = fake.count("chargeMandate");
    await h.makeDue(plan.body.id, 1);
    await h.runner.runDue();
    expect(fake.count("chargeMandate")).toBe(before + 1);
    const call = fake.calls.filter(([m]) => m === "chargeMandate").at(-1)![1] as {
      amount: string;
      authorizationCode: string;
    };
    expect(call.amount).toBe("300000"); // 500000 due, 200000 in the wallet
    const [waiting] = await h.debits(plan.body.id);
    expect(waiting).toMatchObject({
      status: "scheduled",
      attempts: 1,
      note: "Collecting from your bank",
    });
    expect(waiting.topup_intent_id).toEqual(expect.any(String));

    // Looking again while the bank is still collecting does not ask it twice, or count a miss.
    await h.makeDue(plan.body.id, 1);
    await Promise.all([h.runner.runDue(), h.runner.runDue(), h.runner.runDue()]);
    expect(fake.count("chargeMandate")).toBe(before + 1);
    expect((await h.debits(plan.body.id))[0]).toMatchObject({
      attempts: 1,
      note: "Waiting for your bank",
    });

    // The bank pays: the wallet is credited once (however many times we are told), then the debit is taken.
    const [intent] = await h.t.db.query("SELECT id, reference FROM payment_intents WHERE id = $1", [
      waiting.topup_intent_id,
    ]);
    const paid = h.t.event({
      kind: "funding.succeeded",
      reference: intent.reference,
      amount: "300000",
      currency: "NGN",
    });
    await h.t.deliver([paid]).expect(200);
    await h.t.deliver([paid]).expect(200);
    expect(await h.t.balance(who.id)).toBe("500000");
    await h.makeDue(plan.body.id, 1);
    await h.runner.runDue();
    expect((await h.debits(plan.body.id))[0]).toMatchObject({ status: "paid" });
    expect(await h.saved(who.id, plan.body.id)).toBe("500000");
    expect(await h.t.balance(who.id)).toBe("0");
  });

  it("counts a refused collection as a miss and tries again tomorrow", async () => {
    const who = await h.saver("0");
    await h.activeMandate(who.id);
    const plan = await who
      .call("post", "/savings")
      .set("Idempotency-Key", `k_${Math.random().toString(36).slice(2)}_y`)
      .send(h.body({ topupFromBank: true }))
      .expect(201);
    const fake = h.t.fake("NG");
    fake.behaviour.initialize = "reject";
    try {
      await h.makeDue(plan.body.id, 1);
      await h.runner.runDue();
      const [intent] = await h.t.db.query(
        "SELECT status FROM payment_intents WHERE id = (SELECT topup_intent_id FROM savings_debits WHERE plan_id = $1 AND seq = 1)",
        [plan.body.id],
      );
      expect(intent.status).toBe("failed");
      // The failed collection is no longer in flight: the next pass counts it and asks again.
      await h.makeDue(plan.body.id, 1);
      await h.runner.runDue();
      const [debit] = await h.debits(plan.body.id);
      expect(debit.attempts).toBe(2);
    } finally {
      fake.behaviour.initialize = "ok";
    }
  });

  it("finishes noting a collection it had started, without collecting again", async () => {
    const who = await h.saver("0");
    await h.activeMandate(who.id);
    const plan = await who
      .call("post", "/savings")
      .set("Idempotency-Key", `k_${Math.random().toString(36).slice(2)}_z`)
      .send(h.body({ topupFromBank: true }))
      .expect(201);
    const fake = h.t.fake("NG");
    await h.makeDue(plan.body.id, 1);
    await h.runner.runDue();
    const [started] = await h.debits(plan.body.id);
    // Pretend we crashed before writing the payment's id on the debit.
    await h.t.db.query(
      "UPDATE savings_debits SET topup_intent_id = NULL WHERE plan_id = $1 AND seq = 1",
      [plan.body.id],
    );
    const asked = fake.count("chargeMandate");
    await h.makeDue(plan.body.id, 1);
    await h.runner.runDue();
    expect(fake.count("chargeMandate")).toBe(asked);
    const [resumed] = await h.debits(plan.body.id);
    expect(resumed.topup_intent_id).toBe(started.topup_intent_id);
    const pulls = await h.t.db.query(
      "SELECT count(*)::int AS n FROM payment_intents WHERE user_id = $1 AND method = 'direct_debit'",
      [who.id],
    );
    expect(pulls[0].n).toBe(1);
  });
});

describe("reminders", () => {
  it("tells people the day before, and by email only when their wallet will not cover it, once", async () => {
    const covered = await h.saver("2000000");
    const short = await h.saver("0");
    const a = await h.plan(covered);
    const b = await h.plan(short);
    for (const p of [a, b]) {
      await h.t.db.query(
        "UPDATE savings_debits SET next_attempt_at = now() + interval '12 hours' WHERE plan_id = $1 AND seq = 1",
        [p.id],
      );
    }
    await h.runner.remindUpcoming();
    await h.runner.remindUpcoming();
    const soon = (id: string) =>
      h
        .notices(id)
        .then((rows: { kind: string; email_status: string }[]) =>
          rows.filter((n) => n.kind === "plan.debit_soon"),
        );
    expect(await soon(covered.id)).toMatchObject([{ email_status: "none" }]);
    expect(await soon(short.id)).toMatchObject([{ email_status: "pending" }]);
  });
});
