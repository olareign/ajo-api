import { HttpStatus, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { PinService } from "../identity/pin.service.js";
import { PaymentEvents } from "./payment-events.service.js";
import { PayoutAccounts } from "./payout-accounts.service.js";
import { PaymentContext } from "./payment-context.js";
import {
  coded,
  COLUMNS,
  newReference,
  requestHash,
  view,
  type IntentRow,
} from "./payment-intents.js";
import { PaymentProviders } from "./providers/providers.service.js";
import type { PaymentResponse } from "./payments.dto.js";
import {
  ProviderRejected,
  ProviderUnavailable,
  type PaymentProvider,
} from "./providers/provider.port.js";

/** A pending withdrawal is only checked with the partner again after this long. */
export const WITHDRAWAL_RECONCILE_AFTER_SECONDS = 60;

/**
 * Taking money out. The money is held in the ledger first (so it can never be spent twice), then the
 * partner is asked to send it. If the partner says no, the hold is given back, once. If we cannot tell
 * what happened, the money stays held until the partner's own word (a webhook, or a status check)
 * settles it: it is never released or returned on a guess.
 */
@Injectable()
export class Withdrawals {
  constructor(
    private readonly db: DataSource,
    private readonly context: PaymentContext,
    private readonly providers: PaymentProviders,
    private readonly accounts: PayoutAccounts,
    private readonly ledger: LedgerService,
    private readonly pins: PinService,
    private readonly events: PaymentEvents,
  ) {}

  async start(
    userId: string,
    input: { amount: string; pin: string },
    idempotencyKey: string,
  ): Promise<PaymentResponse> {
    const person = await this.context.person(userId);
    const provider = this.context.providerFor(person.country);
    if (!provider.supports.payout) {
      throw coded(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Withdrawals aren't available in your country yet.",
        "payouts_not_available",
      );
    }
    const account = await this.accounts.row(userId);
    if (!account) {
      throw coded(
        HttpStatus.CONFLICT,
        "Add the bank account to send your money to first.",
        "payout_account_required",
      );
    }
    await this.pins.verify(userId, input.pin);

    const hash = requestHash("withdrawal", input.amount, provider.currency, account.recipient_code);
    const id = randomUUID();
    const reference = newReference("ajw");
    const wallet = await this.ledger.userAccount(userId, "available", provider.currency);
    const inTransit = await this.ledger.systemAccount("suspense", provider.currency, "payouts");

    const begun = await this.db
      .transaction(async (tx) => {
        const [created] = await sql<{ id: string }>(
          tx,
          `INSERT INTO payment_intents (id, user_id, kind, provider, method, currency, amount, status, reference, idempotency_key, request_hash, recipient_code)
           VALUES ($1, $2, 'withdrawal', $3, 'bank_account', $4, $5, 'created', $6, $7, $8, $9)
           ON CONFLICT (user_id, kind, idempotency_key) DO NOTHING RETURNING id`,
          [
            id,
            userId,
            provider.name,
            provider.currency,
            input.amount,
            reference,
            idempotencyKey,
            hash,
            account.recipient_code,
          ],
        );
        if (!created) {
          // The same attempt again (the insert waited for the first to finish): show it, do nothing more.
          const [existing] = await sql<IntentRow>(
            tx,
            `SELECT ${COLUMNS} FROM payment_intents WHERE user_id = $1 AND kind = 'withdrawal' AND idempotency_key = $2`,
            [userId, idempotencyKey],
          );
          if (existing!.request_hash !== hash) {
            throw coded(
              HttpStatus.CONFLICT,
              "That idempotency key was already used for a different request.",
              "idempotency_key_reused",
            );
          }
          return { row: existing!, ours: false };
        }
        // Hold the money. If it is not there, this fails and the whole attempt vanishes with it.
        const hold = await this.ledger.post(
          {
            type: "withdrawal",
            idempotencyKey: `withdrawal-hold:${id}`,
            reference,
            entries: [
              { accountId: wallet, direction: "debit", amount: input.amount },
              { accountId: inTransit, direction: "credit", amount: input.amount },
            ],
          },
          {},
          tx,
        );
        const [row] = await sql<IntentRow>(
          tx,
          `UPDATE payment_intents SET status = 'pending', ledger_transaction_id = $2, updated_at = now()
            WHERE id = $1 RETURNING ${COLUMNS}`,
          [id, hold.id],
        );
        return { row: row!, ours: true };
      })
      .catch((error: unknown) => {
        if (error instanceof UnprocessableEntityException) {
          throw coded(
            HttpStatus.UNPROCESSABLE_ENTITY,
            "You don't have enough money available for that.",
            "insufficient_funds",
          );
        }
        throw error;
      });
    if (!begun.ours) return view(begun.row);

    // Only the request that made the hold asks the partner, and only after the hold is committed.
    return view(await this.send(provider, begun.row, account.recipient_code));
  }

  /** Asks the partner to send it, and settles what it says. Safe to repeat: the reference is ours alone. */
  private async send(
    provider: PaymentProvider,
    row: IntentRow,
    recipientCode: string,
  ): Promise<IntentRow> {
    try {
      const sent = await provider.transfer({
        reference: row.reference,
        amount: row.amount,
        recipientCode,
        reason: "Àjọ withdrawal",
      });
      if (sent.providerId) await this.remember(row.id, sent.providerId);
      if (sent.status === "failed" || sent.status === "otp") {
        await this.apply(
          provider,
          row,
          "payout.failed",
          sent.message ?? "The bank did not accept the transfer.",
        );
      } else if (sent.status === "success") {
        await this.apply(provider, row, "payout.succeeded");
      }
    } catch (error) {
      if (error instanceof ProviderRejected) {
        await this.apply(provider, row, "payout.failed", error.message);
      } else if (!(error instanceof ProviderUnavailable)) {
        throw error;
      }
      // Unavailable: the money stays held, and the partner's answer will settle it.
    }
    return this.reload(row.id);
  }

  private async apply(
    provider: PaymentProvider,
    row: IntentRow,
    kind: "payout.succeeded" | "payout.failed",
    note?: string,
  ): Promise<void> {
    await this.db.transaction((tx) =>
      this.events.apply(tx, provider.name, {
        eventId: `local:${row.reference}:${kind}`,
        type: note ? `local: ${note}`.slice(0, 100) : "local",
        kind,
        reference: row.reference,
      }),
    );
  }

  private async remember(id: string, providerId: string): Promise<void> {
    await this.db.transaction((tx) =>
      sql(
        tx,
        `UPDATE payment_intents SET provider_id = $2, updated_at = now() WHERE id = $1 AND provider_id IS NULL`,
        [id, providerId],
      ),
    );
  }

  private async reload(id: string): Promise<IntentRow> {
    const [row] = await this.db.query<IntentRow[]>(
      `SELECT ${COLUMNS} FROM payment_intents WHERE id = $1`,
      [id],
    );
    return row!;
  }

  /**
   * For a withdrawal that has sat pending (a webhook that never came, or a crash between holding the
   * money and asking the partner): one caller at a time claims it, asks the partner what became of it,
   * and acts on the answer. If the partner has never heard of the reference, the request is sent
   * again, to the account it was originally made for. Returns whether this caller did the checking.
   */
  async reconcileIfDue(id: string): Promise<boolean> {
    const [claimed] = await this.db.transaction((tx) =>
      sql<{ recipient_code: string | null }>(
        tx,
        `UPDATE payment_intents SET updated_at = now()
          WHERE id = $1 AND kind = 'withdrawal' AND status = 'pending'
            AND updated_at < now() - make_interval(secs => $2)
          RETURNING recipient_code`,
        [id, WITHDRAWAL_RECONCILE_AFTER_SECONDS],
      ),
    );
    if (!claimed) return false;
    const row = await this.reload(id);
    const provider = this.providers.byName(row.provider);
    if (!provider) return true;
    try {
      const state = await provider.verifyTransfer(row.reference);
      if (state === "success") await this.apply(provider, row, "payout.succeeded");
      else if (state === "failed")
        await this.apply(provider, row, "payout.failed", "The bank did not accept the transfer.");
      else if (state === "reversed") await this.applyReversal(provider, row);
      else if (state === "not_found" && claimed.recipient_code) {
        await this.send(provider, row, claimed.recipient_code);
      }
    } catch (error) {
      // Not being able to ask is not an answer: leave it as it is, and ask again later.
      if (!(error instanceof ProviderUnavailable || error instanceof ProviderRejected)) throw error;
    }
    return true;
  }

  private async applyReversal(provider: PaymentProvider, row: IntentRow): Promise<void> {
    await this.db.transaction((tx) =>
      this.events.apply(tx, provider.name, {
        eventId: `local:${row.reference}:payout.reversed`,
        type: "local",
        kind: "payout.reversed",
        reference: row.reference,
      }),
    );
  }
}
