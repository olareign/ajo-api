import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { createTestApp } from "../support/test-app.js";
import { paymentsHarness } from "./support.js";

let app: NestExpressApplication;
let unconnected: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true", WEB_APP_URL: "https://app.ajo.test" });
  t = paymentsHarness(app);
  unconnected = await createTestApp({ PAYMENTS_FAKE: "false" });
});
afterAll(async () => {
  await app?.close();
  await unconnected?.close();
});
afterEach(async () => t.expectBooksBalance());

const key = () => `k_${randomUUID()}`;
const fund = (
  who: Awaited<ReturnType<typeof t.ready>>,
  body: object,
  idempotencyKey: string | null = key(),
) => {
  const req = who.call("post", "/payments/fund");
  return (idempotencyKey ? req.set("Idempotency-Key", idempotencyKey) : req).send(body);
};
const many = <T>(n: number, make: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => make(i)));

describe("who may add money", () => {
  it("needs a signed-in person", async () => {
    const who = await t.ready();
    const { default: request } = await import("supertest");
    await request(t.http())
      .post("/api/v1/payments/fund")
      .set("Idempotency-Key", key())
      .send({ amount: "1000", method: "card" })
      .expect(401);
    expect(who.id).toBeDefined();
  });

  it("needs approved identity checks, and says so in a word the app can act on", async () => {
    const who = await t.ready("NG", { kyc: false });
    const res = await fund(who, { amount: "100000", method: "card" }).expect(403);
    expect(res.body.code).toBe("kyc_required");
  });

  it("needs the authenticator app to be on, but never a fresh code", async () => {
    const without = await t.ready("NG", { mfa: false });
    expect((await fund(without, { amount: "100000", method: "card" }).expect(403)).body.code).toBe(
      "mfa_enrolment_required",
    );
    const withApp = await t.ready();
    await fund(withApp, { amount: "100000", method: "card" }).expect(200);
  });

  it("says plainly when no payment partner is connected, and starts nothing", async () => {
    const { paymentsHarness: harness } = await import("./support.js");
    const u = harness(unconnected);
    const who = await u.ready();
    const res = await who
      .call("post", "/payments/fund")
      .set("Idempotency-Key", key())
      .send({ amount: "100000", method: "card" })
      .expect(503);
    expect(res.body.code).toBe("payments_not_connected");
    expect(
      await u.db.query("SELECT 1 FROM payment_intents WHERE user_id = $1", [who.id]),
    ).toHaveLength(0);
  });
});

describe("what a request must look like", () => {
  it("needs an idempotency key, and refuses a malformed one", async () => {
    const who = await t.ready();
    await fund(who, { amount: "100000", method: "card" }, null).expect(400);
    await fund(who, { amount: "100000", method: "card" }, "short").expect(400);
    await fund(who, { amount: "100000", method: "card" }, "has spaces in it!").expect(400);
  });

  it.each([["0"], ["-100"], ["10.5"], ["1e3"], ["abc"], [""], ["9".repeat(20)]])(
    "refuses the amount %j",
    async (amount) => {
      const who = await t.ready();
      await fund(who, { amount, method: "card" }).expect(400);
    },
  );

  it("refuses a method nobody offers, and one this country's partner does not offer", async () => {
    const ng = await t.ready("NG");
    await fund(ng, { amount: "100000", method: "bitcoin" }).expect(400);
    const gb = await t.ready("GB");
    const res = await fund(gb, { amount: "10000", method: "ussd" }).expect(400);
    expect(res.body.code).toBe("method_not_available");
  });

  it("refuses fields it does not know", async () => {
    const who = await t.ready();
    await fund(who, { amount: "100000", method: "card", currency: "USD" }).expect(400);
  });
});

describe("starting a payment", () => {
  it("asks the partner once, in the smallest unit, and hands back where to go next", async () => {
    const who = await t.ready();
    const before = t.fake("NG").count("initializeFunding");
    const res = await fund(who, { amount: "500000", method: "card" }).expect(200);

    expect(res.body).toMatchObject({
      status: "pending",
      method: "card",
      amount: { amount: "500000", currency: "NGN" },
      action: { type: "redirect", url: expect.stringMatching(/^https:\/\/fake-pay\.test\/pay\//) },
    });
    expect(t.fake("NG").count("initializeFunding")).toBe(before + 1);
    const call = t
      .fake("NG")
      .calls.filter(([m]) => m === "initializeFunding")
      .at(-1)![1] as Record<string, string>;
    expect(call).toMatchObject({ amount: "500000", email: who.email, method: "card" });
    expect(call.returnUrl).toBe(`https://app.ajo.test/wallet/add/return?id=${res.body.id}`);
    expect(await t.balance(who.id)).toBe("0");
  });

  it("uses the person's own country's currency, never one they name", async () => {
    const who = await t.ready("GB");
    const res = await fund(who, { amount: "2500", method: "transfer" }).expect(200);
    expect(res.body.amount).toEqual({ amount: "2500", currency: "GBP" });
  });
});

describe("the same request twice", () => {
  it("returns the same payment and asks the partner only once", async () => {
    const who = await t.ready();
    const k = key();
    const first = await fund(who, { amount: "100000", method: "card" }, k).expect(200);
    const calls = t.fake("NG").count("initializeFunding");
    const again = await fund(who, { amount: "100000", method: "card" }, k).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(again.body.action).toEqual(first.body.action);
    expect(t.fake("NG").count("initializeFunding")).toBe(calls);
  });

  it("refuses the same key for a different request", async () => {
    const who = await t.ready();
    const k = key();
    await fund(who, { amount: "100000", method: "card" }, k).expect(200);
    const res = await fund(who, { amount: "200000", method: "card" }, k).expect(409);
    expect(res.body.code).toBe("idempotency_key_reused");
    await fund(who, { amount: "100000", method: "ussd" }, k).expect(409);
  });

  it("lets two people use the same key for their own payments", async () => {
    const a = await t.ready();
    const b = await t.ready();
    const k = key();
    const first = await fund(a, { amount: "100000", method: "card" }, k).expect(200);
    const second = await fund(b, { amount: "100000", method: "card" }, k).expect(200);
    expect(second.body.id).not.toBe(first.body.id);
  });

  it("starts one payment, and asks the partner once, when ten identical requests arrive at the same instant", async () => {
    const who = await t.ready();
    const k = key();
    const calls = t.fake("NG").count("initializeFunding");
    const answers = await many(10, () => fund(who, { amount: "100000", method: "card" }, k));

    expect(answers.map((a) => a.status)).toEqual(Array(10).fill(200));
    expect(new Set(answers.map((a) => a.body.id)).size).toBe(1);
    expect(new Set(answers.map((a) => a.body.action.url)).size).toBe(1);
    expect(t.fake("NG").count("initializeFunding")).toBe(calls + 1);
    expect(
      await t.db.query("SELECT 1 FROM payment_intents WHERE user_id = $1", [who.id]),
    ).toHaveLength(1);
  });

  it("starts a payment for each key when different requests arrive at once", async () => {
    const who = await t.ready();
    const answers = await many(6, () => fund(who, { amount: "100000", method: "card" }));
    expect(new Set(answers.map((a) => a.body.id)).size).toBe(6);
  });
});

describe("when the partner cannot start it", () => {
  afterEach(() => {
    t.fake("NG").behaviour.initialize = "ok";
  });

  it("records a refusal as failed, says why, and lets the person try again with a new key", async () => {
    const who = await t.ready();
    t.fake("NG").behaviour.initialize = "reject";
    const res = await fund(who, { amount: "100000", method: "card" }).expect(422);
    expect(res.body.code).toBe("payment_refused");
    const [row] = await t.db.query(
      "SELECT status, failure_reason FROM payment_intents WHERE user_id = $1",
      [who.id],
    );
    expect(row.status).toBe("failed");

    t.fake("NG").behaviour.initialize = "ok";
    await fund(who, { amount: "100000", method: "card" }).expect(200);
  });

  it("answers 503 when the partner cannot be reached, and leaves nothing pending", async () => {
    const who = await t.ready();
    t.fake("NG").behaviour.initialize = "unavailable";
    const res = await fund(who, { amount: "100000", method: "card" }).expect(503);
    expect(res.body.code).toBe("payments_unavailable");
    const [row] = await t.db.query("SELECT status FROM payment_intents WHERE user_id = $1", [
      who.id,
    ]);
    expect(row.status).toBe("failed");
  });

  it("replays a failed attempt to the same key instead of trying the partner again", async () => {
    const who = await t.ready();
    const k = key();
    t.fake("NG").behaviour.initialize = "reject";
    await fund(who, { amount: "100000", method: "card" }, k).expect(422);
    t.fake("NG").behaviour.initialize = "ok";
    const calls = t.fake("NG").count("initializeFunding");
    const again = await fund(who, { amount: "100000", method: "card" }, k);
    expect(again.status).toBe(422);
    expect(t.fake("NG").count("initializeFunding")).toBe(calls);
  });
});

describe("following a payment", () => {
  it("shows the person their own payment, and nobody else's", async () => {
    const a = await t.ready();
    const b = await t.ready();
    const made = await fund(a, { amount: "100000", method: "card" }).expect(200);
    const seen = await a.call("get", `/payments/${made.body.id}`).expect(200);
    expect(seen.body).toMatchObject({ id: made.body.id, status: "pending" });
    await b.call("get", `/payments/${made.body.id}`).expect(404);
    await a.call("get", `/payments/${randomUUID()}`).expect(404);
    await a.call("get", "/payments/not-an-id").expect(400);
  });

  it("turns succeeded, and the wallet shows the money, once the partner says it was paid", async () => {
    const who = await t.ready();
    const made = await fund(who, { amount: "250000", method: "card" }).expect(200);
    const [{ reference }] = await t.db.query(
      "SELECT reference FROM payment_intents WHERE id = $1",
      [made.body.id],
    );
    await t
      .deliver([
        t.event({ kind: "funding.succeeded", reference, amount: "250000", currency: "NGN" }),
      ])
      .expect(200);

    expect((await who.call("get", `/payments/${made.body.id}`).expect(200)).body.status).toBe(
      "succeeded",
    );
    const wallet = (await who.call("get", "/wallet").expect(200)).body.wallets[0];
    expect(wallet.available).toEqual({ amount: "250000", currency: "NGN" });
  });
});

describe("a webhook that never comes", () => {
  const stale = (id: string) =>
    t.db.query(
      "UPDATE payment_intents SET updated_at = now() - interval '5 minutes' WHERE id = $1",
      [id],
    );

  it("is made up for by asking the partner when the person looks, and the money counts once", async () => {
    const who = await t.ready();
    const made = await fund(who, { amount: "90000", method: "card" }).expect(200);
    const [{ reference }] = await t.db.query(
      "SELECT reference FROM payment_intents WHERE id = $1",
      [made.body.id],
    );
    t.fake("NG").behaviour.paid.set(reference, {
      status: "success",
      amount: "90000",
      currency: "NGN",
    });
    await stale(made.body.id);

    const looks = await many(10, () => who.call("get", `/payments/${made.body.id}`));
    expect(looks.every((l: { status: number }) => l.status === 200)).toBe(true);
    expect(await t.balance(who.id)).toBe("90000");
    expect(await t.postings(`funding:${made.body.id}`)).toHaveLength(1);

    // And the webhook turning up afterwards changes nothing.
    await t
      .deliver([
        t.event({ kind: "funding.succeeded", reference, amount: "90000", currency: "NGN" }),
      ])
      .expect(200);
    expect(await t.balance(who.id)).toBe("90000");
  });

  it("does not ask the partner on every look, only when it has been a while", async () => {
    const who = await t.ready();
    const made = await fund(who, { amount: "90000", method: "card" }).expect(200);
    const before = t.fake("NG").count("verifyFunding");
    await who.call("get", `/payments/${made.body.id}`).expect(200);
    await who.call("get", `/payments/${made.body.id}`).expect(200);
    expect(t.fake("NG").count("verifyFunding")).toBe(before);
  });

  it("marks it failed when the partner says it failed", async () => {
    const who = await t.ready();
    const made = await fund(who, { amount: "90000", method: "card" }).expect(200);
    const [{ reference }] = await t.db.query(
      "SELECT reference FROM payment_intents WHERE id = $1",
      [made.body.id],
    );
    t.fake("NG").behaviour.paid.set(reference, {
      status: "failed",
      amount: "90000",
      currency: "NGN",
    });
    await stale(made.body.id);
    expect((await who.call("get", `/payments/${made.body.id}`).expect(200)).body.status).toBe(
      "failed",
    );
    expect(await t.balance(who.id)).toBe("0");
  });

  it("does not credit what the partner reports if it is not what was asked for", async () => {
    const who = await t.ready();
    const made = await fund(who, { amount: "90000", method: "card" }).expect(200);
    const [{ reference }] = await t.db.query(
      "SELECT reference FROM payment_intents WHERE id = $1",
      [made.body.id],
    );
    t.fake("NG").behaviour.paid.set(reference, {
      status: "success",
      amount: "100",
      currency: "NGN",
    });
    await stale(made.body.id);
    await who.call("get", `/payments/${made.body.id}`).expect(200);
    expect(await t.balance(who.id)).toBe("0");
  });
});

describe("what the wallet says can be done", () => {
  it("lists what the person's own country's partner offers", async () => {
    const ng = await t.ready("NG");
    expect((await ng.call("get", "/wallet/rails").expect(200)).body).toMatchObject({
      country: "NG",
      kycApproved: true,
      connected: { fund: true, mandate: true, withdraw: true },
    });
    const gb = await t.ready("GB");
    expect((await gb.call("get", "/wallet/rails").expect(200)).body.connected).toEqual({
      fund: true,
      mandate: true,
      withdraw: false,
    });
  });

  it("says nothing is connected when no partner is set up", async () => {
    const { paymentsHarness: harness } = await import("./support.js");
    const u = harness(unconnected);
    const who = await u.ready();
    expect((await who.call("get", "/wallet/rails").expect(200)).body.connected).toEqual({
      fund: false,
      mandate: false,
      withdraw: false,
    });
  });
});
