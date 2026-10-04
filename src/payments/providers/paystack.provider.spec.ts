import { createHmac } from "node:crypto";
import { InvalidWebhookSignature, ProviderRejected, ProviderUnavailable } from "./provider.port.js";
import { PaystackProvider } from "./paystack.provider.js";

const SECRET = "sk_test_abc123";
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
    provider: new PaystackProvider({
      secretKey: SECRET,
      baseUrl: "https://api.paystack.test",
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
  createHmac("sha512", secret).update(body).digest("hex");

describe("what Paystack serves", () => {
  it("is Nigeria, in naira, with card, transfer, USSD, direct debit and payouts", () => {
    const { provider } = setup();
    expect(provider).toMatchObject({ name: "paystack", country: "NG", currency: "NGN" });
    expect(provider.supports).toEqual({
      fund: ["card", "transfer", "ussd"],
      mandate: true,
      payout: true,
    });
  });
});

describe("starting a payment", () => {
  it.each([
    ["card", ["card"]],
    ["transfer", ["bank_transfer"]],
    ["ussd", ["ussd"]],
  ] as const)(
    "asks for the %s channel only, in kobo, with our reference and the way back",
    async (method, channels) => {
      const { provider, fetchFn } = setup(
        json(200, {
          status: true,
          data: {
            authorization_url: "https://checkout.paystack.com/abc",
            access_code: "abc",
            reference: "ajf_1",
          },
        }),
      );
      const start = await provider.initializeFunding({
        reference: "ajf_1234567890abcdef",
        amount: "500000",
        email: "ada@example.com",
        method,
        returnUrl: "https://app.ajo.test/wallet/add/return?id=1",
      });
      expect(start).toEqual({
        providerId: "abc",
        action: { type: "redirect", url: "https://checkout.paystack.com/abc" },
      });
      const call = sent(fetchFn);
      expect(call.url).toBe("https://api.paystack.test/transaction/initialize");
      expect(call.init.method).toBe("POST");
      expect(call.headers.Authorization).toBe(`Bearer ${SECRET}`);
      expect(call.headers["Content-Type"]).toBe("application/json");
      expect(call.body).toMatchObject({
        email: "ada@example.com",
        amount: "500000",
        currency: "NGN",
        reference: "ajf_1234567890abcdef",
        callback_url: "https://app.ajo.test/wallet/add/return?id=1",
        channels,
      });
    },
  );

  it("never sends the secret key anywhere but the Authorization header", async () => {
    const { provider, fetchFn } = setup(
      json(200, {
        status: true,
        data: { authorization_url: "https://x.test/a", access_code: "a" },
      }),
    );
    await provider.initializeFunding({
      reference: "r".repeat(20),
      amount: "100",
      email: "a@b.co",
      method: "card",
      returnUrl: "https://app/x",
    });
    const call = sent(fetchFn);
    expect(call.url).not.toContain(SECRET);
    expect(JSON.stringify(call.body)).not.toContain(SECRET);
  });

  it("treats a clear refusal as a refusal, with Paystack's own words", async () => {
    const { provider } = setup(json(400, { status: false, message: "Invalid Amount Sent" }));
    await expect(
      provider.initializeFunding({
        reference: "r".repeat(20),
        amount: "1",
        email: "a@b.co",
        method: "card",
        returnUrl: "https://app/x",
      }),
    ).rejects.toThrow(new ProviderRejected("Invalid Amount Sent"));
  });

  it.each([[500], [502], [429]])("treats a %i as not knowing what happened", async (status) => {
    const { provider } = setup(json(status, { message: "busy" }));
    await expect(
      provider.initializeFunding({
        reference: "r".repeat(20),
        amount: "1",
        email: "a@b.co",
        method: "card",
        returnUrl: "https://app/x",
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("treats no answer, and an answer it cannot read, as not knowing", async () => {
    const dropped = setup(new TypeError("fetch failed"));
    await expect(
      dropped.provider.initializeFunding({
        reference: "r".repeat(20),
        amount: "1",
        email: "a@b.co",
        method: "card",
        returnUrl: "https://app/x",
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailable);
    const garbled = setup(new Response("<html>oops</html>", { status: 200 }));
    await expect(
      garbled.provider.initializeFunding({
        reference: "r".repeat(20),
        amount: "1",
        email: "a@b.co",
        method: "card",
        returnUrl: "https://app/x",
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it("will not hand back a payment link it was not given", async () => {
    const { provider } = setup(json(200, { status: true, data: {} }));
    await expect(
      provider.initializeFunding({
        reference: "r".repeat(20),
        amount: "1",
        email: "a@b.co",
        method: "card",
        returnUrl: "https://app/x",
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailable);
  });
});

describe("asking whether a payment was paid", () => {
  it("reads the status, amount and currency from the verify call", async () => {
    const { provider, fetchFn } = setup(
      json(200, { status: true, data: { status: "success", amount: 500000, currency: "NGN" } }),
    );
    expect(await provider.verifyFunding("ajf_ref_0000000000", null)).toEqual({
      status: "success",
      amount: "500000",
      currency: "NGN",
    });
    expect(sent(fetchFn).url).toBe(
      "https://api.paystack.test/transaction/verify/ajf_ref_0000000000",
    );
    expect(sent(fetchFn).init.method).toBe("GET");
  });

  it.each([
    ["failed", "failed"],
    ["abandoned", "pending"],
    ["pending", "pending"],
    ["ongoing", "pending"],
  ] as const)("reads %s as %s", async (theirs, ours) => {
    const { provider } = setup(
      json(200, { status: true, data: { status: theirs, amount: 100, currency: "NGN" } }),
    );
    expect((await provider.verifyFunding("ajf_ref_0000000000", null)).status).toBe(ours);
  });

  it("reads a reference Paystack has not heard of as not paid yet", async () => {
    const { provider } = setup(
      json(404, { status: false, message: "Transaction reference not found" }),
    );
    expect((await provider.verifyFunding("ajf_ref_0000000000", null)).status).toBe("pending");
  });
});

describe("what Paystack tells us", () => {
  const post = (event: object) => {
    const body = JSON.stringify(event);
    return { body: Buffer.from(body), signature: sign(body) };
  };

  it("refuses a body that was not signed with our key, was changed, or has no signature", () => {
    const { provider } = setup();
    const { body, signature } = post({
      event: "charge.success",
      data: { id: 1, reference: "r", amount: 100, currency: "NGN" },
    });
    expect(() =>
      provider.parseWebhook(body, sign(body.toString(), "sk_test_someone_else")),
    ).toThrow(InvalidWebhookSignature);
    expect(() => provider.parseWebhook(Buffer.from(`${body.toString()} `), signature)).toThrow(
      InvalidWebhookSignature,
    );
    expect(() => provider.parseWebhook(body, undefined)).toThrow(InvalidWebhookSignature);
    expect(() => provider.parseWebhook(body, "short")).toThrow(InvalidWebhookSignature);
  });

  it("reads a successful charge as money in, in kobo, by our reference", () => {
    const { provider } = setup();
    const { body, signature } = post({
      event: "charge.success",
      data: {
        id: 1504238596,
        status: "success",
        reference: "ajf_abc",
        amount: 10000,
        currency: "NGN",
        channel: "card",
      },
    });
    expect(provider.parseWebhook(body, signature)).toEqual([
      {
        eventId: "charge.success:1504238596",
        type: "charge.success",
        kind: "funding.succeeded",
        reference: "ajf_abc",
        amount: "10000",
        currency: "NGN",
      },
    ]);
  });

  it.each([
    ["transfer.success", "payout.succeeded"],
    ["transfer.failed", "payout.failed"],
    ["transfer.reversed", "payout.reversed"],
  ] as const)("reads %s as %s, by our reference", (event, kind) => {
    const { provider } = setup();
    const { body, signature } = post({
      event,
      data: {
        id: 9,
        reference: "ajw_xyz",
        amount: 40000,
        currency: "NGN",
        transfer_code: "TRF_1",
        status: "x",
      },
    });
    expect(provider.parseWebhook(body, signature)).toMatchObject([
      { kind, reference: "ajw_xyz", eventId: `${event}:TRF_1` },
    ]);
  });

  it("gives a failure and a reversal of the same transfer different ids, and a repeat the same one", () => {
    const { provider } = setup();
    const data = {
      id: 9,
      reference: "ajw_xyz",
      amount: 40000,
      currency: "NGN",
      transfer_code: "TRF_1",
    };
    const a = post({ event: "transfer.failed", data });
    const b = post({ event: "transfer.reversed", data });
    const ids = [a, b, a].map((p) => provider.parseWebhook(p.body, p.signature)[0]!.eventId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toBe(ids[2]);
  });

  it("reads a direct-debit authorization as a mandate, naming the customer and the authorization", () => {
    const { provider } = setup();
    const created = post({
      event: "direct_debit.authorization.created",
      data: { authorization_code: "AUTH_1", active: false, customer: { email: "ada@example.com" } },
    });
    const active = post({
      event: "direct_debit.authorization.active",
      data: { authorization_code: "AUTH_1", active: true, customer: { email: "ada@example.com" } },
    });
    expect(provider.parseWebhook(created.body, created.signature)).toMatchObject([
      { kind: "mandate.created", customerEmail: "ada@example.com", authorizationCode: "AUTH_1" },
    ]);
    expect(provider.parseWebhook(active.body, active.signature)).toMatchObject([
      { kind: "mandate.active", customerEmail: "ada@example.com", authorizationCode: "AUTH_1" },
    ]);
  });

  it("keeps an event it has no use for, with an id of its own, rather than failing", () => {
    const { provider } = setup();
    const { body, signature } = post({ event: "subscription.create", data: { id: 5 } });
    const [event] = provider.parseWebhook(body, signature);
    expect(event).toMatchObject({ kind: "ignored", type: "subscription.create" });
    expect(event!.eventId).toBeTruthy();
  });

  it("is not fooled by an amount that is not a whole number of kobo", () => {
    const { provider } = setup();
    const { body, signature } = post({
      event: "charge.success",
      data: { id: 1, reference: "ajf_abc", amount: 100.5, currency: "NGN" },
    });
    expect(provider.parseWebhook(body, signature)[0]).toMatchObject({
      kind: "funding.succeeded",
      amount: undefined,
    });
  });

  it("refuses a body that is not JSON, even when signed", () => {
    const { provider } = setup();
    const body = "not json";
    expect(() => provider.parseWebhook(Buffer.from(body), sign(body))).toThrow(
      InvalidWebhookSignature,
    );
  });
});

describe("auto-debit", () => {
  it("asks for consent through the hosted page and returns where to send the person", async () => {
    const { provider, fetchFn } = setup(
      json(200, {
        status: true,
        data: {
          redirect_url: "https://link.paystack.co/abc",
          access_code: "abc",
          reference: "dfbz",
        },
      }),
    );
    const start = await provider.createMandate({
      reference: "ajm_1234567890abcdef",
      email: "ada@example.com",
      returnUrl: "https://app.ajo.test/wallet/mandate/return",
    });
    expect(start).toEqual({
      providerId: "dfbz",
      action: { type: "redirect", url: "https://link.paystack.co/abc" },
    });
    expect(sent(fetchFn).url).toBe("https://api.paystack.test/customer/authorization/initialize");
    expect(sent(fetchFn).body).toEqual({
      email: "ada@example.com",
      channel: "direct_debit",
      callback_url: "https://app.ajo.test/wallet/mandate/return",
    });
  });

  it("deactivates the authorization when cancelling, and does nothing when it never became one", async () => {
    const { provider, fetchFn } = setup(
      json(200, { status: true, message: "Authorization has been deactivated" }),
    );
    await provider.cancelMandate({
      providerId: "dfbz",
      providerMandateId: null,
      authorizationCode: "AUTH_1",
    });
    expect(sent(fetchFn).url).toBe("https://api.paystack.test/customer/authorization/deactivate");
    expect(sent(fetchFn).body).toEqual({ authorization_code: "AUTH_1" });

    const idle = setup();
    await idle.provider.cancelMandate({
      providerId: "dfbz",
      providerMandateId: null,
      authorizationCode: null,
    });
    expect(idle.fetchFn).not.toHaveBeenCalled();
  });
});

describe("paying out", () => {
  it("looks up the name an account is held under", async () => {
    const { provider, fetchFn } = setup(
      json(200, { status: true, data: { account_number: "0123456789", account_name: "ADA OLA" } }),
    );
    expect(await provider.resolveAccount({ bankCode: "058", accountNumber: "0123456789" })).toEqual(
      { accountName: "ADA OLA" },
    );
    expect(sent(fetchFn).url).toBe(
      "https://api.paystack.test/bank/resolve?account_number=0123456789&bank_code=058",
    );
  });

  it("reads an account Paystack cannot find as a refusal", async () => {
    const { provider } = setup(
      json(422, {
        status: false,
        message: "Could not resolve account name. Check parameters or try again.",
      }),
    );
    await expect(
      provider.resolveAccount({ bankCode: "058", accountNumber: "0000000000" }),
    ).rejects.toBeInstanceOf(ProviderRejected);
  });

  it("makes a recipient for the account and keeps only its code", async () => {
    const { provider, fetchFn } = setup(
      json(201, { status: true, data: { recipient_code: "RCP_abc" } }),
    );
    expect(
      await provider.createRecipient({
        name: "ADA OLA",
        bankCode: "058",
        accountNumber: "0123456789",
      }),
    ).toEqual({ recipientCode: "RCP_abc" });
    expect(sent(fetchFn).body).toEqual({
      type: "nuban",
      name: "ADA OLA",
      account_number: "0123456789",
      bank_code: "058",
      currency: "NGN",
    });
  });

  it("sends a transfer from the balance, in kobo, under our reference", async () => {
    const { provider, fetchFn } = setup(
      json(200, { status: true, data: { status: "pending", transfer_code: "TRF_1" } }),
    );
    const started = await provider.transfer({
      reference: "ajw_1234567890abcdef",
      amount: "40000",
      recipientCode: "RCP_abc",
      reason: "Àjọ withdrawal",
    });
    expect(started).toEqual({ status: "pending", providerId: "TRF_1" });
    expect(sent(fetchFn).url).toBe("https://api.paystack.test/transfer");
    expect(sent(fetchFn).body).toEqual({
      source: "balance",
      amount: "40000",
      recipient: "RCP_abc",
      reference: "ajw_1234567890abcdef",
      reason: "Àjọ withdrawal",
    });
  });

  it.each([
    ["success", "success"],
    ["otp", "otp"],
    ["failed", "failed"],
    ["received", "pending"],
    ["processing", "pending"],
  ] as const)("reads a transfer's %s as %s", async (theirs, ours) => {
    const { provider } = setup(
      json(200, { status: true, data: { status: theirs, transfer_code: "TRF_1" } }),
    );
    expect(
      (
        await provider.transfer({
          reference: "ajw_1234567890abcdef",
          amount: "1",
          recipientCode: "RCP_abc",
          reason: "x",
        })
      ).status,
    ).toBe(ours);
  });

  it("reads 'insufficient balance' and other 4xx answers to a transfer as a refusal, and a 5xx as not knowing", async () => {
    const no = setup(
      json(400, { status: false, message: "Your balance is not enough to fulfil this request" }),
    );
    await expect(
      no.provider.transfer({
        reference: "ajw_1234567890abcdef",
        amount: "1",
        recipientCode: "RCP_abc",
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(ProviderRejected);
    const unknown = setup(json(503, {}));
    await expect(
      unknown.provider.transfer({
        reference: "ajw_1234567890abcdef",
        amount: "1",
        recipientCode: "RCP_abc",
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(ProviderUnavailable);
  });

  it.each([
    ["success", "success"],
    ["failed", "failed"],
    ["reversed", "reversed"],
    ["pending", "pending"],
    ["otp", "pending"],
  ] as const)(
    "reads a verified transfer's %s as %s, and one Paystack never heard of as not found",
    async (theirs, ours) => {
      const { provider } = setup(json(200, { status: true, data: { status: theirs } }));
      expect(await provider.verifyTransfer("ajw_1234567890abcdef")).toBe(ours);
      const missing = setup(json(404, { status: false, message: "Transfer not found" }));
      expect(await missing.provider.verifyTransfer("ajw_1234567890abcdef")).toBe("not_found");
    },
  );
});
