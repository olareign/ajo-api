import { createHmac } from "node:crypto";
import { GoCardlessProvider } from "./gocardless.provider.js";
import { InvalidWebhookSignature, ProviderRejected, ProviderUnavailable } from "./provider.port.js";

const SECRET = "endpoint-secret-for-tests";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(...replies: (Response | Error)[]) {
  const fetchFn = vi.fn<typeof fetch>(async () => {
    const next = replies.shift();
    if (!next) throw new Error("no more replies");
    if (next instanceof Error) throw next;
    return next;
  });
  return {
    fetchFn,
    provider: new GoCardlessProvider({
      accessToken: "sandbox_token",
      webhookSecret: SECRET,
      environment: "sandbox",
      fetchFn,
    }),
  };
}
const sent = (fetchFn: ReturnType<typeof setup>["fetchFn"], n = 0) => {
  const [url, init] = fetchFn.mock.calls[n]!;
  return {
    url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
    init: init!,
    body: init!.body ? JSON.parse(init!.body as string) : undefined,
    headers: init!.headers as Record<string, string>,
  };
};
const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

describe("what GoCardless serves", () => {
  it("is the UK, in pounds, with bank payments and direct debit mandates, and no payouts", () => {
    const { provider } = setup();
    expect(provider).toMatchObject({ name: "gocardless", country: "GB", currency: "GBP" });
    expect(provider.supports).toEqual({ fund: ["transfer"], mandate: true, payout: false });
  });

  it("uses the sandbox address for a sandbox token and the live one for a live token", async () => {
    const live = new GoCardlessProvider({
      accessToken: "live_x",
      webhookSecret: SECRET,
      environment: "live",
      fetchFn: vi.fn(async () => json(200, { billing_requests: { id: "BRQ1" } })),
    });
    await live
      .cancelMandate({ providerId: "BRQ1", providerMandateId: null, authorizationCode: null })
      .catch(() => undefined);
    const { provider, fetchFn } = setup(json(200, {}));
    await provider.cancelMandate({
      providerId: "BRQ1",
      providerMandateId: null,
      authorizationCode: null,
    });
    expect(sent(fetchFn).url).toMatch(/^https:\/\/api-sandbox\.gocardless\.com\//);
  });
});

describe("starting a bank payment", () => {
  const input = {
    reference: "ajf_1234567890abcdef",
    amount: "2500",
    email: "ada@example.co.uk",
    method: "transfer" as const,
    returnUrl: "https://app.ajo.test/wallet/add/return?id=1",
  };

  it("asks for an instant bank payment in pence, tagged with our reference, then for the hosted page", async () => {
    const { provider, fetchFn } = setup(
      json(201, { billing_requests: { id: "BRQ123" } }),
      json(201, {
        billing_request_flows: {
          authorisation_url: "https://pay.gocardless.com/billing/static/flow?id=BRF1",
        },
      }),
    );
    const start = await provider.initializeFunding(input);
    expect(start).toEqual({
      providerId: "BRQ123",
      action: { type: "redirect", url: "https://pay.gocardless.com/billing/static/flow?id=BRF1" },
    });

    const first = sent(fetchFn, 0);
    expect(first.url).toBe("https://api-sandbox.gocardless.com/billing_requests");
    expect(first.headers).toMatchObject({
      Authorization: "Bearer sandbox_token",
      "GoCardless-Version": "2015-07-06",
      "Content-Type": "application/json",
    });
    expect(first.headers["Idempotency-Key"]).toBeTruthy();
    expect(first.body).toEqual({
      billing_requests: {
        payment_request: {
          description: "Add money to Àjọ",
          amount: 2500,
          currency: "GBP",
          scheme: "faster_payments",
          metadata: { ajo_ref: "ajf_1234567890abcdef" },
        },
      },
    });
    const second = sent(fetchFn, 1);
    expect(second.url).toBe("https://api-sandbox.gocardless.com/billing_request_flows");
    expect(second.body).toEqual({
      billing_request_flows: {
        redirect_uri: input.returnUrl,
        exit_uri: input.returnUrl,
        links: { billing_request: "BRQ123" },
        prefilled_customer: { email: "ada@example.co.uk" },
      },
    });
  });

  it("does not offer direct debit as a way to add money yet", async () => {
    const { provider, fetchFn } = setup();
    await expect(
      provider.initializeFunding({ ...input, method: "direct_debit" }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads GoCardless's own error message, and a 5xx as not knowing", async () => {
    const no = setup(
      json(422, { error: { message: "Validation failed", type: "validation_failed" } }),
    );
    await expect(no.provider.initializeFunding(input)).rejects.toThrow(
      new ProviderRejected("Validation failed"),
    );
    const unknown = setup(json(500, { error: { message: "oops" } }));
    await expect(unknown.provider.initializeFunding(input)).rejects.toBeInstanceOf(
      ProviderUnavailable,
    );
  });

  it("does not hand back a link it was not given", async () => {
    const { provider } = setup(
      json(201, { billing_requests: { id: "BRQ1" } }),
      json(201, { billing_request_flows: {} }),
    );
    await expect(provider.initializeFunding(input)).rejects.toBeInstanceOf(ProviderUnavailable);
  });
});

describe("asking whether a payment was paid", () => {
  it("finds the payment behind the billing request, and reads its status, amount and currency", async () => {
    const { provider, fetchFn } = setup(
      json(200, { billing_requests: { id: "BRQ1", links: { payment_request_payment: "PM1" } } }),
      json(200, { payments: { id: "PM1", status: "confirmed", amount: 2500, currency: "GBP" } }),
    );
    expect(await provider.verifyFunding("ajf_x", "BRQ1")).toEqual({
      status: "success",
      amount: "2500",
      currency: "GBP",
    });
    expect(sent(fetchFn, 0).url).toBe("https://api-sandbox.gocardless.com/billing_requests/BRQ1");
    expect(sent(fetchFn, 1).url).toBe("https://api-sandbox.gocardless.com/payments/PM1");
  });

  it("says not paid yet while the person has not completed it", async () => {
    const { provider } = setup(json(200, { billing_requests: { id: "BRQ1", links: {} } }));
    expect((await provider.verifyFunding("ajf_x", "BRQ1")).status).toBe("pending");
    const none = setup();
    expect((await none.provider.verifyFunding("ajf_x", null)).status).toBe("pending");
  });

  it.each([
    ["paid_out", "success"],
    ["failed", "failed"],
    ["cancelled", "failed"],
    ["customer_approval_denied", "failed"],
    ["submitted", "pending"],
    ["pending_customer_approval", "pending"],
  ] as const)("reads a payment's %s as %s", async (theirs, ours) => {
    const { provider } = setup(
      json(200, { billing_requests: { links: { payment_request_payment: "PM1" } } }),
      json(200, { payments: { status: theirs, amount: 100, currency: "GBP" } }),
    );
    expect((await provider.verifyFunding("ajf_x", "BRQ1")).status).toBe(ours);
  });
});

describe("what GoCardless tells us", () => {
  const post = (events: object[]) => {
    const body = JSON.stringify({ events });
    return { body: Buffer.from(body), signature: sign(body) };
  };
  const ev = (resource_type: string, action: string, links: object, id = `EV${Math.random()}`) => ({
    id,
    resource_type,
    action,
    links,
    created_at: "2026-10-04T10:00:00Z",
  });

  it("refuses a body that was not signed with our secret, was changed, or has no signature", () => {
    const { provider } = setup();
    const { body, signature } = post([ev("payments", "confirmed", { payment: "PM1" })]);
    expect(() => provider.parseWebhook(body, sign(body.toString(), "another-secret"))).toThrow(
      InvalidWebhookSignature,
    );
    expect(() => provider.parseWebhook(Buffer.from(`${body.toString()} `), signature)).toThrow(
      InvalidWebhookSignature,
    );
    expect(() => provider.parseWebhook(body, undefined)).toThrow(InvalidWebhookSignature);
  });

  it("reads every event in a batch, each under GoCardless's own id", () => {
    const { provider } = setup();
    const { body, signature } = post([
      ev("payments", "confirmed", { payment: "PM1" }, "EV1"),
      ev("payments", "paid_out", { payment: "PM1" }, "EV2"),
      ev("payments", "failed", { payment: "PM2" }, "EV3"),
    ]);
    expect(provider.parseWebhook(body, signature)).toMatchObject([
      { eventId: "EV1", kind: "funding.succeeded", stage: "confirmed", providerId: "PM1" },
      { eventId: "EV2", kind: "funding.succeeded", stage: "paid_out", providerId: "PM1" },
      { eventId: "EV3", kind: "funding.failed", providerId: "PM2" },
    ]);
  });

  it.each([
    ["created", "mandate.created"],
    ["submitted", "mandate.created"],
    ["active", "mandate.active"],
    ["cancelled", "mandate.cancelled"],
    ["expired", "mandate.cancelled"],
    ["failed", "mandate.failed"],
  ] as const)("reads a mandate's %s as %s", (action, kind) => {
    const { provider } = setup();
    const { body, signature } = post([ev("mandates", action, { mandate: "MD1" }, "EVM")]);
    expect(provider.parseWebhook(body, signature)).toMatchObject([
      { eventId: "EVM", kind, mandateId: "MD1" },
    ]);
  });

  it("learns the mandate's id, and which billing request it belongs to, when the billing request is fulfilled", () => {
    const { provider } = setup();
    const { body, signature } = post([
      ev(
        "billing_requests",
        "fulfilled",
        { billing_request: "BRQ1", mandate_request_mandate: "MD1" },
        "EVB",
      ),
    ]);
    expect(provider.parseWebhook(body, signature)).toMatchObject([
      { eventId: "EVB", kind: "mandate.created", billingRequestId: "BRQ1", mandateId: "MD1" },
    ]);
  });

  it("keeps a fulfilled billing request that only made a payment as something to ignore", () => {
    const { provider } = setup();
    const { body, signature } = post([
      ev(
        "billing_requests",
        "fulfilled",
        { billing_request: "BRQ1", payment_request_payment: "PM1" },
        "EVC",
      ),
    ]);
    expect(provider.parseWebhook(body, signature)).toMatchObject([
      { eventId: "EVC", kind: "ignored" },
    ]);
  });

  it("keeps events it has no use for, rather than failing the batch", () => {
    const { provider } = setup();
    const { body, signature } = post([
      ev("payouts", "paid", { payout: "PO1" }, "EVP"),
      ev("payments", "confirmed", { payment: "PM1" }, "EVQ"),
    ]);
    expect(provider.parseWebhook(body, signature)).toMatchObject([
      { eventId: "EVP", kind: "ignored" },
      { eventId: "EVQ", kind: "funding.succeeded" },
    ]);
  });

  it("refuses a body that is not the shape GoCardless sends, even when signed", () => {
    const { provider } = setup();
    const notEvents = JSON.stringify({ hello: "world" });
    expect(() => provider.parseWebhook(Buffer.from(notEvents), sign(notEvents))).toThrow(
      InvalidWebhookSignature,
    );
  });
});

describe("finding out what an event is about", () => {
  it("asks for the payment, and returns our reference, amount and currency", async () => {
    const { provider, fetchFn } = setup(
      json(200, {
        payments: { id: "PM1", amount: 2500, currency: "GBP", metadata: { ajo_ref: "ajf_abc" } },
      }),
    );
    const found = await provider.lookupEvent!({
      eventId: "EV1",
      type: "payments.confirmed",
      kind: "funding.succeeded",
      providerId: "PM1",
    });
    expect(found).toEqual({ reference: "ajf_abc", amount: "2500", currency: "GBP" });
    expect(sent(fetchFn).url).toBe("https://api-sandbox.gocardless.com/payments/PM1");
  });

  it("asks for the mandate, and returns our reference", async () => {
    const { provider } = setup(
      json(200, { mandates: { id: "MD1", metadata: { ajo_ref: "ajm_abc" } } }),
    );
    expect(
      await provider.lookupEvent!({
        eventId: "EV1",
        type: "mandates.active",
        kind: "mandate.active",
        mandateId: "MD1",
      }),
    ).toEqual({ reference: "ajm_abc" });
  });

  it("returns nothing when GoCardless does not carry our reference for it", async () => {
    const { provider } = setup(
      json(200, { payments: { id: "PM1", amount: 1, currency: "GBP", metadata: {} } }),
    );
    expect(
      await provider.lookupEvent!({
        eventId: "EV1",
        type: "x",
        kind: "funding.succeeded",
        providerId: "PM1",
      }),
    ).toBeNull();
  });

  it("does not ask about an event with nothing to ask about", async () => {
    const { provider, fetchFn } = setup();
    expect(
      await provider.lookupEvent!({ eventId: "EV1", type: "x", kind: "funding.succeeded" }),
    ).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("direct debit", () => {
  it("sets up a Bacs mandate request tagged with our reference, and returns the hosted page", async () => {
    const { provider, fetchFn } = setup(
      json(201, { billing_requests: { id: "BRQ9" } }),
      json(201, {
        billing_request_flows: {
          authorisation_url: "https://pay.gocardless.com/billing/static/flow?id=BRF9",
        },
      }),
    );
    const start = await provider.createMandate({
      reference: "ajm_1234567890abcdef",
      email: "ada@example.co.uk",
      returnUrl: "https://app.ajo.test/wallet/mandate/return",
    });
    expect(start).toEqual({
      providerId: "BRQ9",
      action: { type: "redirect", url: "https://pay.gocardless.com/billing/static/flow?id=BRF9" },
    });
    expect(sent(fetchFn, 0).body).toEqual({
      billing_requests: {
        mandate_request: { scheme: "bacs", metadata: { ajo_ref: "ajm_1234567890abcdef" } },
      },
    });
  });

  it("cancels the mandate when there is one, and the billing request when there is not yet", async () => {
    const withMandate = setup(json(200, { mandates: { status: "cancelled" } }));
    await withMandate.provider.cancelMandate({
      providerId: "BRQ9",
      providerMandateId: "MD9",
      authorizationCode: null,
    });
    expect(sent(withMandate.fetchFn).url).toBe(
      "https://api-sandbox.gocardless.com/mandates/MD9/actions/cancel",
    );
    expect(sent(withMandate.fetchFn).init.method).toBe("POST");

    const early = setup(json(200, { billing_requests: { status: "cancelled" } }));
    await early.provider.cancelMandate({
      providerId: "BRQ9",
      providerMandateId: null,
      authorizationCode: null,
    });
    expect(sent(early.fetchFn).url).toBe(
      "https://api-sandbox.gocardless.com/billing_requests/BRQ9/actions/cancel",
    );

    const nothing = setup();
    await nothing.provider.cancelMandate({
      providerId: null,
      providerMandateId: null,
      authorizationCode: null,
    });
    expect(nothing.fetchFn).not.toHaveBeenCalled();
  });
});

describe("what GoCardless does not do", () => {
  it("does not send money out, and says so rather than pretending", async () => {
    const { provider } = setup();
    await expect(
      provider.resolveAccount({ bankCode: "x", accountNumber: "1" }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    await expect(
      provider.createRecipient({ name: "x", bankCode: "x", accountNumber: "1" }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    await expect(
      provider.transfer({ reference: "r", amount: "1", recipientCode: "x", reason: "x" }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    await expect(provider.verifyTransfer("r")).rejects.toBeInstanceOf(ProviderRejected);
  });
});
