import type { NestExpressApplication } from "@nestjs/platform-express";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { BankPulls } from "../../src/payments/bank-pulls.service.js";
import { HTTP_FETCH } from "../../src/payments/providers/providers.service.js";
import { createTestApp } from "../support/test-app.js";
import { newIp } from "../support/users.js";
import { paymentsHarness } from "./support.js";

const STRIPE_KEY = "sk_test_integrationstripe";
const WHSEC = "whsec_integrationstripe";
/** The test database keeps rows between runs, so every Stripe id here is new each run. */
const RUN = randomUUID().replaceAll("-", "").slice(0, 10);

type Seen = {
  method: string;
  path: string;
  body: URLSearchParams;
  headers: Record<string, string>;
};
type Handler = (seen: Seen) => Response;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A scripted Stripe: answers by method and path, reads its form bodies, and remembers every call. */
const scripted: {
  routes: Map<string, Handler>;
  seen: Seen[];
  on(method: string, path: string, handler: Handler): void;
  fetch: typeof fetch;
  reset(): void;
} = {
  routes: new Map<string, Handler>(),
  seen: [] as Seen[],
  on(method: string, path: string, handler: Handler) {
    this.routes.set(`${method} ${path}`, handler);
  },
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const seen: Seen = {
      method: init?.method ?? "GET",
      path: url.pathname,
      body: new URLSearchParams((init?.body as string) ?? ""),
      headers: init?.headers as Record<string, string>,
    };
    scripted.seen.push(seen);
    const handler: Handler | undefined = scripted.routes.get(`${seen.method} ${seen.path}`);
    return handler
      ? handler(seen)
      : json(500, { error: { message: `nothing scripted for ${seen.path}` } });
  }) as typeof fetch,
  reset() {
    this.routes.clear();
    this.seen.length = 0;
  },
};

let app: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;

beforeAll(async () => {
  app = await createTestApp(
    { PAYMENTS_FAKE: "false", STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WHSEC },
    [],
    (builder) => builder.overrideProvider(HTTP_FETCH).useValue(scripted.fetch),
  );
  t = paymentsHarness(app);
});
afterAll(async () => {
  await app?.close();
  for (const key of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) delete process.env[key];
});
beforeEach(() => scripted.reset());
afterEach(async () => t.expectBooksBalance());

const deliver = (event: object, options: { secret?: string; at?: number } = {}) => {
  const body = JSON.stringify(event);
  const at = options.at ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", options.secret ?? WHSEC)
    .update(`${at}.${body}`)
    .digest("hex");
  return request(t.http())
    .post("/api/v1/webhooks/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", `t=${at},v1=${v1}`)
    .set("X-Forwarded-For", newIp())
    .send(body);
};
const reference = async (id: string) =>
  (await t.db.query("SELECT reference FROM payment_intents WHERE id = $1", [id]))[0]
    .reference as string;
const evt = (type: string, object: object) => ({
  id: `evt_${randomUUID()}`,
  type,
  data: { object },
});

describe("the UK, through Stripe", () => {
  it("is connected from the settings for card top-ups and Direct Debit, but not withdrawals", async () => {
    const who = await t.ready("GB");
    expect((await who.call("get", "/wallet/rails").expect(200)).body.connected).toEqual({
      fund: true,
      mandate: true,
      withdraw: false,
    });
    const refused = await who
      .call("post", "/payments/withdraw")
      .set("Idempotency-Key", `k_${randomUUID()}`)
      .send({ amount: "100", pin: "493817" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(scripted.seen).toHaveLength(0);
  });

  it("adds money by card through Checkout and credits it once when the signed webhook says it was paid", async () => {
    scripted.on("POST", "/v1/checkout/sessions", () =>
      json(200, { id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" }),
    );
    const who = await t.ready("GB");
    const made = await who
      .call("post", "/payments/fund")
      .set("Idempotency-Key", `k_${randomUUID()}`)
      .send({ amount: "2500", method: "card" })
      .expect(200);
    expect(made.body.action).toEqual({
      type: "redirect",
      url: "https://checkout.stripe.test/cs_test_1",
    });
    const asked = scripted.seen[0]!;
    expect(asked.headers.Authorization).toBe(`Bearer ${STRIPE_KEY}`);
    expect(asked.body.get("line_items[0][price_data][unit_amount]")).toBe("2500");
    expect(JSON.stringify(made.body)).not.toContain(STRIPE_KEY);

    const ref = await reference(made.body.id);
    const paid = evt("checkout.session.completed", {
      id: "cs_test_1",
      mode: "payment",
      payment_status: "paid",
      client_reference_id: ref,
      metadata: { reference: ref },
      amount_total: 2500,
      currency: "gbp",
    });
    await deliver(paid).expect(200);
    await Promise.all(Array.from({ length: 6 }, () => deliver(paid)));
    expect(await t.balance(who.id, "GBP")).toBe("2500");
    expect(await t.postings(`funding:${made.body.id}`)).toHaveLength(1);
  });

  it("credits nothing when the amount paid differs from the amount asked", async () => {
    scripted.on("POST", "/v1/checkout/sessions", () =>
      json(200, { id: "cs_test_2", url: "https://checkout.stripe.test/2" }),
    );
    const who = await t.ready("GB");
    const made = await who
      .call("post", "/payments/fund")
      .set("Idempotency-Key", `k_${randomUUID()}`)
      .send({ amount: "2500", method: "card" })
      .expect(200);
    const ref = await reference(made.body.id);
    await deliver(
      evt("checkout.session.completed", {
        mode: "payment",
        payment_status: "paid",
        client_reference_id: ref,
        amount_total: 1,
        currency: "gbp",
      }),
    ).expect(200);
    expect(await t.balance(who.id, "GBP")).toBe("0");
  });

  it("refuses a webhook signed with another secret, or replayed later, and stores nothing", async () => {
    const event = evt("checkout.session.completed", { mode: "payment", payment_status: "paid" });
    await deliver(event, { secret: "whsec_someoneelse" }).expect(401);
    await deliver(event, { at: Math.floor(Date.now() / 1000) - 3600 }).expect(401);
    expect(
      await t.db.query("SELECT 1 FROM webhook_events WHERE event_id = $1", [event.id]),
    ).toHaveLength(0);
  });

  it("sets up a Bacs Direct Debit, makes it active from Stripe's webhook, and collects under it", async () => {
    scripted.on("POST", "/v1/customers", () => json(200, { id: `cus_test_1_${RUN}` }));
    scripted.on("POST", "/v1/checkout/sessions", () =>
      json(200, { id: `cs_setup_1_${RUN}`, url: "https://checkout.stripe.test/setup" }),
    );
    const who = await t.ready("GB");
    const started = await who.call("post", "/payments/mandate").expect(200);
    expect(started.body.status).toBe("pending");
    const [mandate] = await t.db.query("SELECT reference FROM mandates WHERE user_id = $1", [
      who.id,
    ]);
    await deliver(
      evt("setup_intent.succeeded", {
        customer: `cus_test_1_${RUN}`,
        payment_method: `pm_test_1_${RUN}`,
        mandate: `mandate_test_1_${RUN}`,
        metadata: { reference: mandate.reference },
      }),
    ).expect(200);
    expect((await who.call("get", "/payments/mandate").expect(200)).body.status).toBe("active");

    scripted.on("POST", "/v1/payment_intents", () =>
      json(200, { id: `pi_test_1_${RUN}`, status: "processing" }),
    );
    const pulls = app.get(BankPulls);
    const pull = await pulls.start(who.id, "1000", `pull_${randomUUID()}`);
    expect(pull.status).toBe("pending");
    const charge = scripted.seen.find((s: Seen) => s.path === "/v1/payment_intents")!;
    expect([
      charge.body.get("customer"),
      charge.body.get("payment_method"),
      charge.body.get("off_session"),
    ]).toEqual([`cus_test_1_${RUN}`, `pm_test_1_${RUN}`, "true"]);
    const ref = charge.body.get("metadata[reference]")!;
    await deliver(
      evt("payment_intent.succeeded", {
        id: `pi_test_1_${RUN}`,
        metadata: { reference: ref, source: "mandate" },
        amount_received: 1000,
        currency: "gbp",
      }),
    ).expect(200);
    expect(await t.balance(who.id, "GBP")).toBe("1000");

    // The bank later cancels the mandate.
    await deliver(
      evt("mandate.updated", { id: `mandate_test_1_${RUN}`, status: "inactive" }),
    ).expect(200);
    expect((await who.call("get", "/payments/mandate").expect(200)).body.status).toBe("cancelled");
  });
});
