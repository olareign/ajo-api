import { createHmac, timingSafeEqual } from "node:crypto";
import {
  InvalidWebhookSignature,
  ProviderRejected,
  ProviderUnavailable,
  type Country,
  type Currency,
  type FundingMethod,
  type PaymentProvider,
  type ProviderEvent,
  type TransferStart,
  type TransferState,
  type VerifiedPayment,
} from "./provider.port.js";

export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret-for-development-and-tests";

/** The signature the stand-in expects: HMAC-SHA256 of the exact body. Tests use it to play the partner. */
export const signFakeWebhook = (body: string | Buffer): string =>
  createHmac("sha256", FAKE_WEBHOOK_SECRET).update(body).digest("hex");

/**
 * A stand-in partner for development and tests. It pretends to take and send money, records every
 * call (so tests can prove a partner was asked once, not twice), and can be told how to behave. It is
 * refused in production by the environment schema.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = "fake" as const;
  readonly currency: Currency;
  readonly supports: PaymentProvider["supports"];

  /** Every call made, in order, as [method, argument]. */
  readonly calls: [string, unknown][] = [];
  /** How the next calls behave; tests change these. */
  behaviour: {
    initialize: "ok" | "reject" | "unavailable";
    transfer: TransferStart["status"] | "reject" | "unavailable";
    paid: Map<string, VerifiedPayment>;
    transfers: Map<string, TransferState>;
    accountNames: Map<string, string>;
    delayMs: number;
  } = {
    initialize: "ok",
    transfer: "pending",
    paid: new Map(),
    transfers: new Map(),
    accountNames: new Map(),
    delayMs: 0,
  };

  constructor(
    readonly country: Country,
    supports?: Partial<PaymentProvider["supports"]>,
  ) {
    this.currency = country === "NG" ? "NGN" : "GBP";
    this.supports = {
      fund: country === "NG" ? ["card", "transfer", "ussd"] : ["transfer", "direct_debit"],
      mandate: true,
      payout: country === "NG",
      ...supports,
    };
  }

  count(method: string): number {
    return this.calls.filter(([name]) => name === method).length;
  }

  private async record(method: string, input: unknown) {
    this.calls.push([method, input]);
    if (this.behaviour.delayMs > 0) await new Promise((r) => setTimeout(r, this.behaviour.delayMs));
  }

  async initializeFunding(input: {
    reference: string;
    amount: string;
    email: string;
    method: FundingMethod;
    returnUrl: string;
  }) {
    await this.record("initializeFunding", input);
    if (this.behaviour.initialize === "reject")
      throw new ProviderRejected("The partner refused it.");
    if (this.behaviour.initialize === "unavailable") throw new ProviderUnavailable("timeout");
    return {
      providerId: `fake_${input.reference}`,
      action: { type: "redirect" as const, url: `https://fake-pay.test/pay/${input.reference}` },
    };
  }

  async verifyFunding(reference: string): Promise<VerifiedPayment> {
    await this.record("verifyFunding", reference);
    return (
      this.behaviour.paid.get(reference) ?? {
        status: "pending",
        amount: "0",
        currency: this.currency,
      }
    );
  }

  parseWebhook(rawBody: Buffer, signature: string | undefined): ProviderEvent[] {
    const expected = Buffer.from(signFakeWebhook(rawBody));
    const given = Buffer.from(signature ?? "");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new InvalidWebhookSignature();
    }
    const body = JSON.parse(rawBody.toString("utf8")) as { events?: ProviderEvent[] };
    return body.events ?? [];
  }

  async createMandate(input: { reference: string; email: string; returnUrl: string }) {
    await this.record("createMandate", input);
    if (this.behaviour.initialize === "reject")
      throw new ProviderRejected("The partner refused it.");
    if (this.behaviour.initialize === "unavailable") throw new ProviderUnavailable("timeout");
    return {
      providerId: `fake_${input.reference}`,
      action: {
        type: "redirect" as const,
        url: `https://fake-pay.test/mandate/${input.reference}`,
      },
    };
  }

  async cancelMandate(input: unknown): Promise<void> {
    await this.record("cancelMandate", input);
  }

  async resolveAccount(input: { bankCode: string; accountNumber: string }) {
    await this.record("resolveAccount", input);
    const name = this.behaviour.accountNames.get(input.accountNumber);
    if (!name) throw new ProviderRejected("Could not resolve that account.");
    return { accountName: name };
  }

  async createRecipient(input: { name: string; bankCode: string; accountNumber: string }) {
    await this.record("createRecipient", input);
    return { recipientCode: `RCP_${input.accountNumber}` };
  }

  async transfer(input: {
    reference: string;
    amount: string;
    recipientCode: string;
    reason: string;
  }): Promise<TransferStart> {
    await this.record("transfer", input);
    if (this.behaviour.transfer === "reject") throw new ProviderRejected("The partner refused it.");
    if (this.behaviour.transfer === "unavailable") throw new ProviderUnavailable("timeout");
    return { status: this.behaviour.transfer, providerId: `TRF_${input.reference}` };
  }

  async verifyTransfer(reference: string): Promise<TransferState> {
    await this.record("verifyTransfer", reference);
    return this.behaviour.transfers.get(reference) ?? "pending";
  }
}
