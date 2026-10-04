import type { NestExpressApplication } from "@nestjs/platform-express";
import { Scheduler } from "../../src/scheduler/scheduler.service.js";
import { WebhookInbox } from "../../src/payments/webhook-inbox.service.js";
import { createTestApp } from "../support/test-app.js";
import { paymentsHarness } from "./support.js";

let app: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;
let scheduler: Scheduler;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  t = paymentsHarness(app);
  scheduler = app.get(Scheduler);
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await scheduler.release();
});
afterEach(async () => t.expectBooksBalance());

const makeStale = async (id: string) => {
  await t.db.query(
    "UPDATE payment_intents SET updated_at = now() - interval '10 minutes' WHERE id = $1",
    [id],
  );
  // Other tests share this database and leave pending payments behind; a pass only looks at the oldest few.
  await t.db.query(
    "UPDATE payment_intents SET updated_at = now() WHERE status = 'pending' AND id <> $1",
    [id],
  );
};

describe("the scheduled sweep of payments", () => {
  it("settles a payment the partner confirmed but whose webhook never came, once, however many sweeps race", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "300000");
    await makeStale(funding.id);
    t.fake("NG").behaviour.paid.set(funding.reference, {
      status: "success",
      amount: "300000",
      currency: "NGN",
    });

    // Several copies of the API ticking at once: the lock lets one through, and the claims in the
    // database make a second pass harmless even if the lock were lost.
    const passes = await Promise.all(Array.from({ length: 6 }, () => scheduler.run()));
    expect(passes.filter(Boolean)).toHaveLength(1);
    expect(await t.balance(who.id)).toBe("300000");

    await scheduler.release();
    await Promise.all(Array.from({ length: 4 }, () => scheduler.run()));
    expect(await t.balance(who.id)).toBe("300000");
    expect(await t.postings(`funding:${funding.id}`)).toHaveLength(1);
  });

  it("leaves a payment alone that is still fresh", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "100000");
    t.fake("NG").behaviour.paid.set(funding.reference, {
      status: "success",
      amount: "100000",
      currency: "NGN",
    });
    await scheduler.run();
    expect(await t.balance(who.id)).toBe("0");
    expect((await t.intent(funding.id)).status).toBe("pending");
  });

  it("retries a held partner message when it is next drained", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "200000");
    const held = t.event({
      kind: "funding.succeeded",
      reference: funding.reference,
      amount: "200000",
      currency: "NGN",
    });
    await t.db.query(
      `INSERT INTO webhook_events (provider, event_id, kind, type, payload, status, attempts, last_error)
       VALUES ('fake', $1, $2, $3, $4, 'failed', 1, 'The partner was not reachable.')`,
      [held.eventId, held.kind, held.type, JSON.stringify(held)],
    );
    await scheduler.run();
    expect(await t.balance(who.id)).toBe("200000");
    expect((await t.inbox(held.eventId))[0].status).toBe("processed");
  });

  it("does not let a failing task stop the next one, or the next pass", async () => {
    const ran: string[] = [];
    scheduler.register({ name: "boom", run: () => Promise.reject(new Error("boom")) });
    scheduler.register({ name: "after", run: async () => void ran.push("after") });
    const drain = vi.spyOn(app.get(WebhookInbox), "drain").mockRejectedValueOnce(new Error("boom"));
    expect(await scheduler.run()).toBe(true);
    expect(ran).toEqual(["after"]);
    await scheduler.release();
    expect(await scheduler.run()).toBe(true);
    expect(drain).toHaveBeenCalledTimes(2);
    drain.mockRestore();
  });
});
