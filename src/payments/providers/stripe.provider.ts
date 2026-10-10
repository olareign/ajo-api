import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { call, minor, record, text, type HttpFetch } from "./http.js";
import {
  InvalidWebhookSignature,
  ProviderRejected,
  ProviderUnavailable,
  type Action,
  type FundingMethod,
  type PaymentProvider,
  type ProviderEvent,
  type TransferStart,
  type TransferState,
  type VerifiedPayment,
} from "./provider.port.js";

/** How old a signed webhook may be before it is refused as a possible replay (Stripe's own default). */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const messageOf = (body: unknown) => text(record(record(body).error).message);

/** Stripe takes form-encoded bodies, with nested keys written as a[b][c]. */
export function formEncode(value: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    else if (typeof v === "object")
      for (const [k, inner] of Object.entries(v as Record<string, unknown>))
        walk(`${prefix}[${k}]`, inner);
    else if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean" ||
      typeof v === "bigint"
    )
      out.append(prefix, String(v));
  };
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const [inner, x] of Object.entries(v as Record<string, unknown>))
        walk(`${k}[${inner}]`, x);
    } else walk(k, v);
  }
  return out.toString();
}

/** A saved Direct Debit is the customer and their payment method together; kept as "cus_…:pm_…". */
const SAVED = /^(cus_[A-Za-z0-9_]{1,100}):(pm_[A-Za-z0-9_]{1,100})$/;

/**
 * Stripe, for the UK (GBP): adding money by card through Stripe Checkout, and auto-debit through Bacs
 * Direct Debit (a Checkout session in setup mode saves the bank account and its mandate; collections
 * are then charged off-session). Paying out to a person's own bank is not offered: an ordinary Stripe
 * account pays out only to its owner's bank, so that needs Stripe Connect or another partner.
 *
 * Written against Stripe's published API and webhook documentation. It stays unproven against the
 * real test mode until a test key is connected.
 */
export class StripeProvider implements PaymentProvider {
  readonly name = "stripe" as const;
  readonly country = "GB" as const;
  readonly currency = "GBP" as const;
  readonly supports = { fund: ["card"], mandate: true, payout: false } as const;

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly fetchFn: HttpFetch;
  private readonly now: () => number;

  constructor(options: {
    secretKey: string;
    webhookSecret: string;
    fetchFn: HttpFetch;
    baseUrl?: string;
    now?: () => number;
  }) {
    this.secretKey = options.secretKey;
    this.webhookSecret = options.webhookSecret;
    this.baseUrl = (options.baseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
    this.fetchFn = options.fetchFn;
    this.now = options.now ?? Date.now;
  }

  /**
   * One call. Every POST carries an idempotency key, so a retry after a dropped connection is the same
   * request to Stripe and cannot charge or create twice.
   */
  private request<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    options: { idempotencyKey?: string; acceptable?: readonly number[] } = {},
  ) {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    }
    return call<T>(this.fetchFn, `${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? formEncode(body) : undefined,
      acceptable: options.acceptable,
      messageOf,
    });
  }

  // ---- adding money ------------------------------------------------------------------------------

  async initializeFunding(input: {
    reference: string;
    amount: string;
    email: string;
    method: FundingMethod;
    returnUrl: string;
  }) {
    if (input.method !== "card") throw new ProviderRejected("In the UK, money is added by card.");
    const { body } = await this.request(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: input.email,
        client_reference_id: input.reference,
        metadata: { reference: input.reference },
        payment_intent_data: { metadata: { reference: input.reference, source: "checkout" } },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "gbp",
              unit_amount: input.amount,
              product_data: { name: "Add money to your Àjọ wallet" },
            },
          },
        ],
        success_url: input.returnUrl,
        cancel_url: input.returnUrl,
      },
      { idempotencyKey: `fund:${input.reference}` },
    );
    const data = record(body);
    const url = text(data.url);
    if (!url) throw new ProviderUnavailable("Stripe did not say where to pay.");
    return { providerId: text(data.id) ?? null, action: { type: "redirect", url } as Action };
  }

  async verifyFunding(_reference: string, providerId: string | null): Promise<VerifiedPayment> {
    if (!providerId) return { status: "pending", amount: "0", currency: this.currency };
    const reply = await this.request(
      "GET",
      `/v1/checkout/sessions/${encodeURIComponent(providerId)}`,
      undefined,
      { acceptable: [404] },
    );
    if (reply.status === 404) return { status: "pending", amount: "0", currency: this.currency };
    const data = record(reply.body);
    const status =
      data.payment_status === "paid" ? "success" : data.status === "expired" ? "failed" : "pending";
    return {
      status,
      amount: minor(data.amount_total) ?? "0",
      currency: (text(data.currency) ?? "gbp").toUpperCase(),
    };
  }

  // ---- what Stripe tells us ----------------------------------------------------------------------

  /**
   * The Stripe-Signature header is "t=<seconds>,v1=<hmac>[,v1=…]": an HMAC-SHA256 of "<t>.<body>" with
   * the endpoint's signing secret. Refused unless one v1 matches and the time is recent.
   */
  parseWebhook(rawBody: Buffer, signature: string | undefined): ProviderEvent[] {
    const parts = (signature ?? "").split(",").map((p) => p.split("="));
    const timestamp = parts.find(([k]) => k === "t")?.[1];
    const given = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
    if (!timestamp || !/^\d{1,12}$/.test(timestamp) || given.length === 0) {
      throw new InvalidWebhookSignature();
    }
    if (Math.abs(this.now() / 1000 - Number(timestamp)) > WEBHOOK_TOLERANCE_SECONDS) {
      throw new InvalidWebhookSignature();
    }
    const expected = Buffer.from(
      createHmac("sha256", this.webhookSecret)
        .update(`${timestamp}.`)
        .update(rawBody)
        .digest("hex"),
    );
    const matches = given.some((g) => {
      const candidate = Buffer.from(g);
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
    if (!matches) throw new InvalidWebhookSignature();
    let parsed: Record<string, unknown>;
    try {
      parsed = record(JSON.parse(rawBody.toString("utf8")));
    } catch {
      throw new InvalidWebhookSignature();
    }
    const type = text(parsed.type) ?? "unknown";
    const eventId =
      text(parsed.id) ??
      `${type}:${createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`;
    return [this.normalise(type, eventId, record(record(parsed.data).object))];
  }

  private normalise(type: string, eventId: string, object: Record<string, unknown>): ProviderEvent {
    const metadata = record(object.metadata);
    const reference = text(metadata.reference) ?? text(object.client_reference_id);
    const ignored = { type, kind: "ignored" as const, eventId };
    const money = (amount: unknown) => ({
      amount: minor(amount),
      currency: text(object.currency)?.toUpperCase(),
    });

    switch (type) {
      // Card top-ups through Checkout.
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        if (object.mode !== "payment" || object.payment_status !== "paid") return ignored;
        return {
          type,
          eventId,
          kind: "funding.succeeded",
          ...(reference ? { reference } : {}),
          providerId: text(object.id),
          ...money(object.amount_total),
        };
      case "checkout.session.async_payment_failed":
      case "checkout.session.expired":
        if (object.mode !== "payment") return ignored;
        return { type, eventId, kind: "funding.failed", ...(reference ? { reference } : {}) };

      // Collections under a Direct Debit (card top-ups also make payment intents: those are counted
      // once, from their Checkout session, so only ours from a mandate count here).
      case "payment_intent.succeeded":
        if (metadata.source !== "mandate") return ignored;
        return {
          type,
          eventId,
          kind: "funding.succeeded",
          ...(reference ? { reference } : {}),
          providerId: text(object.id),
          stage: "paid_out",
          ...money(object.amount_received ?? object.amount),
        };
      case "payment_intent.payment_failed":
        if (metadata.source !== "mandate") return ignored;
        return { type, eventId, kind: "funding.failed", ...(reference ? { reference } : {}) };

      // Setting up a Direct Debit.
      case "setup_intent.succeeded": {
        const customer = text(object.customer);
        const method = text(object.payment_method);
        if (!reference || !customer || !method) return ignored;
        return {
          type,
          eventId,
          kind: "mandate.active",
          reference,
          authorizationCode: `${customer}:${method}`,
          ...(text(object.mandate) ? { mandateId: text(object.mandate)! } : {}),
        };
      }
      case "setup_intent.setup_failed":
        if (!reference) return ignored;
        return { type, eventId, kind: "mandate.failed", reference };
      case "mandate.updated": {
        const id = text(object.id);
        if (!id || object.status !== "inactive") return ignored;
        return { type, eventId, kind: "mandate.cancelled", mandateId: id };
      }
      default:
        return ignored;
    }
  }

  // ---- auto-debit (Bacs Direct Debit) ------------------------------------------------------------

  async createMandate(input: { reference: string; email: string; returnUrl: string }) {
    const customer = await this.request(
      "POST",
      "/v1/customers",
      { email: input.email, metadata: { reference: input.reference } },
      { idempotencyKey: `customer:${input.reference}` },
    );
    const customerId = text(record(customer.body).id);
    if (!customerId) throw new ProviderUnavailable("Stripe did not create a customer.");
    const { body } = await this.request(
      "POST",
      "/v1/checkout/sessions",
      {
        mode: "setup",
        currency: "gbp",
        customer: customerId,
        payment_method_types: ["bacs_debit"],
        client_reference_id: input.reference,
        metadata: { reference: input.reference },
        setup_intent_data: { metadata: { reference: input.reference } },
        success_url: input.returnUrl,
        cancel_url: input.returnUrl,
      },
      { idempotencyKey: `mandate:${input.reference}` },
    );
    const data = record(body);
    const url = text(data.url);
    if (!url) throw new ProviderUnavailable("Stripe did not say where to set up the Direct Debit.");
    return { providerId: text(data.id) ?? null, action: { type: "redirect", url } as Action };
  }

  async chargeMandate(input: {
    reference: string;
    amount: string;
    email: string;
    authorizationCode: string;
  }): Promise<{ providerId: string | null }> {
    const saved = SAVED.exec(input.authorizationCode);
    if (!saved) throw new ProviderRejected("This Direct Debit can't be used. Set it up again.");
    const { body } = await this.request(
      "POST",
      "/v1/payment_intents",
      {
        amount: input.amount,
        currency: "gbp",
        customer: saved[1],
        payment_method: saved[2],
        payment_method_types: ["bacs_debit"],
        confirm: true,
        off_session: true,
        metadata: { reference: input.reference, source: "mandate" },
      },
      { idempotencyKey: `charge:${input.reference}` },
    );
    const data = record(body);
    if (data.status === "requires_payment_method" || data.status === "canceled") {
      throw new ProviderRejected(
        messageOf({ error: data.last_payment_error }) ?? "The bank refused the collection.",
      );
    }
    return { providerId: text(data.id) ?? null };
  }

  async cancelMandate(input: {
    providerId: string | null;
    providerMandateId: string | null;
    authorizationCode: string | null;
  }): Promise<void> {
    // Until the bank account is saved there is nothing to cancel. Detaching the payment method ends
    // its Direct Debit mandate.
    const saved = input.authorizationCode ? SAVED.exec(input.authorizationCode) : null;
    if (!saved) return;
    await this.request(
      "POST",
      `/v1/payment_methods/${encodeURIComponent(saved[2]!)}/detach`,
      {},
      { idempotencyKey: `detach:${saved[2]}` },
    );
  }

  // ---- paying out: not offered (needs Stripe Connect, or another partner) -----------------------
  // The app never calls these while `supports.payout` is false; they refuse plainly if it ever does.

  resolveAccount(): Promise<{ accountName: string }> {
    return Promise.reject(noPayouts());
  }
  createRecipient(): Promise<{ recipientCode: string }> {
    return Promise.reject(noPayouts());
  }
  transfer(): Promise<TransferStart> {
    return Promise.reject(noPayouts());
  }
  verifyTransfer(): Promise<TransferState> {
    return Promise.resolve("not_found");
  }
}

const noPayouts = () => new ProviderRejected("Withdrawals to a UK bank aren't switched on yet.");
