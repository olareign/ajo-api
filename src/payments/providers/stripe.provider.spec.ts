import { createHmac } from "node:crypto";
import { InvalidWebhookSignature, ProviderRejected, ProviderUnavailable } from "./provider.port.js";
import { formEncode, StripeProvider, WEBHOOK_TOLERANCE_SECONDS } from "./stripe.provider.js";

const SECRET = "sk_test_unitkey";
const WHSEC = "whsec_unitsecret";
const NOW = 1_790_000_000_000;

type Seen = { method: string; url: string; body: URLSearchParams; headers: Record<string, string> };

function stripe(answer: (seen: Seen) => Response) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url,
      body: new URLSearchParams((init?.body as string) ?? ""),
      headers: init?.headers as Record<string, string>,
    };
    seen.push(call);
    return answer(call);
  }) as typeof fetch;
  return {
    seen,
    provider: new StripeProvider({
      secretKey: SECRET,
      webhookSecret: WHSEC,
      fetchFn,
      now: () => NOW,
    }),
  };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const signed = (event: object, at = NOW / 1000, secret = WHSEC) => {
  const body = Buffer.from(JSON.stringify(event));
  const v1 = createHmac("sha256", secret).update(`${at}.`).update(body).digest("hex");
  return { body, header: `t=${at},v1=${v1}` };
};
const event = (type: string, object: object, id = `evt_${type}`) => ({
  id,
  type,
  data: { object },
});

describe("formEncode", () => {
  it("writes nested keys and lists the way Stripe reads them", () => {
    expect(
      decodeURIComponent(
        formEncode({
          mode: "payment",
          metadata: { reference: "r1" },
          line_items: [{ quantity: 1, price_data: { currency: "gbp", unit_amount: "500" } }],
          skip: undefined,
        }),
      ),
    ).toBe(
      "mode=payment&metadata[reference]=r1&line_items[0][quantity]=1&line_items[0][price_data][currency]=gbp&line_items[0][price_data][unit_amount]=500",
    );
  });
});

describe("adding money by card", () => {
  it("opens a Checkout session for exactly that amount in pounds, keyed so a retry cannot pay twice", async () => {
    const { seen, provider } = stripe(() =>
      json(200, { id: "cs_1", url: "https://checkout.stripe.test/cs_1" }),
    );
    const start = await provider.initializeFunding({
      reference: "ajf_reference_0001",
      amount: "2500",
      email: "ada@example.com",
      method: "card",
      returnUrl: "https://app.ajo.test/wallet/add/return",
    });
    expect(start).toEqual({
      providerId: "cs_1",
      action: { type: "redirect", url: "https://checkout.stripe.test/cs_1" },
    });
    const [call] = seen;
    expect(call!.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(call!.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(call!.headers["Idempotency-Key"]).toBe("fund:ajf_reference_0001");
    expect(call!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(call!.body.get("mode")).toBe("payment");
    expect(call!.body.get("line_items[0][price_data][currency]")).toBe("gbp");
    expect(call!.body.get("line_items[0][price_data][unit_amount]")).toBe("2500");
    expect(call!.body.get("client_reference_id")).toBe("ajf_reference_0001");
    expect(call!.body.get("payment_intent_data[metadata][source]")).toBe("checkout");
    expect(call!.url + call!.body.toString()).not.toContain(SECRET);
  });

  it("only takes cards, and treats a missing checkout address as not knowing", async () => {
    const { provider } = stripe(() => json(200, { id: "cs_1" }));
    await expect(
      provider.initializeFunding({
        reference: "r".repeat(16),
        amount: "1",
        email: "a@b.c",
        method: "transfer",
        returnUrl: "https://x",
      }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    await expect(
      provider.initializeFunding({
        reference: "r".repeat(16),
        amount: "1",
        email: "a@b.c",
        method: "card",
        returnUrl: "https://x",
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("checks a session: paid, expired, or still open", async () => {
    let answer: object = { payment_status: "paid", amount_total: 2500, currency: "gbp" };
    const { provider } = stripe(() => json(200, answer));
    expect(await provider.verifyFunding("r", "cs_1")).toEqual({
      status: "success",
      amount: "2500",
      currency: "GBP",
    });
    answer = { payment_status: "unpaid", status: "expired", amount_total: 2500, currency: "gbp" };
    expect((await provider.verifyFunding("r", "cs_1")).status).toBe("failed");
    answer = { payment_status: "unpaid", status: "open", amount_total: 2500, currency: "gbp" };
    expect((await provider.verifyFunding("r", "cs_1")).status).toBe("pending");
    expect((await provider.verifyFunding("r", null)).status).toBe("pending");
  });
});

describe("webhooks", () => {
  const { provider } = stripe(() => json(500, {}));
  const completed = event("checkout.session.completed", {
    id: "cs_1",
    mode: "payment",
    payment_status: "paid",
    client_reference_id: "ajf_reference_0001",
    metadata: { reference: "ajf_reference_0001" },
    amount_total: 2500,
    currency: "gbp",
  });

  it("accepts a correctly signed, recent event, and reads a paid card top-up", () => {
    const { body, header } = signed(completed);
    expect(provider.parseWebhook(body, header)).toEqual([
      {
        type: "checkout.session.completed",
        eventId: "evt_checkout.session.completed",
        kind: "funding.succeeded",
        reference: "ajf_reference_0001",
        providerId: "cs_1",
        amount: "2500",
        currency: "GBP",
      },
    ]);
  });

  it("refuses a wrong secret, a changed body, no header, a malformed header, and an old or future time", () => {
    const good = signed(completed);
    expect(() =>
      provider.parseWebhook(good.body, signed(completed, NOW / 1000, "whsec_other").header),
    ).toThrow(InvalidWebhookSignature);
    expect(() =>
      provider.parseWebhook(
        Buffer.from(good.body.toString().replace("2500", "250000")),
        good.header,
      ),
    ).toThrow(InvalidWebhookSignature);
    expect(() => provider.parseWebhook(good.body, undefined)).toThrow(InvalidWebhookSignature);
    expect(() => provider.parseWebhook(good.body, "v1=abc")).toThrow(InvalidWebhookSignature);
    const old = signed(completed, NOW / 1000 - WEBHOOK_TOLERANCE_SECONDS - 1);
    expect(() => provider.parseWebhook(old.body, old.header)).toThrow(InvalidWebhookSignature);
    const future = signed(completed, NOW / 1000 + WEBHOOK_TOLERANCE_SECONDS + 1);
    expect(() => provider.parseWebhook(future.body, future.header)).toThrow(
      InvalidWebhookSignature,
    );
  });

  it("accepts any one of several signatures (Stripe sends more than one while a secret is rolled)", () => {
    const { body, header } = signed(completed);
    expect(provider.parseWebhook(body, `${header},v1=${"0".repeat(64)}`)).toHaveLength(1);
    expect(
      provider.parseWebhook(body, header.replace(",v1=", `,v1=${"0".repeat(64)},v1=`)),
    ).toHaveLength(1);
  });

  const read = (type: string, object: object) => {
    const { body, header } = signed(event(type, object));
    return provider.parseWebhook(body, header)[0]!;
  };

  it("counts a card top-up once, from its session; an unpaid or a setup session is not a top-up", () => {
    expect(
      read("checkout.session.completed", { mode: "payment", payment_status: "unpaid" }).kind,
    ).toBe("ignored");
    expect(
      read("checkout.session.completed", { mode: "setup", payment_status: "no_payment_required" })
        .kind,
    ).toBe("ignored");
    expect(
      read("checkout.session.async_payment_succeeded", {
        mode: "payment",
        payment_status: "paid",
        metadata: { reference: "r" },
        amount_total: 5,
        currency: "gbp",
      }).kind,
    ).toBe("funding.succeeded");
    expect(
      read("checkout.session.expired", { mode: "payment", metadata: { reference: "r" } }),
    ).toMatchObject({ kind: "funding.failed", reference: "r" });
    expect(
      read("payment_intent.succeeded", {
        metadata: { reference: "r", source: "checkout" },
        amount_received: 5,
        currency: "gbp",
      }).kind,
    ).toBe("ignored");
  });

  it("reads Direct Debit collections, counted only once paid out, and their failures", () => {
    expect(
      read("payment_intent.succeeded", {
        id: "pi_1",
        metadata: { reference: "r", source: "mandate" },
        amount_received: 1000,
        currency: "gbp",
      }),
    ).toEqual({
      type: "payment_intent.succeeded",
      eventId: "evt_payment_intent.succeeded",
      kind: "funding.succeeded",
      reference: "r",
      providerId: "pi_1",
      stage: "paid_out",
      amount: "1000",
      currency: "GBP",
    });
    expect(
      read("payment_intent.payment_failed", { metadata: { reference: "r", source: "mandate" } }),
    ).toMatchObject({ kind: "funding.failed", reference: "r" });
  });

  it("reads a Direct Debit being set up, failing to, and being cancelled at the bank", () => {
    expect(
      read("setup_intent.succeeded", {
        customer: "cus_1",
        payment_method: "pm_1",
        mandate: "mandate_1",
        metadata: { reference: "ajm_ref_000000001" },
      }),
    ).toMatchObject({
      kind: "mandate.active",
      reference: "ajm_ref_000000001",
      authorizationCode: "cus_1:pm_1",
      mandateId: "mandate_1",
    });
    expect(read("setup_intent.succeeded", { metadata: { reference: "r" } }).kind).toBe("ignored");
    expect(read("setup_intent.setup_failed", { metadata: { reference: "r" } })).toMatchObject({
      kind: "mandate.failed",
      reference: "r",
    });
    expect(read("mandate.updated", { id: "mandate_1", status: "inactive" })).toMatchObject({
      kind: "mandate.cancelled",
      mandateId: "mandate_1",
    });
    expect(read("mandate.updated", { id: "mandate_1", status: "active" }).kind).toBe("ignored");
    expect(read("customer.created", {}).kind).toBe("ignored");
  });
});

describe("Direct Debit", () => {
  it("makes a customer, then a setup session for Bacs, each keyed by our reference", async () => {
    const { seen, provider } = stripe((call) =>
      call.url.endsWith("/v1/customers")
        ? json(200, { id: "cus_1" })
        : json(200, { id: "cs_setup", url: "https://checkout.stripe.test/setup" }),
    );
    const made = await provider.createMandate({
      reference: "ajm_ref_000000001",
      email: "a@b.c",
      returnUrl: "https://app/return",
    });
    expect(made).toEqual({
      providerId: "cs_setup",
      action: { type: "redirect", url: "https://checkout.stripe.test/setup" },
    });
    expect(seen.map((s) => s.headers["Idempotency-Key"])).toEqual([
      "customer:ajm_ref_000000001",
      "mandate:ajm_ref_000000001",
    ]);
    expect(seen[1]!.body.get("mode")).toBe("setup");
    expect(seen[1]!.body.get("customer")).toBe("cus_1");
    expect(seen[1]!.body.get("payment_method_types[0]")).toBe("bacs_debit");
    expect(seen[1]!.body.get("setup_intent_data[metadata][reference]")).toBe("ajm_ref_000000001");
  });

  it("collects off-session from the saved account, marked as ours so its webhook counts", async () => {
    const { seen, provider } = stripe(() => json(200, { id: "pi_1", status: "processing" }));
    expect(
      await provider.chargeMandate({
        reference: "ajp_ref_000000001",
        amount: "1000",
        email: "a@b.c",
        authorizationCode: "cus_1:pm_1",
      }),
    ).toEqual({ providerId: "pi_1" });
    const body = seen[0]!.body;
    expect([
      body.get("customer"),
      body.get("payment_method"),
      body.get("off_session"),
      body.get("confirm"),
    ]).toEqual(["cus_1", "pm_1", "true", "true"]);
    expect(body.get("metadata[source]")).toBe("mandate");
    expect(seen[0]!.headers["Idempotency-Key"]).toBe("charge:ajp_ref_000000001");
  });

  it("refuses to collect with a saved account it can't read, and reports a refused collection", async () => {
    const { seen, provider } = stripe(() =>
      json(200, {
        id: "pi_1",
        status: "requires_payment_method",
        last_payment_error: { message: "Account closed" },
      }),
    );
    await expect(
      provider.chargeMandate({
        reference: "r".repeat(16),
        amount: "1",
        email: "a",
        authorizationCode: "AUTH_paystack",
      }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    expect(seen).toHaveLength(0);
    await expect(
      provider.chargeMandate({
        reference: "r".repeat(16),
        amount: "1",
        email: "a",
        authorizationCode: "cus_1:pm_1",
      }),
    ).rejects.toThrow("Account closed");
  });

  it("cancels by detaching the saved account, and does nothing when none was saved", async () => {
    const { seen, provider } = stripe(() => json(200, { id: "pm_1" }));
    await provider.cancelMandate({
      providerId: "cs_1",
      providerMandateId: null,
      authorizationCode: null,
    });
    expect(seen).toHaveLength(0);
    await provider.cancelMandate({
      providerId: "cs_1",
      providerMandateId: "mandate_1",
      authorizationCode: "cus_1:pm_1",
    });
    expect(seen[0]!.url).toBe("https://api.stripe.com/v1/payment_methods/pm_1/detach");
  });
});

describe("what is not offered", () => {
  it("says it pays nobody out, and refuses if asked anyway", async () => {
    const { seen, provider } = stripe(() => json(200, {}));
    expect(provider.supports).toEqual({ fund: ["card"], mandate: true, payout: false });
    await expect(provider.resolveAccount()).rejects.toBeInstanceOf(ProviderRejected);
    await expect(provider.createRecipient()).rejects.toBeInstanceOf(ProviderRejected);
    await expect(provider.transfer()).rejects.toBeInstanceOf(ProviderRejected);
    expect(await provider.verifyTransfer()).toBe("not_found");
    expect(seen).toHaveLength(0);
  });

  it("keeps Stripe's own words for a refusal, and calls a 5xx not knowing", async () => {
    const refused = stripe(() => json(402, { error: { message: "Your card was declined." } }));
    await expect(
      refused.provider.initializeFunding({
        reference: "r".repeat(16),
        amount: "1",
        email: "a",
        method: "card",
        returnUrl: "https://x",
      }),
    ).rejects.toThrow("Your card was declined.");
    const down = stripe(() => json(503, {}));
    await expect(
      down.provider.initializeFunding({
        reference: "r".repeat(16),
        amount: "1",
        email: "a",
        method: "card",
        returnUrl: "https://x",
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailable);
  });
});
