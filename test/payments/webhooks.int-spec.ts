import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { WebhookInbox, MAX_ATTEMPTS } from "../../src/payments/webhook-inbox.service.js";
import { createTestApp } from "../support/test-app.js";
import { newIp } from "../support/users.js";
import { paymentsHarness } from "./support.js";

let app: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  t = paymentsHarness(app);
});
afterAll(async () => {
  await app?.close();
});
afterEach(async () => t.expectBooksBalance());

const many = <T>(n: number, make: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => make(i)));

describe("who may talk to the webhook endpoint", () => {
  it("refuses a request with a wrong, missing or altered signature, and stores nothing", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "500000");
    const body = JSON.stringify({
      events: [
        t.event({
          kind: "funding.succeeded",
          reference: funding.reference,
          amount: "500000",
          currency: "NGN",
        }),
      ],
    });
    const post = (signature?: string, payload = body) => {
      const req = request(t.http())
        .post("/api/v1/webhooks/fake")
        .set("Content-Type", "application/json")
        .set("X-Forwarded-For", newIp());
      return (signature ? req.set("X-Fake-Signature", signature) : req).send(payload);
    };
    await post("0".repeat(64)).expect(401);
    await post().expect(401);
    // Signed for one body, delivered with another (even a harmless extra space).
    const { signFakeWebhook } = await import("../../src/payments/providers/fake.provider.js");
    await post(signFakeWebhook(body), `${body} `).expect(401);

    const eventId = (JSON.parse(body) as { events: { eventId: string }[] }).events[0]!.eventId;
    expect(await t.inbox(eventId)).toHaveLength(0);
    expect(await t.balance(who.id)).toBe("0");
  });

  it("does not know a partner that is not connected, or one that does not exist", async () => {
    const post = (name: string) =>
      request(t.http()).post(`/api/v1/webhooks/${name}`).set("X-Forwarded-For", newIp()).send({});
    await post("paystack").expect(404);
    await post("somebody-else").expect(404);
    await post("nobody").expect(404);
  });
});

describe("adding money", () => {
  it("credits the wallet once, from the partner's settlement account, and says so on the payment", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "500000");
    const e = t.event({
      kind: "funding.succeeded",
      reference: funding.reference,
      amount: "500000",
      currency: "NGN",
    });
    const res = await t.deliver([e]).expect(200);
    expect(res.body).toEqual({ received: 1 });

    expect(await t.balance(who.id)).toBe("500000");
    expect(await t.intent(funding.id)).toMatchObject({ status: "succeeded" });
    expect((await t.inbox(e.eventId))[0]).toMatchObject({ status: "processed" });
    expect(await t.postings(`funding:${funding.id}`)).toHaveLength(1);
  });

  it("counts one event delivered twenty-five times at once exactly once", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "120000");
    const e = t.event({
      kind: "funding.succeeded",
      reference: funding.reference,
      amount: "120000",
      currency: "NGN",
    });
    const answers = await many(25, () => t.deliver([e]));
    expect(answers.every((a) => a.status === 200)).toBe(true);

    expect(await t.balance(who.id)).toBe("120000");
    expect(await t.inbox(e.eventId)).toHaveLength(1);
    expect(await t.postings(`funding:${funding.id}`)).toHaveLength(1);
  });

  it("counts a payment once even when the partner sends it as ten different events at once", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "75000");
    const events = Array.from({ length: 10 }, () =>
      t.event({
        kind: "funding.succeeded",
        reference: funding.reference,
        amount: "75000",
        currency: "NGN",
      }),
    );
    await many(10, (i) => t.deliver([events[i]!]));

    expect(await t.balance(who.id)).toBe("75000");
    expect(await t.postings(`funding:${funding.id}`)).toHaveLength(1);
    const rows = await t.db.query(
      "SELECT status, count(*)::int AS n FROM webhook_events WHERE event_id = ANY($1) GROUP BY status",
      [events.map((e) => e.eventId)],
    );
    expect(
      Object.fromEntries(rows.map((r: { status: string; n: number }) => [r.status, r.n])),
    ).toEqual({
      processed: 1,
      ignored: 9,
    });
  });

  it("does not credit an amount or currency other than the one asked for, and flags it for a person", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "500000");
    const less = t.event({
      kind: "funding.succeeded",
      reference: funding.reference,
      amount: "100",
      currency: "NGN",
    });
    const wrongCurrency = t.event({
      kind: "funding.succeeded",
      reference: funding.reference,
      amount: "500000",
      currency: "GBP",
    });
    await t.deliver([less, wrongCurrency]).expect(200);

    expect(await t.balance(who.id)).toBe("0");
    expect(await t.intent(funding.id)).toMatchObject({ status: "pending" });
    for (const e of [less, wrongCurrency]) {
      const [row] = await t.inbox(e.eventId);
      expect(row.status).toBe("failed");
      expect(row.attempts).toBeGreaterThan(MAX_ATTEMPTS);
      expect(row.last_error).toMatch(/Nothing was credited/);
    }
    // A person is flagged, not a loop: draining does not try it again.
    const before = (await t.inbox(less.eventId))[0].attempts;
    await app.get(WebhookInbox).drain();
    expect((await t.inbox(less.eventId))[0].attempts).toBe(before);
  });

  it("stores an event about a payment we have never heard of, and answers 200", async () => {
    const e = t.event({
      kind: "funding.succeeded",
      reference: "ajf_nobody_has_this_one",
      amount: "100",
      currency: "NGN",
    });
    await t.deliver([e]).expect(200);
    expect((await t.inbox(e.eventId))[0]).toMatchObject({ status: "ignored" });
  });

  it("still credits money that arrives after the payment was marked failed", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "30000");
    await t
      .deliver([t.event({ kind: "funding.failed", reference: funding.reference })])
      .expect(200);
    expect(await t.intent(funding.id)).toMatchObject({ status: "failed" });

    await t
      .deliver([
        t.event({
          kind: "funding.succeeded",
          reference: funding.reference,
          amount: "30000",
          currency: "NGN",
        }),
      ])
      .expect(200);
    expect(await t.balance(who.id)).toBe("30000");
    expect(await t.intent(funding.id)).toMatchObject({ status: "succeeded" });
  });

  it("does not take money back because a failure arrives after the success", async () => {
    const who = await t.person();
    const funding = await t.seedFunding(who.id, "30000");
    await t.deliver([
      t.event({
        kind: "funding.succeeded",
        reference: funding.reference,
        amount: "30000",
        currency: "NGN",
      }),
    ]);
    await t
      .deliver([t.event({ kind: "funding.failed", reference: funding.reference })])
      .expect(200);
    expect(await t.balance(who.id)).toBe("30000");
    expect(await t.intent(funding.id)).toMatchObject({ status: "succeeded" });
  });

  it("holds a direct debit back until it is paid out, then credits it once", async () => {
    const who = await t.person("GB");
    const funding = await t.seedFunding(who.id, "5000", {
      method: "direct_debit",
      currency: "GBP",
    });
    const sent = (stage: "confirmed" | "paid_out") =>
      t.event({
        kind: "funding.succeeded",
        reference: funding.reference,
        amount: "5000",
        currency: "GBP",
        stage,
      });
    await t.deliver([sent("confirmed")]).expect(200);
    expect(await t.balance(who.id, "GBP")).toBe("0");
    await many(5, () => t.deliver([sent("paid_out")]));
    expect(await t.balance(who.id, "GBP")).toBe("5000");
    expect(await t.postings(`funding:${funding.id}`)).toHaveLength(1);
  });

  it("credits a bank-to-bank payment as soon as it is confirmed", async () => {
    const who = await t.person("GB");
    const funding = await t.seedFunding(who.id, "2500", { method: "transfer", currency: "GBP" });
    await t.deliver([
      t.event({
        kind: "funding.succeeded",
        reference: funding.reference,
        amount: "2500",
        currency: "GBP",
        stage: "confirmed",
      }),
    ]);
    expect(await t.balance(who.id, "GBP")).toBe("2500");
  });
});

describe("taking money out", () => {
  const setup = async (balance = "100000", amount = "40000") => {
    const who = await t.person();
    await t.giveMoney(who.id, balance);
    const withdrawal = await t.seedWithdrawal(who.id, amount);
    return { who, withdrawal, left: String(Number(balance) - Number(amount)) };
  };

  it("settles a withdrawal once the bank has paid it, and the wallet stays down by that amount", async () => {
    const { who, withdrawal, left } = await setup();
    await t
      .deliver([t.event({ kind: "payout.succeeded", reference: withdrawal.reference })])
      .expect(200);
    expect(await t.balance(who.id)).toBe(left);
    expect(await t.intent(withdrawal.id)).toMatchObject({ status: "succeeded" });
    expect(await t.postings(`withdrawal-settled:${withdrawal.id}`)).toHaveLength(1);
  });

  it("gives the money back exactly once when a failure is delivered twenty times at once", async () => {
    const { who, withdrawal } = await setup();
    const e = t.event({ kind: "payout.failed", reference: withdrawal.reference });
    await many(20, () => t.deliver([e]));
    await many(10, () =>
      t.deliver([t.event({ kind: "payout.failed", reference: withdrawal.reference })]),
    );

    expect(await t.balance(who.id)).toBe("100000");
    expect(await t.intent(withdrawal.id)).toMatchObject({ status: "failed" });
    expect(await t.postings(`withdrawal-reversal:${withdrawal.id}`)).toHaveLength(1);
  });

  it("gives it back once when a failure and a reversal for the same payment arrive together", async () => {
    const { who, withdrawal } = await setup();
    await Promise.all([
      t.deliver([t.event({ kind: "payout.failed", reference: withdrawal.reference })]),
      t.deliver([t.event({ kind: "payout.reversed", reference: withdrawal.reference })]),
      t.deliver([t.event({ kind: "payout.failed", reference: withdrawal.reference })]),
    ]);
    expect(await t.balance(who.id)).toBe("100000");
    expect(await t.postings(`withdrawal-reversal:${withdrawal.id}`)).toHaveLength(1);
  });

  it("does not pay a withdrawal that was already returned, and flags it for a person", async () => {
    const { who, withdrawal } = await setup();
    await t.deliver([t.event({ kind: "payout.failed", reference: withdrawal.reference })]);
    const late = t.event({ kind: "payout.succeeded", reference: withdrawal.reference });
    await t.deliver([late]).expect(200);

    expect(await t.balance(who.id)).toBe("100000");
    expect(await t.intent(withdrawal.id)).toMatchObject({ status: "failed" });
    const [row] = await t.inbox(late.eventId);
    expect(row).toMatchObject({ status: "failed" });
    expect(row.last_error).toMatch(/Someone must look/);
    expect(await t.postings(`withdrawal-settled:${withdrawal.id}`)).toHaveLength(0);
  });

  it("does not return money for a failure that arrives after the payment was settled", async () => {
    const { who, withdrawal, left } = await setup();
    await t.deliver([t.event({ kind: "payout.succeeded", reference: withdrawal.reference })]);
    const late = t.event({ kind: "payout.failed", reference: withdrawal.reference });
    await t.deliver([late]).expect(200);
    expect(await t.balance(who.id)).toBe(left);
    expect((await t.inbox(late.eventId))[0]).toMatchObject({ status: "failed" });
  });

  it("returns money the bank sends back after paying, once, however many times it says so", async () => {
    const { who, withdrawal } = await setup();
    await t.deliver([t.event({ kind: "payout.succeeded", reference: withdrawal.reference })]);
    await many(12, () =>
      t.deliver([t.event({ kind: "payout.reversed", reference: withdrawal.reference })]),
    );
    expect(await t.balance(who.id)).toBe("100000");
    expect(await t.intent(withdrawal.id)).toMatchObject({ status: "reversed" });
    expect(await t.postings(`withdrawal-returned:${withdrawal.id}`)).toHaveLength(1);
  });

  it("ends in one state, never two, when a success and a failure arrive at the same instant", async () => {
    for (let round = 0; round < 5; round++) {
      const { who, withdrawal, left } = await setup();
      await Promise.all([
        ...Array.from({ length: 4 }, () =>
          t.deliver([t.event({ kind: "payout.succeeded", reference: withdrawal.reference })]),
        ),
        ...Array.from({ length: 4 }, () =>
          t.deliver([t.event({ kind: "payout.failed", reference: withdrawal.reference })]),
        ),
      ]);
      const status = (await t.intent(withdrawal.id)).status;
      expect(["succeeded", "failed"]).toContain(status);
      expect(await t.balance(who.id)).toBe(status === "succeeded" ? left : "100000");
      const settled = (await t.postings(`withdrawal-settled:${withdrawal.id}`)).length;
      const returned = (await t.postings(`withdrawal-reversal:${withdrawal.id}`)).length;
      expect(settled + returned).toBe(1);
    }
  });
});

describe("the inbox", () => {
  it("keeps an event it could not act on, and acts on it when asked again", async () => {
    const who = await t.person();
    await t.giveMoney(who.id, "100000");
    const withdrawal = await t.seedWithdrawal(who.id, "40000");
    // Break it: the held money's record is missing, so returning it is impossible for now.
    await t.db.query("UPDATE payment_intents SET ledger_transaction_id = NULL WHERE id = $1", [
      withdrawal.id,
    ]);
    const e = t.event({ kind: "payout.failed", reference: withdrawal.reference });
    await t.deliver([e]).expect(200);
    expect((await t.inbox(e.eventId))[0]).toMatchObject({ status: "failed", attempts: 1 });
    expect(await t.balance(who.id)).toBe("60000");

    await t.db.query("UPDATE payment_intents SET ledger_transaction_id = $2 WHERE id = $1", [
      withdrawal.id,
      withdrawal.holdId,
    ]);
    expect(await app.get(WebhookInbox).drain()).toBeGreaterThanOrEqual(1);
    expect((await t.inbox(e.eventId))[0]).toMatchObject({ status: "processed" });
    expect(await t.balance(who.id)).toBe("100000");
  });

  it("acts on each stored event once when many copies of the process drain at the same time", async () => {
    const people = await many(6, () => t.person());
    const fundings = await many(6, async (i) => t.seedFunding(people[i]!.id, "10000"));
    for (const f of fundings) {
      await t.db.query(
        `INSERT INTO webhook_events (provider, event_id, kind, type, payload) VALUES ('fake', $1, 'funding.succeeded', 'x', $2)`,
        [
          `drain_${f.reference}`,
          JSON.stringify(
            t.event({
              eventId: `drain_${f.reference}`,
              kind: "funding.succeeded",
              reference: f.reference,
              amount: "10000",
              currency: "NGN",
            }),
          ),
        ],
      );
    }
    const inbox = app.get(WebhookInbox);
    await many(8, () => inbox.drain());
    for (let i = 0; i < 6; i++) {
      expect(await t.balance(people[i]!.id)).toBe("10000");
      expect(await t.postings(`funding:${fundings[i]!.id}`)).toHaveLength(1);
    }
  });

  it("gives up on an event that keeps failing, rather than trying for ever", async () => {
    const eventId = `gives_up_${randomUUID()}`;
    await t.db.query(
      `INSERT INTO webhook_events (provider, event_id, kind, type, payload, status, attempts)
       VALUES ('fake', $1, 'funding.succeeded', 'x', $2, 'failed', $3)`,
      [eventId, JSON.stringify({ eventId, kind: "funding.succeeded", type: "x" }), MAX_ATTEMPTS],
    );
    await app.get(WebhookInbox).drain();
    expect((await t.inbox(eventId))[0].attempts).toBe(MAX_ATTEMPTS);
  });
});

describe("what the database itself refuses", () => {
  it("stores one copy of a partner's event, and refuses a second", async () => {
    const id = `dup_${randomUUID()}`;
    const insert = () =>
      t.db.query(
        `INSERT INTO webhook_events (provider, event_id, kind, type, payload) VALUES ('fake', $1, 'ignored', 'x', '{}')`,
        [id],
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it("refuses a payment for nothing, with a status nobody defined, or the same key twice", async () => {
    const who = await t.person();
    const insert = (over: { amount?: string; status?: string; key?: string }) =>
      t.db.query(
        `INSERT INTO payment_intents (user_id, kind, provider, method, currency, amount, status, reference, idempotency_key, request_hash)
         VALUES ($1, 'funding', 'fake', 'card', 'NGN', $2, $3, $4, $5, repeat('0', 64))`,
        [
          who.id,
          over.amount ?? "100",
          over.status ?? "pending",
          t.reference("ajf"),
          over.key ?? `key_${Math.random()}`.slice(0, 20),
        ],
      );
    await expect(insert({ amount: "0" })).rejects.toThrow();
    await expect(insert({ amount: "-5" })).rejects.toThrow();
    await expect(insert({ status: "refunded" })).rejects.toThrow();
    await insert({ key: "same_key_123" });
    await expect(insert({ key: "same_key_123" })).rejects.toThrow();
  });

  it("will not delete a person who has money records", async () => {
    const who = await t.person();
    await t.seedFunding(who.id, "100");
    await expect(t.db.query("DELETE FROM users WHERE id = $1", [who.id])).rejects.toThrow();
  });
});
