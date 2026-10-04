import type { NestExpressApplication } from "@nestjs/platform-express";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { HTTP_FETCH } from "../../src/payments/providers/providers.service.js";
import { WebhookInbox } from "../../src/payments/webhook-inbox.service.js";
import { createTestApp } from "../support/test-app.js";
import { newIp } from "../support/users.js";
import { paymentsHarness } from "./support.js";

const RUN = randomUUID().slice(0, 8);
const PAYSTACK_KEY = "sk_test_integrationkey";
const GC_SECRET = "gocardless-endpoint-secret";

interface Partner {
  routes: Map<string, Handler>;
  seen: {
    method: string;
    url: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }[];
  on(method: string, path: RegExp | string, handler: Handler): void;
  fetch: typeof fetch;
  reset(): void;
}
type Handler = (req: {
  url: URL;
  method: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}) => Response;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A scripted partner: answers by method and path, and remembers everything it was asked. */
const partner: Partner = {
  routes: new Map<string, Handler>(),
  seen: [] as {
    method: string;
    url: string;
    body: Record<string, unknown>;
    headers: Record<string, string>;
  }[],
  on(method: string, path: RegExp | string, handler: Handler) {
    this.routes.set(`${method} ${path instanceof RegExp ? path.source : path}`, handler);
  },
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    const headers = init?.headers as Record<string, string>;
    partner.seen.push({ method, url: url.href, body, headers });
    for (const [key, handler] of partner.routes) {
      const [m, ...rest] = key.split(" ");
      const pattern = rest.join(" ");
      if (
        m === method &&
        (url.pathname === pattern || new RegExp(`^${pattern}$`).test(url.pathname))
      ) {
        return handler({ url, method, body, headers });
      }
    }
    return json(500, { message: `nothing scripted for ${method} ${url.pathname}` });
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
    {
      PAYMENTS_FAKE: "false",
      PAYSTACK_SECRET_KEY: PAYSTACK_KEY,
      PAYSTACK_BASE_URL: "https://api.paystack.test",
      GOCARDLESS_ACCESS_TOKEN: "gc_token",
      GOCARDLESS_WEBHOOK_SECRET: GC_SECRET,
      GOCARDLESS_ENVIRONMENT: "sandbox",
      WEB_APP_URL: "https://app.ajo.test",
    },
    [],
    (builder) => builder.overrideProvider(HTTP_FETCH).useValue(partner.fetch),
  );
  t = paymentsHarness(app);
});
afterAll(async () => {
  await app?.close();
  // Put the settings back for any file that runs after this one in the same process.
  for (const key of [
    "PAYSTACK_SECRET_KEY",
    "PAYSTACK_BASE_URL",
    "GOCARDLESS_ACCESS_TOKEN",
    "GOCARDLESS_WEBHOOK_SECRET",
    "GOCARDLESS_ENVIRONMENT",
  ])
    delete process.env[key];
});
beforeEach(() => partner.reset());
afterEach(async () => t.expectBooksBalance());

const paystackWebhook = (event: object, secret = PAYSTACK_KEY) => {
  const body = JSON.stringify(event);
  return request(t.http())
    .post("/api/v1/webhooks/paystack")
    .set("Content-Type", "application/json")
    .set("X-Paystack-Signature", createHmac("sha512", secret).update(body).digest("hex"))
    .set("X-Forwarded-For", newIp())
    .send(body);
};
const gocardlessWebhook = (events: object[], secret = GC_SECRET) => {
  const body = JSON.stringify({ events });
  return request(t.http())
    .post("/api/v1/webhooks/gocardless")
    .set("Content-Type", "application/json")
    .set("Webhook-Signature", createHmac("sha256", secret).update(body).digest("hex"))
    .set("X-Forwarded-For", newIp())
    .send(body);
};
const ev = (resource_type: string, action: string, links: object) => ({
  id: `EV${randomUUID()}`,
  resource_type,
  action,
  links,
  created_at: "2026-10-04T10:00:00Z",
});
const reference = async (id: string) =>
  (await t.db.query("SELECT reference FROM payment_intents WHERE id = $1", [id]))[0]
    .reference as string;
const idempotencyKey = () => `k_${randomUUID()}`;

describe("Nigeria, through Paystack", () => {
  it("is connected from the settings, and offers card, transfer, USSD, payouts and auto-debit", async () => {
    const who = await t.ready("NG");
    expect((await who.call("get", "/wallet/rails").expect(200)).body.connected).toEqual({
      fund: true,
      mandate: true,
      withdraw: true,
    });
  });

  it("starts a payment with the secret key in the Authorization header only, and credits it when the signed webhook arrives", async () => {
    partner.on("POST", "/transaction/initialize", () =>
      json(200, {
        status: true,
        data: { authorization_url: "https://checkout.paystack.test/abc", access_code: "abc" },
      }),
    );
    const who = await t.ready("NG");
    const made = await who
      .call("post", "/payments/fund")
      .set("Idempotency-Key", idempotencyKey())
      .send({ amount: "250000", method: "card" })
      .expect(200);
    expect(made.body.action).toEqual({
      type: "redirect",
      url: "https://checkout.paystack.test/abc",
    });

    const asked = partner.seen[0]!;
    expect(asked.headers.Authorization).toBe(`Bearer ${PAYSTACK_KEY}`);
    expect(asked.url).not.toContain(PAYSTACK_KEY);
    expect(JSON.stringify(asked.body)).not.toContain(PAYSTACK_KEY);
    expect(JSON.stringify(made.body)).not.toContain(PAYSTACK_KEY);

    const ref = await reference(made.body.id);
    const charge = {
      event: "charge.success",
      data: {
        id: Math.floor(Math.random() * 1e9),
        reference: ref,
        amount: 250000,
        currency: "NGN",
        status: "success",
      },
    };
    await paystackWebhook(charge).expect(200);
    await paystackWebhook(charge).expect(200);
    await Promise.all(Array.from({ length: 8 }, () => paystackWebhook(charge)));
    expect(await t.balance(who.id)).toBe("250000");
    expect(await t.postings(`funding:${made.body.id}`)).toHaveLength(1);
  });

  it("refuses a webhook signed with another key, and stores nothing", async () => {
    const charge = {
      event: "charge.success",
      data: {
        id: Math.floor(Math.random() * 1e9),
        reference: "ajf_none",
        amount: 1,
        currency: "NGN",
      },
    };
    await paystackWebhook(charge, "sk_test_someoneelse").expect(401);
    expect(
      await t.db.query("SELECT 1 FROM webhook_events WHERE event_id = 'charge.success:888'"),
    ).toHaveLength(0);
  });

  it("pays a withdrawal out and settles it when Paystack's webhook says it was sent", async () => {
    partner.on("POST", "/transfer", () =>
      json(200, {
        status: true,
        data: { status: "pending", transfer_code: `TRF_${RUN}_${randomUUID()}` },
      }),
    );
    partner.on("GET", "/bank/resolve", () =>
      json(200, { status: true, data: { account_name: "TEST USER" } }),
    );
    partner.on("POST", "/transferrecipient", () =>
      json(201, { status: true, data: { recipient_code: "RCP_real" } }),
    );
    const who = await t.ready("NG");
    await t.giveMoney(who.id, "100000");
    // The account is set directly: setting it through the API needs a fresh authenticator code.
    await t.db.query(
      `INSERT INTO payout_accounts (user_id, provider, bank_code, bank_name, last4, account_name, recipient_code) VALUES ($1, 'paystack', '058', 'GTBank', '6789', 'TEST USER', 'RCP_real')`,
      [who.id],
    );
    const { codeAt } = await import("./support.js");
    const sent = await who
      .call("post", "/payments/withdraw")
      .set("Idempotency-Key", idempotencyKey())
      .set("X-Ajo-Mfa-Code", codeAt(who.secret!, 30))
      .send({ amount: "40000", pin: "493817" })
      .expect(200);
    expect(sent.body.status).toBe("pending");
    const transfer = partner.seen.find((s) => s.url.endsWith("/transfer"))!;
    expect(transfer.body).toMatchObject({
      source: "balance",
      amount: "40000",
      recipient: "RCP_real",
    });

    const ref = await reference(sent.body.id);
    await paystackWebhook({
      event: "transfer.success",
      data: {
        id: Math.floor(Math.random() * 1e9),
        reference: ref,
        amount: 40000,
        currency: "NGN",
        transfer_code: `TRF_${RUN}_${randomUUID()}`,
      },
    }).expect(200);
    expect((await who.call("get", `/payments/${sent.body.id}`).expect(200)).body.status).toBe(
      "succeeded",
    );
    expect(await t.balance(who.id)).toBe("60000");
  });

  it("activates a direct-debit mandate from Paystack's webhook, found by the customer's email", async () => {
    partner.on("POST", "/customer/authorization/initialize", () =>
      json(200, {
        status: true,
        data: { redirect_url: "https://link.paystack.test/dd", reference: "dfbz" },
      }),
    );
    const who = await t.ready("NG");
    const made = await who.call("post", "/payments/mandate").expect(200);
    expect(made.body.action.url).toBe("https://link.paystack.test/dd");
    await paystackWebhook({
      event: "direct_debit.authorization.active",
      data: {
        authorization_code: `AUTH_${randomUUID()}`,
        active: true,
        customer: { email: who.email },
      },
    }).expect(200);
    expect((await who.call("get", "/payments/mandate").expect(200)).body.status).toBe("active");
  });
});

describe("the United Kingdom, through GoCardless", () => {
  it("offers bank payments and auto-debit, but no withdrawals", async () => {
    const who = await t.ready("GB");
    expect((await who.call("get", "/wallet/rails").expect(200)).body.connected).toEqual({
      fund: true,
      mandate: true,
      withdraw: false,
    });
    const res = await who
      .call("post", "/payments/withdraw")
      .set("Idempotency-Key", idempotencyKey())
      .set("X-Ajo-Mfa-Code", "123456")
      .send({ amount: "1000", pin: "493817" });
    expect([401, 503]).toContain(res.status);
  });

  it("does not offer direct debit as a way to add money, but does offer a bank payment", async () => {
    partner.on("POST", "/billing_requests", () =>
      json(201, { billing_requests: { id: `BRQ1_${RUN}` } }),
    );
    partner.on("POST", "/billing_request_flows", () =>
      json(201, {
        billing_request_flows: { authorisation_url: "https://pay.gocardless.test/flow" },
      }),
    );
    const who = await t.ready("GB");
    const bad = await who
      .call("post", "/payments/fund")
      .set("Idempotency-Key", idempotencyKey())
      .send({ amount: "2500", method: "direct_debit" })
      .expect(400);
    expect(bad.body.code).toBe("method_not_available");
    const ok = await who
      .call("post", "/payments/fund")
      .set("Idempotency-Key", idempotencyKey())
      .send({ amount: "2500", method: "transfer" })
      .expect(200);
    expect(ok.body.action.url).toBe("https://pay.gocardless.test/flow");
    expect(partner.seen[0]!.headers).toMatchObject({
      Authorization: "Bearer gc_token",
      "GoCardless-Version": "2015-07-06",
    });
  });

  it("credits a bank payment from GoCardless's webhook, matching it back to ours by asking GoCardless", async () => {
    partner.on("POST", "/billing_requests", () =>
      json(201, { billing_requests: { id: `BRQ2_${RUN}` } }),
    );
    partner.on("POST", "/billing_request_flows", () =>
      json(201, {
        billing_request_flows: { authorisation_url: "https://pay.gocardless.test/flow" },
      }),
    );
    const who = await t.ready("GB");
    const made = await who
      .call("post", "/payments/fund")
      .set("Idempotency-Key", idempotencyKey())
      .send({ amount: "2500", method: "transfer" })
      .expect(200);
    const ref = await reference(made.body.id);
    partner.on("GET", `/payments/PM2_${RUN}`, () =>
      json(200, {
        payments: { id: `PM2_${RUN}`, amount: 2500, currency: "GBP", metadata: { ajo_ref: ref } },
      }),
    );

    const confirmed = ev("payments", "confirmed", { payment: `PM2_${RUN}` });
    await gocardlessWebhook([confirmed]).expect(200);
    await Promise.all(Array.from({ length: 6 }, () => gocardlessWebhook([confirmed])));
    await gocardlessWebhook([ev("payments", "paid_out", { payment: `PM2_${RUN}` })]).expect(200);
    expect(await t.balance(who.id, "GBP")).toBe("2500");
    expect(await t.postings(`funding:${made.body.id}`)).toHaveLength(1);
  });

  it("refuses a batch signed with another secret", async () => {
    await gocardlessWebhook(
      [ev("payments", "confirmed", { payment: `PM9_${RUN}` })],
      "not-our-secret",
    ).expect(401);
  });

  it("sets up a Bacs mandate, and holds an early 'active' until the message that introduces the mandate arrives", async () => {
    partner.on("POST", "/billing_requests", () =>
      json(201, { billing_requests: { id: `BRQ3_${RUN}` } }),
    );
    partner.on("POST", "/billing_request_flows", () =>
      json(201, { billing_request_flows: { authorisation_url: "https://pay.gocardless.test/dd" } }),
    );
    const who = await t.ready("GB");
    const made = await who.call("post", "/payments/mandate").expect(200);
    expect(made.body.action.url).toBe("https://pay.gocardless.test/dd");

    // GoCardless carries no reference for this mandate, so the early message cannot be matched yet.
    partner.on("GET", `/mandates/MD3_${RUN}`, () =>
      json(200, { mandates: { id: `MD3_${RUN}`, metadata: {} } }),
    );
    const early = ev("mandates", "active", { mandate: `MD3_${RUN}` });
    await gocardlessWebhook([early]).expect(200);
    const [stored] = await t.db.query(
      "SELECT status, attempts FROM webhook_events WHERE event_id = $1",
      [early.id],
    );
    expect(stored).toMatchObject({ status: "failed", attempts: 1 });
    expect((await who.call("get", "/payments/mandate").expect(200)).body.status).toBe("pending");

    // Then the introduction arrives, and the held message is acted on when the inbox is drained.
    await gocardlessWebhook([
      ev("billing_requests", "fulfilled", {
        billing_request: `BRQ3_${RUN}`,
        mandate_request_mandate: `MD3_${RUN}`,
      }),
    ]).expect(200);
    await app.get(WebhookInbox).drain();
    expect((await who.call("get", "/payments/mandate").expect(200)).body.status).toBe("active");
  });

  it("cancels a mandate with GoCardless once it has an id", async () => {
    partner.on("POST", "/billing_requests", () =>
      json(201, { billing_requests: { id: `BRQ4_${RUN}` } }),
    );
    partner.on("POST", "/billing_request_flows", () =>
      json(201, { billing_request_flows: { authorisation_url: "https://pay.gocardless.test/dd" } }),
    );
    partner.on("POST", `/mandates/MD4_${RUN}/actions/cancel`, () =>
      json(200, { mandates: { status: "cancelled" } }),
    );
    const who = await t.ready("GB");
    await who.call("post", "/payments/mandate").expect(200);
    await gocardlessWebhook([
      ev("billing_requests", "fulfilled", {
        billing_request: `BRQ4_${RUN}`,
        mandate_request_mandate: `MD4_${RUN}`,
      }),
    ]).expect(200);
    partner.on("GET", `/mandates/MD4_${RUN}`, () =>
      json(200, { mandates: { id: `MD4_${RUN}`, metadata: {} } }),
    );
    await gocardlessWebhook([ev("mandates", "active", { mandate: `MD4_${RUN}` })]).expect(200);
    await who.call("delete", "/payments/mandate").expect(200);
    expect(partner.seen.some((s) => s.url.endsWith(`/mandates/MD4_${RUN}/actions/cancel`))).toBe(
      true,
    );
  });
});
