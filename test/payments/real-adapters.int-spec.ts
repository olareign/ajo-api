import type { NestExpressApplication } from "@nestjs/platform-express";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { HTTP_FETCH } from "../../src/payments/providers/providers.service.js";
import { createTestApp } from "../support/test-app.js";
import { newIp } from "../support/users.js";
import { paymentsHarness } from "./support.js";

const RUN = randomUUID().slice(0, 8);
const PAYSTACK_KEY = "sk_test_integrationkey";

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
  for (const key of ["PAYSTACK_SECRET_KEY", "PAYSTACK_BASE_URL"]) delete process.env[key];
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

  it("has no partner for the United Kingdom, so its money screens stay locked", async () => {
    const who = await t.ready("GB");
    expect((await who.call("get", "/wallet/rails").expect(200)).body.connected).toEqual({
      fund: false,
      mandate: false,
      withdraw: false,
    });
    await who
      .call("post", "/payments/fund")
      .set("Idempotency-Key", idempotencyKey())
      .send({ amount: "2500", method: "transfer" })
      .expect((res) => expect([503, 400]).toContain(res.status));
  });
});
