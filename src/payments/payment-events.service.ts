import { Injectable } from "@nestjs/common";
import { sql } from "../database/sql.js";
import { LedgerService } from "../ledger/ledger.service.js";
import type { ProviderEvent, ProviderName } from "./providers/provider.port.js";

type Tx = Parameters<typeof sql>[0];

/**
 * What happened when an event was applied. "attention" is for a fact that contradicts what we hold
 * and that no code should settle on its own (money the partner says it moved after we returned it,
 * an amount that is not what was asked): it is kept, flagged and not retried, for a person to look at.
 */
export type Applied =
  | Readonly<{ result: "applied" }>
  | Readonly<{ result: "ignored"; note: string }>
  | Readonly<{ result: "attention"; note: string }>
  /** Not matched to anything yet (its other half may still be on the way): try again later. */
  | Readonly<{ result: "retry"; note: string }>;

type Intent = {
  id: string;
  user_id: string;
  kind: "funding" | "withdrawal";
  provider: ProviderName;
  method: string;
  currency: string;
  amount: string;
  status: "created" | "pending" | "succeeded" | "failed" | "reversed";
  reference: string;
  ledger_transaction_id: string | null;
};

type MandateRow = {
  id: string;
  user_id: string;
  status: "pending" | "active" | "cancelled" | "failed";
};

const applied: Applied = { result: "applied" };
const ignored = (note: string): Applied => ({ result: "ignored", note });
const attention = (note: string): Applied => ({ result: "attention", note });

/**
 * Turns a partner's event into changes to payments and the ledger. Every handler runs inside the
 * caller's database transaction and locks the payment's row first, then looks at its status: so the
 * same event twice, two events about one payment, and events in the wrong order each end the same
 * way, with the money counted once.
 */
@Injectable()
export class PaymentEvents {
  constructor(private readonly ledger: LedgerService) {}

  async apply(tx: Tx, provider: ProviderName, event: ProviderEvent): Promise<Applied> {
    switch (event.kind) {
      case "funding.succeeded":
        return this.fundingSucceeded(tx, provider, event);
      case "funding.failed":
        return this.fundingFailed(tx, event);
      case "payout.succeeded":
        return this.payoutSucceeded(tx, provider, event);
      case "payout.failed":
        return this.payoutFailed(tx, event, "The bank did not accept the transfer.");
      case "payout.reversed":
        return this.payoutReversed(tx, provider, event);
      case "mandate.created":
      case "mandate.active":
      case "mandate.cancelled":
      case "mandate.failed":
        return this.mandateChanged(tx, provider, event);
      default:
        return ignored("An event we have no use for.");
    }
  }

  private async lockIntent(
    tx: Tx,
    kind: Intent["kind"],
    event: ProviderEvent,
  ): Promise<Intent | undefined> {
    if (!event.reference) return undefined;
    const [row] = await sql<Intent>(
      tx,
      `SELECT id, user_id, kind, provider, method, currency, amount::text, status, reference, ledger_transaction_id
         FROM payment_intents WHERE reference = $1 AND kind = $2 FOR UPDATE`,
      [event.reference, kind],
    );
    return row;
  }

  // ---- adding money ------------------------------------------------------------------------------

  private async fundingSucceeded(
    tx: Tx,
    provider: ProviderName,
    event: ProviderEvent,
  ): Promise<Applied> {
    const intent = await this.lockIntent(tx, "funding", event);
    if (!intent) return ignored("No payment of ours has that reference.");
    if (intent.status === "succeeded") return ignored("Already credited.");
    if (event.amount !== intent.amount || event.currency !== intent.currency) {
      return attention(
        `Paid ${event.amount} ${event.currency}, but ${intent.amount} ${intent.currency} was asked for. Nothing was credited.`,
      );
    }
    // A bank-to-bank payment counts when it is confirmed. A direct debit can still be recalled after
    // that, so it only counts once the partner has paid it out to us.
    if (intent.method === "direct_debit" && event.stage === "confirmed") {
      return ignored("A direct debit counts once it is paid out.");
    }
    // It counts whether we had marked it failed, pending or not yet started: if the money arrived,
    // the person is owed it.
    const wallet = await this.ledger.userAccount(
      intent.user_id,
      "available",
      intent.currency,
      undefined,
      tx,
    );
    const settlement = await this.ledger.systemAccount("settlement", intent.currency, provider, tx);
    const posted = await this.ledger.post(
      {
        type: "funding",
        idempotencyKey: `funding:${intent.id}`,
        reference: intent.reference,
        entries: [
          { accountId: settlement, direction: "debit", amount: intent.amount },
          { accountId: wallet, direction: "credit", amount: intent.amount },
        ],
      },
      {},
      tx,
    );
    await sql(
      tx,
      `UPDATE payment_intents SET status = 'succeeded', failure_reason = NULL,
              ledger_transaction_id = $2, updated_at = now() WHERE id = $1`,
      [intent.id, posted.id],
    );
    return applied;
  }

  private async fundingFailed(tx: Tx, event: ProviderEvent): Promise<Applied> {
    const intent = await this.lockIntent(tx, "funding", event);
    if (!intent) return ignored("No payment of ours has that reference.");
    if (intent.status !== "created" && intent.status !== "pending") {
      return ignored(`Already ${intent.status}.`);
    }
    await sql(
      tx,
      `UPDATE payment_intents SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
      [intent.id, "The payment did not go through."],
    );
    return applied;
  }

  // ---- taking money out --------------------------------------------------------------------------

  private async payoutSucceeded(
    tx: Tx,
    provider: ProviderName,
    event: ProviderEvent,
  ): Promise<Applied> {
    const intent = await this.lockIntent(tx, "withdrawal", event);
    if (!intent) return ignored("No withdrawal of ours has that reference.");
    if (intent.status === "succeeded") return ignored("Already settled.");
    if (intent.status !== "pending") {
      return attention(
        "The partner says this withdrawal was paid, but the money was already returned to the wallet. Someone must look at it.",
      );
    }
    const inTransit = await this.ledger.systemAccount("suspense", intent.currency, "payouts", tx);
    const settlement = await this.ledger.systemAccount("settlement", intent.currency, provider, tx);
    await this.ledger.post(
      {
        type: "withdrawal_settled",
        idempotencyKey: `withdrawal-settled:${intent.id}`,
        reference: intent.reference,
        entries: [
          { accountId: inTransit, direction: "debit", amount: intent.amount },
          { accountId: settlement, direction: "credit", amount: intent.amount },
        ],
      },
      {},
      tx,
    );
    await sql(
      tx,
      `UPDATE payment_intents SET status = 'succeeded', updated_at = now() WHERE id = $1`,
      [intent.id],
    );
    return applied;
  }

  /** The transfer did not happen: give the held money back, once. */
  private async payoutFailed(tx: Tx, event: ProviderEvent, reason: string): Promise<Applied> {
    const intent = await this.lockIntent(tx, "withdrawal", event);
    if (!intent) return ignored("No withdrawal of ours has that reference.");
    if (intent.status === "succeeded") {
      return attention(
        "The partner says this withdrawal failed, but it was already settled as paid. Someone must look at it.",
      );
    }
    if (intent.status !== "pending") return ignored(`Already ${intent.status}.`);
    await this.returnHold(tx, intent, reason);
    return applied;
  }

  private async payoutReversed(
    tx: Tx,
    provider: ProviderName,
    event: ProviderEvent,
  ): Promise<Applied> {
    const intent = await this.lockIntent(tx, "withdrawal", event);
    if (!intent) return ignored("No withdrawal of ours has that reference.");
    if (intent.status === "failed" || intent.status === "reversed") {
      return ignored(`Already ${intent.status}.`);
    }
    if (intent.status === "pending") {
      await this.returnHold(tx, intent, "The transfer was reversed by the bank.");
      return applied;
    }
    // It was paid and the bank has since sent it back: the money is ours again, so it is the person's.
    const wallet = await this.ledger.userAccount(
      intent.user_id,
      "available",
      intent.currency,
      undefined,
      tx,
    );
    const settlement = await this.ledger.systemAccount("settlement", intent.currency, provider, tx);
    await this.ledger.post(
      {
        type: "payout_returned",
        idempotencyKey: `withdrawal-returned:${intent.id}`,
        reference: intent.reference,
        entries: [
          { accountId: settlement, direction: "debit", amount: intent.amount },
          { accountId: wallet, direction: "credit", amount: intent.amount },
        ],
      },
      {},
      tx,
    );
    await sql(
      tx,
      `UPDATE payment_intents SET status = 'reversed', failure_reason = $2, updated_at = now() WHERE id = $1`,
      [intent.id, "The bank sent the money back."],
    );
    return applied;
  }

  private async returnHold(tx: Tx, intent: Intent, reason: string): Promise<void> {
    if (!intent.ledger_transaction_id) {
      throw new Error(`Withdrawal ${intent.id} has no hold to return`);
    }
    await this.ledger.reverse(
      intent.ledger_transaction_id,
      { idempotencyKey: `withdrawal-reversal:${intent.id}`, reason },
      tx,
    );
    await sql(
      tx,
      `UPDATE payment_intents SET status = 'failed', failure_reason = $2, updated_at = now() WHERE id = $1`,
      [intent.id, reason.slice(0, 300)],
    );
  }

  // ---- standing permission to collect ------------------------------------------------------------

  private async findMandate(
    tx: Tx,
    provider: ProviderName,
    event: ProviderEvent,
  ): Promise<MandateRow | undefined> {
    const lock = `FOR UPDATE`;
    if (event.reference) {
      const [row] = await sql<MandateRow>(
        tx,
        `SELECT id, user_id, status FROM mandates WHERE reference = $1 ${lock}`,
        [event.reference],
      );
      if (row) return row;
    }
    for (const id of [event.billingRequestId, event.providerId].filter(Boolean)) {
      const [row] = await sql<MandateRow>(
        tx,
        `SELECT id, user_id, status FROM mandates WHERE provider_id = $1 ${lock}`,
        [id],
      );
      if (row) return row;
    }
    if (event.mandateId) {
      const [row] = await sql<MandateRow>(
        tx,
        `SELECT id, user_id, status FROM mandates WHERE provider_mandate_id = $1 ${lock}`,
        [event.mandateId],
      );
      if (row) return row;
    }
    if (event.customerEmail) {
      // Some partners (Paystack) name the customer, not our reference: the person's one open mandate
      // with that partner is the one.
      const [row] = await sql<MandateRow>(
        tx,
        `SELECT m.id, m.user_id, m.status FROM mandates m JOIN users u ON u.id = m.user_id
          WHERE u.email = $1 AND m.provider = $2 AND m.status IN ('pending', 'active')
          ORDER BY m.created_at DESC LIMIT 1 FOR UPDATE OF m`,
        [event.customerEmail, provider],
      );
      return row;
    }
    return undefined;
  }

  private async mandateChanged(
    tx: Tx,
    provider: ProviderName,
    event: ProviderEvent,
  ): Promise<Applied> {
    const mandate = await this.findMandate(tx, provider, event);
    if (!mandate) {
      // Naming the customer, or one of our own references, is enough to know it is not ours. A partner's own id for a mandate we have
      // not been told about yet may simply have arrived ahead of the message that introduces it.
      return event.customerEmail || event.reference
        ? ignored("No mandate of ours matches.")
        : { result: "retry", note: "No mandate of ours matches yet." };
    }
    const ids = [event.mandateId ?? null, event.authorizationCode ?? null];
    const remember = async () =>
      sql(
        tx,
        `UPDATE mandates SET provider_mandate_id = coalesce($2, provider_mandate_id),
                authorization_code = coalesce($3, authorization_code), updated_at = now() WHERE id = $1`,
        [mandate.id, ...ids],
      );

    if (event.kind === "mandate.created") {
      await remember();
      return applied;
    }
    if (event.kind === "mandate.active") {
      // A mandate that was cancelled (or never started) is not brought back by a late event.
      if (mandate.status !== "pending") return ignored(`Already ${mandate.status}.`);
      await remember();
      await sql(tx, `UPDATE mandates SET status = 'active', updated_at = now() WHERE id = $1`, [
        mandate.id,
      ]);
      return applied;
    }
    const next = event.kind === "mandate.cancelled" ? "cancelled" : "failed";
    if (mandate.status === "cancelled" || mandate.status === "failed") {
      return ignored(`Already ${mandate.status}.`);
    }
    await sql(
      tx,
      `UPDATE mandates SET status = $2, updated_at = now(),
              cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() ELSE cancelled_at END
        WHERE id = $1`,
      [mandate.id, next],
    );
    return applied;
  }
}
