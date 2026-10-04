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

/** Where Paystack's channel for each way of paying is named. */
const CHANNELS: Readonly<Record<string, string[]>> = {
  card: ["card"],
  transfer: ["bank_transfer"],
  ussd: ["ussd"],
};

const messageOf = (body: unknown) => text(record(body).message);

/**
 * Paystack, for Nigeria: card, bank transfer and USSD through its hosted checkout, direct debit
 * (NIBSS) mandates, account-name lookups and payouts. Written against Paystack's published API and
 * webhook documentation; it stays unproven against the live sandbox until a test key is connected.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = "paystack" as const;
  readonly country = "NG" as const;
  readonly currency = "NGN" as const;
  readonly supports = { fund: ["card", "transfer", "ussd"], mandate: true, payout: true } as const;

  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: HttpFetch;

  constructor(options: { secretKey: string; baseUrl: string; fetchFn: HttpFetch }) {
    this.secretKey = options.secretKey;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchFn = options.fetchFn;
  }

  private request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    acceptable?: readonly number[],
  ) {
    return call<T>(this.fetchFn, `${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, "Content-Type": "application/json" },
      body,
      acceptable,
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
    const { body } = await this.request("POST", "/transaction/initialize", {
      email: input.email,
      amount: input.amount,
      currency: this.currency,
      reference: input.reference,
      callback_url: input.returnUrl,
      channels: CHANNELS[input.method],
    });
    const data = record(record(body).data);
    const url = text(data.authorization_url);
    if (!url) throw new ProviderUnavailable("Paystack did not say where to pay.");
    return {
      providerId: text(data.access_code) ?? null,
      action: { type: "redirect", url } as Action,
    };
  }

  async verifyFunding(reference: string, _providerId?: string | null): Promise<VerifiedPayment> {
    const reply = await this.request(
      "GET",
      `/transaction/verify/${encodeURIComponent(reference)}`,
      undefined,
      [404],
    );
    // Paystack knows nothing of it until the person starts paying: not paid yet.
    if (reply.status === 404) return { status: "pending", amount: "0", currency: this.currency };
    const data = record(record(reply.body).data);
    const status =
      data.status === "success" ? "success" : data.status === "failed" ? "failed" : "pending";
    return {
      status,
      amount: minor(data.amount) ?? "0",
      currency: text(data.currency) ?? this.currency,
    };
  }

  // ---- what Paystack tells us --------------------------------------------------------------------

  parseWebhook(rawBody: Buffer, signature: string | undefined): ProviderEvent[] {
    const expected = Buffer.from(
      createHmac("sha512", this.secretKey).update(rawBody).digest("hex"),
    );
    const given = Buffer.from(signature ?? "");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new InvalidWebhookSignature();
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = record(JSON.parse(rawBody.toString("utf8")));
    } catch {
      throw new InvalidWebhookSignature();
    }
    return [this.normalise(text(parsed.event) ?? "unknown", record(parsed.data), rawBody)];
  }

  private normalise(event: string, data: Record<string, unknown>, raw: Buffer): ProviderEvent {
    const reference = text(data.reference);
    const common = {
      type: event,
      ...(reference ? { reference } : {}),
      amount: minor(data.amount),
      currency: text(data.currency),
    };
    const id = (...parts: unknown[]) =>
      `${event}:${parts.map((p) => text(p) ?? (typeof p === "number" ? String(p) : undefined)).find(Boolean)}`;

    switch (event) {
      case "charge.success":
        return { ...common, kind: "funding.succeeded", eventId: id(data.id, data.reference) };
      case "transfer.success":
        return {
          ...common,
          kind: "payout.succeeded",
          eventId: id(data.transfer_code, data.id, data.reference),
        };
      case "transfer.failed":
        return {
          ...common,
          kind: "payout.failed",
          eventId: id(data.transfer_code, data.id, data.reference),
        };
      case "transfer.reversed":
        return {
          ...common,
          kind: "payout.reversed",
          eventId: id(data.transfer_code, data.id, data.reference),
        };
      case "direct_debit.authorization.created":
      case "direct_debit.authorization.active": {
        const customer = record(data.customer);
        return {
          type: event,
          kind: event.endsWith("active") ? "mandate.active" : "mandate.created",
          eventId: id(data.authorization_code, data.signature),
          customerEmail: text(customer.email),
          authorizationCode: text(data.authorization_code),
        };
      }
      default:
        // Anything else is kept (so nothing is lost) under an id made from its own bytes.
        return {
          type: event,
          kind: "ignored",
          eventId: `${event}:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`,
        };
    }
  }

  // ---- auto-debit --------------------------------------------------------------------------------

  async createMandate(input: { reference: string; email: string; returnUrl: string }) {
    const { body } = await this.request("POST", "/customer/authorization/initialize", {
      email: input.email,
      channel: "direct_debit",
      callback_url: input.returnUrl,
    });
    const data = record(record(body).data);
    const url = text(data.redirect_url);
    if (!url) throw new ProviderUnavailable("Paystack did not say where to give consent.");
    return {
      providerId: text(data.reference) ?? null,
      action: { type: "redirect", url } as Action,
    };
  }

  async chargeMandate(input: {
    reference: string;
    amount: string;
    email: string;
    authorizationCode: string;
  }): Promise<{ providerId: string | null }> {
    const { body } = await this.request("POST", "/transaction/charge_authorization", {
      email: input.email,
      amount: input.amount,
      authorization_code: input.authorizationCode,
      reference: input.reference,
      currency: this.currency,
    });
    const data = record(record(body).data);
    if (text(data.status) === "failed") {
      throw new ProviderRejected(text(data.gateway_response) ?? "The bank refused the collection.");
    }
    return { providerId: text(data.reference) ?? null };
  }

  async cancelMandate(input: {
    providerId: string | null;
    providerMandateId: string | null;
    authorizationCode: string | null;
  }): Promise<void> {
    // Until the customer's bank has activated it there is no authorization to deactivate.
    if (!input.authorizationCode) return;
    await this.request("POST", "/customer/authorization/deactivate", {
      authorization_code: input.authorizationCode,
    });
  }

  // ---- paying out --------------------------------------------------------------------------------

  async resolveAccount(input: { bankCode: string; accountNumber: string }) {
    const query = `account_number=${encodeURIComponent(input.accountNumber)}&bank_code=${encodeURIComponent(input.bankCode)}`;
    const { body } = await this.request("GET", `/bank/resolve?${query}`);
    const name = text(record(record(body).data).account_name);
    if (!name) throw new ProviderUnavailable("Paystack did not say whose account it is.");
    return { accountName: name };
  }

  async createRecipient(input: { name: string; bankCode: string; accountNumber: string }) {
    const { body } = await this.request("POST", "/transferrecipient", {
      type: "nuban",
      name: input.name,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      currency: this.currency,
    });
    const code = text(record(record(body).data).recipient_code);
    if (!code) throw new ProviderUnavailable("Paystack did not give a recipient code.");
    return { recipientCode: code };
  }

  async transfer(input: {
    reference: string;
    amount: string;
    recipientCode: string;
    reason: string;
  }): Promise<TransferStart> {
    const { body } = await this.request("POST", "/transfer", {
      source: "balance",
      amount: input.amount,
      recipient: input.recipientCode,
      reference: input.reference,
      reason: input.reason,
    });
    const data = record(record(body).data);
    const theirs = text(data.status);
    const status =
      theirs === "success"
        ? "success"
        : theirs === "otp"
          ? "otp"
          : theirs === "failed"
            ? "failed"
            : "pending";
    return {
      status,
      ...(text(data.transfer_code) ? { providerId: text(data.transfer_code)! } : {}),
      ...(messageOf(body) ? { message: messageOf(body)! } : {}),
    };
  }

  async verifyTransfer(reference: string): Promise<TransferState> {
    const reply = await this.request(
      "GET",
      `/transfer/verify/${encodeURIComponent(reference)}`,
      undefined,
      [404],
    );
    if (reply.status === 404) return "not_found";
    const status = text(record(record(reply.body).data).status);
    return status === "success" || status === "failed" || status === "reversed"
      ? status
      : "pending";
  }
}
