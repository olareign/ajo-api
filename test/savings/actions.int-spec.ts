import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "../support/test-app.js";
import { key, PIN, savingsHarness } from "./support.js";

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

describe("pausing and resuming", () => {
  it("stops the debits, says so twice the same, and starts them again with late ones moved to today", async () => {
    const who = await h.saver("3000000");
    const plan = await h.plan(who, { totalDebits: 4, startDate: h.inDays(0) });
    await who.call("post", `/savings/${plan.id}/pause`).expect(200);
    const again = await who.call("post", `/savings/${plan.id}/pause`).expect(200);
    expect(again.body.status).toBe("paused");
    // The plan sat paused while its first two debits' days went by.
    await h.t.db.query(
      `UPDATE savings_debits SET due_on = due_on - 10, next_attempt_at = now() - interval '10 days' WHERE plan_id = $1`,
      [plan.id],
    );
    await h.runner.runDue();
    expect(await h.saved(who.id, plan.id)).toBe("0");

    const resumed = (await who.call("post", `/savings/${plan.id}/resume`).expect(200)).body;
    expect(resumed.status).toBe("active");
    expect(resumed.nextDebit.dueOn).toBe(h.inDays(0));
    expect(resumed.schedule.map((d: { dueOn: string }) => d.dueOn)).toEqual([
      h.inDays(0),
      h.inDays(7),
      h.inDays(14),
      h.inDays(21),
    ]);
    await who.call("post", `/savings/${plan.id}/resume`).expect(200);
  });

  it("does not let an ended plan be paused or resumed", async () => {
    const who = await h.saver("3000000");
    const plan = await h.plan(who);
    await who.call("post", `/savings/${plan.id}/withdraw`).send({ pin: PIN }).expect(200);
    const res = await who.call("post", `/savings/${plan.id}/pause`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("plan_closed");
    await who.call("post", `/savings/${plan.id}/resume`).expect(409);
  });
});

describe("topping up", () => {
  it("moves money from the wallet into the plan now, once for one key, even when sent together", async () => {
    const who = await h.saver("1000000");
    const plan = await h.plan(who);
    const k = key();
    const sends = await many(6, () =>
      who
        .call("post", `/savings/${plan.id}/topup`)
        .set("Idempotency-Key", k)
        .send({ amount: "300000" }),
    );
    expect(sends.every((r) => r.status === 200)).toBe(true);
    expect(await h.saved(who.id, plan.id)).toBe("300000");
    expect(await h.t.balance(who.id)).toBe("700000");
    const detail = (await who.call("get", `/savings/${plan.id}`).expect(200)).body;
    expect(detail.history[0]).toMatchObject({ type: "savings_topup", direction: "in" });
    // A new key is a new top-up.
    await who
      .call("post", `/savings/${plan.id}/topup`)
      .set("Idempotency-Key", key())
      .send({ amount: "100000" })
      .expect(200);
    expect(await h.saved(who.id, plan.id)).toBe("400000");
  });

  it("will not take more than the wallet holds, however many are sent at once", async () => {
    const who = await h.saver("500000");
    const plan = await h.plan(who);
    const sends = await many(6, () =>
      who
        .call("post", `/savings/${plan.id}/topup`)
        .set("Idempotency-Key", key())
        .send({ amount: "300000" }),
    );
    expect(sends.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      sends.filter((r) => r.status === 409).every((r) => r.body.code === "insufficient_funds"),
    ).toBe(true);
    expect(await h.t.balance(who.id)).toBe("200000");
    expect(await h.saved(who.id, plan.id)).toBe("300000");
  });

  it("asks for a key, and refuses nonsense and ended plans", async () => {
    const who = await h.saver("1000000");
    const plan = await h.plan(who);
    expect(
      (await who.call("post", `/savings/${plan.id}/topup`).send({ amount: "300000" })).body.code,
    ).toBe("idempotency_key_required");
    await who
      .call("post", `/savings/${plan.id}/topup`)
      .set("Idempotency-Key", key())
      .send({ amount: "0" })
      .expect(400);
    await who
      .call("post", `/savings/${plan.id}/topup`)
      .set("Idempotency-Key", key())
      .send({ amount: "10" })
      .expect(400);
    await who.call("post", `/savings/${plan.id}/withdraw`).send({ pin: PIN }).expect(200);
    await who
      .call("post", `/savings/${plan.id}/topup`)
      .set("Idempotency-Key", key())
      .send({ amount: "300000" })
      .expect(409);
  });
});

describe("ending a plan early", () => {
  it("checks the PIN first, and moves nothing when it is wrong", async () => {
    const who = await h.saver("1000000");
    const plan = await h.plan(who);
    await who
      .call("post", `/savings/${plan.id}/topup`)
      .set("Idempotency-Key", key())
      .send({ amount: "400000" })
      .expect(200);
    const wrong = await who.call("post", `/savings/${plan.id}/withdraw`).send({ pin: "000000" });
    expect(wrong.status).toBe(422);
    expect(await h.saved(who.id, plan.id)).toBe("400000");
    expect((await who.call("get", `/savings/${plan.id}`).expect(200)).body.status).toBe("active");
    await who.call("post", `/savings/${plan.id}/withdraw`).send({ pin: "12" }).expect(400);
  });

  it("brings everything saved back to the wallet, skips the debits still to come, and says so by email", async () => {
    const who = await h.saver("2000000");
    const plan = await h.plan(who, { totalDebits: 4 });
    await h.makeDue(plan.id, 1);
    await h.runner.runDue();
    const ended = (
      await who.call("post", `/savings/${plan.id}/withdraw`).send({ pin: PIN }).expect(200)
    ).body;
    expect(ended).toMatchObject({
      status: "cancelled",
      saved: { amount: "0" },
      payout: { amount: "500000" },
      penalty: { amount: "0" },
      nextDebit: null,
    });
    expect(await h.t.balance(who.id)).toBe("2000000");
    expect(ended.schedule.map((d: { status: string }) => d.status)).toEqual([
      "paid",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(
      (await h.notices(who.id)).find((n: { kind: string }) => n.kind === "plan.ended_early"),
    ).toMatchObject({
      email_status: "pending",
    });
    // Nothing more is ever taken from it.
    await h.makeDue(plan.id);
    await h.runner.runDue();
    expect(await h.t.balance(who.id)).toBe("2000000");
  });

  it("ends a plan with nothing saved without moving anything, and ending it again changes nothing", async () => {
    const who = await h.saver("100000");
    const plan = await h.plan(who);
    const first = await who
      .call("post", `/savings/${plan.id}/withdraw`)
      .send({ pin: PIN })
      .expect(200);
    const second = await who
      .call("post", `/savings/${plan.id}/withdraw`)
      .send({ pin: PIN })
      .expect(200);
    expect(first.body.status).toBe("cancelled");
    expect(second.body.closedAt).toBe(first.body.closedAt);
    expect(await h.t.balance(who.id)).toBe("100000");
  });

  it("pays out once however many requests arrive together", async () => {
    const who = await h.saver("1000000");
    const plan = await h.plan(who);
    await who
      .call("post", `/savings/${plan.id}/topup`)
      .set("Idempotency-Key", key())
      .send({ amount: "600000" })
      .expect(200);
    const sends = await many(8, () =>
      who.call("post", `/savings/${plan.id}/withdraw`).send({ pin: PIN }),
    );
    expect(sends.every((r) => r.status === 200)).toBe(true);
    expect(await h.t.balance(who.id)).toBe("1000000");
    const closes = await h.t.db.query(
      "SELECT count(*)::int AS n FROM ledger_transactions WHERE idempotency_key = $1",
      [`savings-close:${plan.id}`],
    );
    expect(closes[0].n).toBe(1);
  });
});

describe("races between the clock and the person", () => {
  it("never loses or doubles money when a debit, a top-up and ending the plan all happen together", async () => {
    for (let round = 0; round < 4; round += 1) {
      const who = await h.saver("3000000");
      const plan = await h.plan(who, { totalDebits: 4 });
      await h.makeDue(plan.id);
      await Promise.all([
        h.runner.runDue(),
        h.runner.runDue(),
        who
          .call("post", `/savings/${plan.id}/topup`)
          .set("Idempotency-Key", key())
          .send({ amount: "200000" }),
        who.call("post", `/savings/${plan.id}/withdraw`).send({ pin: PIN }),
        h.runner.runDue(),
      ]);
      const detail = (await who.call("get", `/savings/${plan.id}`).expect(200)).body;
      // However it interleaved, the person's money is all accounted for: wallet plus plan is what they started with.
      const inPlan = BigInt(await h.saved(who.id, plan.id));
      expect(BigInt(await h.t.balance(who.id)) + inPlan).toBe(3_000_000n);
      if (detail.status === "cancelled") {
        expect(inPlan).toBe(0n);
        const stillScheduled = (await h.debits(plan.id)).filter(
          (d: { status: string }) => d.status === "scheduled",
        );
        expect(stillScheduled).toHaveLength(0);
      }
    }
  });

  it("does not take a debit from a plan the moment it is paused", async () => {
    const who = await h.saver("3000000");
    const plan = await h.plan(who, { totalDebits: 4 });
    await h.makeDue(plan.id);
    await Promise.all([
      who.call("post", `/savings/${plan.id}/pause`),
      h.runner.runDue(),
      h.runner.runDue(),
    ]);
    const paidBefore = (await h.debits(plan.id)).filter(
      (d: { status: string }) => d.status === "paid",
    ).length;
    await h.runner.runDue();
    const paidAfter = (await h.debits(plan.id)).filter(
      (d: { status: string }) => d.status === "paid",
    ).length;
    expect(paidAfter).toBe(paidBefore);
    expect(BigInt(await h.t.balance(who.id)) + BigInt(await h.saved(who.id, plan.id))).toBe(
      3_000_000n,
    );
  });

  it("lets two debits and a withdrawal from the wallet compete for one balance without overdrawing it", async () => {
    const who = await h.saver("700000");
    await h.activeMandate(who.id);
    const a = await h.plan(who);
    const b = await h.plan(who, { name: "Fees" });
    await h.makeDue(a.id, 1);
    await h.makeDue(b.id, 1);
    await Promise.all([h.runner.runDue(), h.runner.runDue(), h.runner.runDue()]);
    const paid = [a, b].map(async (p) => (await h.debits(p.id))[0].status);
    const statuses = await Promise.all(paid);
    expect(statuses.filter((s) => s === "paid")).toHaveLength(1); // only 700000 for 2 x 500000
    expect(await h.t.balance(who.id)).toBe("200000");
  });
});
