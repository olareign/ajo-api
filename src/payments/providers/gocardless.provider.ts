import { createHmac, timingSafeEqual } from "node:crypto";
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

const VERSION = "2015-07-06";
const BASE = {
  sandbox: "https://api-sandbox.gocardless.com",
  live: "https://api.gocardless.com",
} as const;

const messageOf = (body: unknown) => text(record(record(body).error).message);

const NO_PAYOUTS = "GoCardless does not send money out.";

/**
 * GoCardless, for the UK: instant bank payments to add money, and Bacs direct debit mandates for
 * auto-debit. It does not send money out, so withdrawals in the UK need another partner. Written
 * against GoCardless's published API and webhook documentation; it stays unproven against the live
 * sandbox until a token is connected. Our own reference travels in `metadata.ajo_ref` so events about
 * a payment or mandate (which name only GoCardless's ids) can be matched back to ours.
 */
export class GoCardlessProvider implements PaymentProvider {
  readonly name = "gocardless" as const;
  readonly country = "GB" as const;
  readonly currency = "GBP" as const;
  readonly supports = { fund: ["transfer"], mandate: true, payout: false } as const;

  private readonly accessToken: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly fetchFn: HttpFetch;

  constructor(options: {
    accessToken: string;
    webhookSecret: string;
    environment: "sandbox" | "live";
    fetchFn: HttpFetch;
  }) {
    this.accessToken = options.accessToken;
    this.webhookSecret = options.webhookSecret;
    this.baseUrl = BASE[options.environment];
    this.fetchFn = options.fetchFn;
  }

  private request<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ) {
    return call<T>(this.fetchFn, `${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "GoCardless-Version": VERSION,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body,
      messageOf,
    });
  }

  /** The hosted page that takes the person through whatever the billing request needs. */
  private async hostedPage(
    billingRequest: string,
    email: string,
    returnUrl: string,
    key: string,
  ): Promise<Action> {
    const { body } = await this.request(
      "POST",
      "/billing_request_flows",
      {
        billing_request_flows: {
          redirect_uri: returnUrl,
          exit_uri: returnUrl,
          links: { billing_request: billingRequest },
          prefilled_customer: { email },
        },
      },
      `${key}:flow`,
    );
    const url = text(record(record(body).billing_request_flows).authorisation_url);
    if (!url) throw new ProviderUnavailable("GoCardless did not say where to continue.");
    return { type: "redirect", url };
  }

  // ---- adding money ------------------------------------------------------------------------------

  async initializeFunding(input: {
    reference: string;
    amount: string;
    email: string;
    method: FundingMethod;
    returnUrl: string;
  }) {
    if (input.method !== "transfer") {
      throw new ProviderRejected("That way of adding money is not available yet.");
    }
    const { body } = await this.request(
      "POST",
      "/billing_requests",
      {
        billing_requests: {
          payment_request: {
            description: "Add money to Àjọ",
            amount: Number(input.amount),
            currency: this.currency,
            scheme: "faster_payments",
            metadata: { ajo_ref: input.reference },
          },
        },
      },
      `${input.reference}:br`,
    );
    const id = text(record(record(body).billing_requests).id);
    if (!id) throw new ProviderUnavailable("GoCardless did not start the payment.");
    const action = await this.hostedPage(id, input.email, input.returnUrl, input.reference);
    return { providerId: id, action };
  }

  async verifyFunding(_reference: string, providerId: string | null): Promise<VerifiedPayment> {
    const pending = { status: "pending", amount: "0", currency: this.currency } as const;
    if (!providerId) return pending;
    const { body } = await this.request(
      "GET",
      `/billing_requests/${encodeURIComponent(providerId)}`,
    );
    const request = record(record(body).billing_requests);
    const paymentId =
      text(record(request.links).payment_request_payment) ??
      text(record(record(request.payment_request).links).payment);
    // No payment yet means the person has not finished paying.
    if (!paymentId) return pending;
    const payment = record(record(await this.payment(paymentId)).payments);
    const status = text(payment.status);
    return {
      status:
        status === "confirmed" || status === "paid_out"
          ? "success"
          : status === "failed" || status === "cancelled" || status === "customer_approval_denied"
            ? "failed"
            : "pending",
      amount: minor(payment.amount) ?? "0",
      currency: text(payment.currency) ?? this.currency,
    };
  }

  private async payment(id: string) {
    return (await this.request("GET", `/payments/${encodeURIComponent(id)}`)).body;
  }

  // ---- what GoCardless tells us ------------------------------------------------------------------

  parseWebhook(rawBody: Buffer, signature: string | undefined): ProviderEvent[] {
    const expected = Buffer.from(
      createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex"),
    );
    const given = Buffer.from(signature ?? "");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new InvalidWebhookSignature();
    }
    let events: unknown;
    try {
      events = record(JSON.parse(rawBody.toString("utf8"))).events;
    } catch {
      throw new InvalidWebhookSignature();
    }
    if (!Array.isArray(events)) throw new InvalidWebhookSignature();
    return events.map((event) => this.normalise(record(event)));
  }

  private normalise(event: Record<string, unknown>): ProviderEvent {
    const resource = text(event.resource_type) ?? "";
    const action = text(event.action) ?? "";
    const links = record(event.links);
    const type = `${resource}.${action}`;
    const eventId = text(event.id) ?? `${type}:${text(event.created_at) ?? "unknown"}`;

    if (resource === "payments") {
      const providerId = text(links.payment);
      if (action === "confirmed" || action === "paid_out") {
        return {
          eventId,
          type,
          kind: "funding.succeeded",
          stage: action,
          ...(providerId ? { providerId } : {}),
        };
      }
      if (action === "failed" || action === "cancelled" || action === "customer_approval_denied") {
        return { eventId, type, kind: "funding.failed", ...(providerId ? { providerId } : {}) };
      }
    }
    if (resource === "mandates") {
      const mandateId = text(links.mandate);
      const kind =
        action === "created" || action === "submitted"
          ? "mandate.created"
          : action === "active"
            ? "mandate.active"
            : action === "cancelled" || action === "expired"
              ? "mandate.cancelled"
              : action === "failed"
                ? "mandate.failed"
                : undefined;
      if (kind) return { eventId, type, kind, ...(mandateId ? { mandateId } : {}) };
    }
    if (
      resource === "billing_requests" &&
      action === "fulfilled" &&
      text(links.mandate_request_mandate)
    ) {
      return {
        eventId,
        type,
        kind: "mandate.created",
        billingRequestId: text(links.billing_request),
        mandateId: text(links.mandate_request_mandate),
      };
    }
    return { eventId, type, kind: "ignored" };
  }

  async lookupEvent(event: ProviderEvent) {
    if (event.kind.startsWith("funding.") && event.providerId) {
      const payment = record(record(await this.payment(event.providerId)).payments);
      const reference = text(record(payment.metadata).ajo_ref);
      return reference
        ? { reference, amount: minor(payment.amount), currency: text(payment.currency) }
        : null;
    }
    if (event.kind.startsWith("mandate.") && event.mandateId) {
      const { body } = await this.request(
        "GET",
        `/mandates/${encodeURIComponent(event.mandateId)}`,
      );
      const reference = text(record(record(record(body).mandates).metadata).ajo_ref);
      return reference ? { reference } : null;
    }
    return null;
  }

  // ---- auto-debit --------------------------------------------------------------------------------

  async createMandate(input: { reference: string; email: string; returnUrl: string }) {
    const { body } = await this.request(
      "POST",
      "/billing_requests",
      {
        billing_requests: {
          mandate_request: { scheme: "bacs", metadata: { ajo_ref: input.reference } },
        },
      },
      `${input.reference}:br`,
    );
    const id = text(record(record(body).billing_requests).id);
    if (!id) throw new ProviderUnavailable("GoCardless did not start the mandate.");
    const action = await this.hostedPage(id, input.email, input.returnUrl, input.reference);
    return { providerId: id, action };
  }

  async cancelMandate(input: {
    providerId: string | null;
    providerMandateId: string | null;
    authorizationCode: string | null;
  }): Promise<void> {
    if (input.providerMandateId) {
      await this.request(
        "POST",
        `/mandates/${encodeURIComponent(input.providerMandateId)}/actions/cancel`,
        {},
      );
    } else if (input.providerId) {
      // The person has not finished giving permission: withdraw the request itself.
      await this.request(
        "POST",
        `/billing_requests/${encodeURIComponent(input.providerId)}/actions/cancel`,
        {},
      );
    }
  }

  // ---- paying out: not something GoCardless does -------------------------------------------------

  async resolveAccount(_input?: unknown): Promise<{ accountName: string }> {
    throw new ProviderRejected(NO_PAYOUTS);
  }
  async createRecipient(_input?: unknown): Promise<{ recipientCode: string }> {
    throw new ProviderRejected(NO_PAYOUTS);
  }
  async transfer(_input?: unknown): Promise<TransferStart> {
    throw new ProviderRejected(NO_PAYOUTS);
  }
  async verifyTransfer(_reference?: string): Promise<TransferState> {
    throw new ProviderRejected(NO_PAYOUTS);
  }
}
