import { HttpStatus, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { PaymentContext } from "./payment-context.js";
import { coded, newReference, requestHash } from "./payment-intents.js";
import { ProviderRejected, ProviderUnavailable } from "./providers/provider.port.js";

export type Pull = Readonly<{ id: string; status: string }>;

/**
 * Collecting money from a person's bank under the auto-debit they gave, to land in their wallet
 * (a saving plan's debit, a circle's round). It is an ordinary funding payment, so the partner's
 * message credits the wallet once, the same way as adding money by hand. The payment is saved before
 * the partner is asked, and asking twice with the same key never collects twice.
 */
@Injectable()
export class BankPulls {
  constructor(
    private readonly db: DataSource,
    private readonly context: PaymentContext,
  ) {}

  /** Whether this person has an auto-debit that can be collected under. */
  async available(userId: string): Promise<boolean> {
    const [row] = await this.db.query<{ ok: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM mandates WHERE user_id = $1 AND status = 'active'
                       AND authorization_code IS NOT NULL) AS ok`,
      [userId],
    );
    return row?.ok === true;
  }

  async start(userId: string, amount: string, idempotencyKey: string): Promise<Pull> {
    const person = await this.context.person(userId);
    const provider = this.context.providerFor(person.country);
    const [mandate] = await this.db.query<{ id: string; authorization_code: string }[]>(
      `SELECT id, authorization_code FROM mandates
        WHERE user_id = $1 AND status = 'active' AND authorization_code IS NOT NULL AND provider = $2`,
      [userId, provider.name],
    );
    if (!mandate) {
      throw coded(
        HttpStatus.CONFLICT,
        "There is no active auto-debit to collect under.",
        "no_mandate",
      );
    }
    const hash = requestHash("pull", amount, provider.currency, mandate.id);
    const id = randomUUID();
    const reference = newReference("ajf");

    // Saved first, in its own transaction: if we crash after asking the partner, the payment is there
    // for the partner's message (or the status check) to settle.
    const saved = await this.db.transaction(async (tx) => {
      const [created] = await sql<{ id: string }>(
        tx,
        `INSERT INTO payment_intents (id, user_id, kind, provider, method, currency, amount, status, reference, idempotency_key, request_hash)
         VALUES ($1, $2, 'funding', $3, 'direct_debit', $4, $5, 'created', $6, $7, $8)
         ON CONFLICT (user_id, kind, idempotency_key) DO NOTHING RETURNING id`,
        [id, userId, provider.name, provider.currency, amount, reference, idempotencyKey, hash],
      );
      if (created) return { id, reference, fresh: true };
      const [existing] = await sql<{
        id: string;
        reference: string;
        status: string;
        request_hash: string;
      }>(
        tx,
        `SELECT id, reference, status, request_hash FROM payment_intents
          WHERE user_id = $1 AND kind = 'funding' AND idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (existing!.request_hash !== hash) {
        throw coded(
          HttpStatus.CONFLICT,
          "That idempotency key was already used for a different request.",
          "idempotency_key_reused",
        );
      }
      return {
        id: existing!.id,
        reference: existing!.reference,
        fresh: false,
        status: existing!.status,
      };
    });

    if (!saved.fresh) {
      // Already started. If we crashed before hearing the partner's answer, call it pending: the
      // partner's message or the scheduled status check settles it, and failing that, marks it failed.
      if (saved.status === "created") await this.settle(saved.id, "pending");
      return { id: saved.id, status: saved.status === "created" ? "pending" : saved.status! };
    }

    try {
      await provider.chargeMandate({
        reference: saved.reference,
        amount,
        email: person.email,
        authorizationCode: mandate.authorization_code,
      });
    } catch (error) {
      if (error instanceof ProviderRejected) {
        await this.settle(saved.id, "failed", error.message.slice(0, 300));
        return { id: saved.id, status: "failed" };
      }
      // Could not reach the partner: it may or may not have been asked. Leave it pending so the
      // status check decides, rather than risk collecting again.
      if (!(error instanceof ProviderUnavailable)) throw error;
    }
    await this.settle(saved.id, "pending");
    return { id: saved.id, status: "pending" };
  }

  private async settle(id: string, status: "pending" | "failed", reason?: string): Promise<void> {
    await this.db.query(
      `UPDATE payment_intents SET status = $2, failure_reason = $3, updated_at = now()
        WHERE id = $1 AND status IN ('created', 'pending')`,
      [id, status, reason ?? null],
    );
  }
}
