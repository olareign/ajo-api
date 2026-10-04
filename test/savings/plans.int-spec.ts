import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { createTestApp } from "../support/test-app.js";
import { key, savingsHarness } from "./support.js";

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

describe("making a plan", () => {
  it("shows the days and the total first, and saves nothing", async () => {
    const who = await h.saver();
    const preview = await who
      .call("post", "/savings/preview")
      .send(h.body({ frequency: "monthly", totalDebits: 3, startDate: h.inDays(2) }))
      .expect(200);
    expect(preview.body.dates).toHaveLength(3);
    expect(preview.body.total).toEqual({ amount: "1500000", currency: "NGN" });
    expect(preview.body.endDate).toBe(preview.body.dates[2]);
    expect((await who.call("get", "/savings").expect(200)).body.plans).toEqual([]);
  });

  it("makes the plan, one row for each debit, its own ledger account, and tells the person", async () => {
    const who = await h.saver();
    const made = await h.plan(who, { totalDebits: 4, startDate: h.inDays(1) });
    expect(made.schedule).toHaveLength(4);
    expect(made.schedule.every((d) => d.status === "scheduled")).toBe(true);
    const detail = (await who.call("get", `/savings/${made.id}`).expect(200)).body;
    expect(detail).toMatchObject({
      name: "Rent",
      status: "active",
      frequency: "weekly",
      amount: { amount: "500000", currency: "NGN" },
      target: { amount: "2000000", currency: "NGN" },
      saved: { amount: "0", currency: "NGN" },
      paidDebits: 0,
      nextDebit: { dueOn: h.inDays(1) },
    });
    expect(detail.endDate).toBe(h.inDays(22));
    expect((await h.notices(who.id)).map((n: { kind: string }) => n.kind)).toContain(
      "plan.created",
    );
    expect(await h.saved(who.id, made.id)).toBe("0");
  });

  it("makes one plan however many times the same request is sent, even all at once", async () => {
    const who = await h.saver();
    const k = key();
    const sends = await Promise.all(
      Array.from({ length: 8 }, () =>
        who.call("post", "/savings").set("Idempotency-Key", k).send(h.body()),
      ),
    );
    expect(sends.every((r) => r.status === 201)).toBe(true);
    expect(new Set(sends.map((r) => r.body.id)).size).toBe(1);
    expect((await who.call("get", "/savings").expect(200)).body.plans).toHaveLength(1);
    const clash = await who
      .call("post", "/savings")
      .set("Idempotency-Key", k)
      .send(h.body({ amount: "600000" }));
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("idempotency_key_reused");
  });

  it("will not let someone have more than ten going, even by making them all at once", async () => {
    const who = await h.saver();
    const sends = await Promise.all(
      Array.from({ length: 13 }, (_, i) =>
        who
          .call("post", "/savings")
          .set("Idempotency-Key", key())
          .send(h.body({ name: `Plan ${i}` })),
      ),
    );
    expect(sends.filter((r) => r.status === 201)).toHaveLength(10);
    expect(
      sends.filter((r) => r.status === 409).every((r) => r.body.code === "too_many_plans"),
    ).toBe(true);
    expect((await who.call("get", "/savings").expect(200)).body.plans).toHaveLength(10);
  });

  it.each([
    ["a start date in the past", { startDate: "2020-01-01" }],
    ["an amount that is too small", { amount: "100" }],
    ["one debit only", { totalDebits: 1 }],
    ["a nameless plan", { name: "  " }],
    ["a frequency we do not have", { frequency: "hourly" }],
    ["a stray field", { userId: "someone-else" }],
  ])("refuses %s, and makes nothing", async (_name, over) => {
    const who = await h.saver();
    const res = await who.call("post", "/savings").set("Idempotency-Key", key()).send(h.body(over));
    expect(res.status).toBe(400);
    expect((await who.call("get", "/savings").expect(200)).body.plans).toEqual([]);
  });

  it("asks for an idempotency key, identity checks and a signed-in person", async () => {
    const who = await h.saver();
    const noKey = await who.call("post", "/savings").send(h.body());
    expect([400]).toContain(noKey.status);
    expect(noKey.body.code).toBe("idempotency_key_required");

    const unverified = await h.t.ready("NG", { mfa: false, kyc: false });
    const blocked = await unverified
      .call("post", "/savings")
      .set("Idempotency-Key", key())
      .send(h.body());
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("kyc_required");

    await request(h.t.http()).post("/api/v1/savings").send(h.body()).expect(401);
    await request(h.t.http()).get("/api/v1/savings").expect(401);
  });

  it("will not collect from the bank for a plan unless auto-debit is on", async () => {
    const who = await h.saver();
    const res = await who
      .call("post", "/savings")
      .set("Idempotency-Key", key())
      .send(h.body({ topupFromBank: true }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_mandate");
    await h.activeMandate(who.id);
    await who
      .call("post", "/savings")
      .set("Idempotency-Key", key())
      .send(h.body({ topupFromBank: true }))
      .expect(201);
  });

  it("shows only your own plans, and says nothing exists for anyone else's", async () => {
    const mine = await h.saver();
    const theirs = await h.saver();
    const plan = await h.plan(theirs);
    expect((await mine.call("get", "/savings").expect(200)).body.plans).toEqual([]);
    await mine.call("get", `/savings/${plan.id}`).expect(404);
    await mine.call("post", `/savings/${plan.id}/pause`).expect(404);
    await mine
      .call("post", `/savings/${plan.id}/topup`)
      .set("Idempotency-Key", key())
      .send({ amount: "10000" })
      .expect(404);
    await mine.call("post", `/savings/${plan.id}/withdraw`).send({ pin: "493817" }).expect(404);
    await mine.call("get", "/savings/not-a-uuid").expect(400);
  });

  it("keeps the mandate from being cancelled while a plan depends on it, and frees it when the plan ends", async () => {
    const who = await h.saver("2000000");
    await h.activeMandate(who.id);
    const plan = await who
      .call("post", "/savings")
      .set("Idempotency-Key", key())
      .send(h.body({ topupFromBank: true }))
      .expect(201);
    const cancel = await who.call("delete", "/payments/mandate");
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe("active_commitments");
    await who.call("post", `/savings/${plan.body.id}/withdraw`).send({ pin: "493817" }).expect(200);
    await who.call("delete", "/payments/mandate").expect(200);
  });
});
