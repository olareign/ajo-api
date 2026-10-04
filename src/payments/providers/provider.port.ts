export type Country = "NG" | "GB";
export type Currency = "NGN" | "GBP";
export type FundingMethod = "card" | "transfer" | "ussd" | "direct_debit";
export type ProviderName = "paystack" | "gocardless" | "fake";

/** The partner said no, clearly: nothing happened on their side, so it is safe to treat as failed. */
export class ProviderRejected extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ProviderRejected";
  }
}

/**
 * We could not tell what happened (a timeout, a dropped connection, a 5xx). The partner may or may
 * not have acted, so money is never released or returned on this alone: it stays pending until the
 * partner's own answer (a webhook, or a status check) settles it.
 */
export class ProviderUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailable";
  }
}

export class InvalidWebhookSignature extends Error {
  constructor() {
    super("Invalid webhook signature");
    this.name = "InvalidWebhookSignature";
  }
}

export type Action = Readonly<{ type: "redirect"; url: string }>;

/**
 * What a partner's event means to us, whichever partner sent it. `eventId` is unique per delivery
 * of the same fact, so the same event arriving twice is recognised and acted on once.
 */
export type ProviderEvent = Readonly<{
  eventId: string;
  /** The partner's own name for it, kept for logs. */
  type: string;
  kind:
    | "funding.succeeded"
    | "funding.failed"
    | "payout.succeeded"
    | "payout.failed"
    | "payout.reversed"
    | "mandate.created"
    | "mandate.active"
    | "mandate.cancelled"
    | "mandate.failed"
    | "ignored";
  /** Our reference, when the partner echoes it back. */
  reference?: string;
  /** The partner's id for the thing the event is about (payment, billing request, mandate). */
  providerId?: string;
  amount?: string;
  currency?: string;
  /** GoCardless: how far a payment has got. Bank-to-bank payments count at "confirmed"; direct debits only at "paid_out". */
  stage?: "confirmed" | "paid_out";
  customerEmail?: string;
  authorizationCode?: string;
  billingRequestId?: string;
  mandateId?: string;
}>;

export type FundingStart = Readonly<{ providerId: string | null; action: Action }>;
export type VerifiedPayment = Readonly<{
  status: "success" | "failed" | "pending";
  amount: string;
  currency: string;
}>;
export type TransferStart = Readonly<{
  status: "pending" | "success" | "failed" | "otp";
  providerId?: string;
  message?: string;
}>;
export type TransferState = "pending" | "success" | "failed" | "reversed" | "not_found";

export interface PaymentProvider {
  readonly name: ProviderName;
  readonly country: Country;
  readonly currency: Currency;
  readonly supports: Readonly<{
    fund: readonly FundingMethod[];
    mandate: boolean;
    payout: boolean;
  }>;

  initializeFunding(input: {
    reference: string;
    amount: string;
    email: string;
    method: FundingMethod;
    returnUrl: string;
  }): Promise<FundingStart>;
  verifyFunding(reference: string, providerId: string | null): Promise<VerifiedPayment>;

  /** Throws InvalidWebhookSignature unless the signature is right for exactly these bytes. */
  parseWebhook(rawBody: Buffer, signature: string | undefined): ProviderEvent[];
  /**
   * For partners whose events do not say which of our payments or mandates they are about, or how
   * much (GoCardless): ask the partner, and fill in what it says. Null when it cannot tell.
   */
  lookupEvent?(
    event: ProviderEvent,
  ): Promise<Partial<Pick<ProviderEvent, "reference" | "amount" | "currency">> | null>;

  createMandate(input: {
    reference: string;
    email: string;
    returnUrl: string;
  }): Promise<{ providerId: string | null; action: Action }>;
  cancelMandate(input: {
    providerId: string | null;
    providerMandateId: string | null;
    authorizationCode: string | null;
  }): Promise<void>;

  resolveAccount(input: {
    bankCode: string;
    accountNumber: string;
  }): Promise<{ accountName: string }>;
  createRecipient(input: {
    name: string;
    bankCode: string;
    accountNumber: string;
  }): Promise<{ recipientCode: string }>;
  transfer(input: {
    reference: string;
    amount: string;
    recipientCode: string;
    reason: string;
  }): Promise<TransferStart>;
  verifyTransfer(reference: string): Promise<TransferState>;
}
