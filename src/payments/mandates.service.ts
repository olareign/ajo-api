import { HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { ActiveCommitments } from "./commitments.js";
import { PaymentContext } from "./payment-context.js";
import { coded, newReference } from "./payment-intents.js";
import type { MandateResponse } from "./payments.dto.js";
import { ProviderRejected, ProviderUnavailable } from "./providers/provider.port.js";
import { PaymentProviders } from "./providers/providers.service.js";

type Row = {
  id: string;
  user_id: string;
  provider: "paystack" | "gocardless" | "fake";
  status: "pending" | "active" | "cancelled" | "failed";
  reference: string;
  provider_id: string | null;
  provider_mandate_id: string | null;
  authorization_code: string | null;
  action: MandateResponse["action"];
  created_at: Date;
};

const COLUMNS = `id, user_id, provider, status, reference, provider_id, provider_mandate_id,
  authorization_code, action, created_at`;

const view = (row: Row): MandateResponse => ({
  id: row.id,
  status: row.status,
  action: row.action,
  createdAt: row.created_at.toISOString(),
});

/**
 * Auto-debit: a person's standing permission for money to be collected on its date. A person has at
 * most one that is not finished (the database refuses a second), and a cancelled one is never brought
 * back by a late message from the partner.
 */
@Injectable()
export class Mandates {
  constructor(
    private readonly db: DataSource,
    private readonly context: PaymentContext,
    private readonly providers: PaymentProviders,
    private readonly commitments: ActiveCommitments,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The one that is open, or else the latest that ended, so the screen can say what became of it. */
  async current(userId: string): Promise<MandateResponse | null> {
    const [row] = await this.db.query<Row[]>(
      `SELECT ${COLUMNS} FROM mandates WHERE user_id = $1
        ORDER BY (status IN ('pending', 'active')) DESC, created_at DESC LIMIT 1`,
      [userId],
    );
    return row ? view(row) : null;
  }

  /**
   * Starts a mandate, or returns the one already open: asking twice, or twice at once, still ends with
   * one. Concurrent requests queue on the database's own unique index, so the partner hears of it once.
   */
  async create(userId: string): Promise<MandateResponse> {
    const person = await this.context.person(userId);
    const provider = this.context.providerFor(person.country);
    if (!provider.supports.mandate) {
      throw coded(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Auto-debit isn't available in your country yet.",
        "mandate_not_available",
      );
    }
    const reference = newReference("ajm");

    const row = await this.db.transaction(async (tx) => {
      const [created] = await sql<{ id: string }>(
        tx,
        `INSERT INTO mandates (user_id, provider, status, reference) VALUES ($1, $2, 'pending', $3)
         ON CONFLICT (user_id) WHERE status IN ('pending', 'active') DO NOTHING RETURNING id`,
        [userId, provider.name, reference],
      );
      if (!created) {
        // Already open (the insert waited for any concurrent one to finish): that is the answer.
        const [open] = await sql<Row>(
          tx,
          `SELECT ${COLUMNS} FROM mandates WHERE user_id = $1 AND status IN ('pending', 'active')`,
          [userId],
        );
        return open!;
      }
      try {
        const start = await provider.createMandate({
          reference,
          email: person.email,
          returnUrl: `${this.env.WEB_APP_URL}/wallet/mandate/return`,
        });
        const [updated] = await sql<Row>(
          tx,
          `UPDATE mandates SET provider_id = $2, action = $3, updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
          [created.id, start.providerId, JSON.stringify(start.action)],
        );
        return updated!;
      } catch (error) {
        if (!(error instanceof ProviderRejected || error instanceof ProviderUnavailable))
          throw error;
        const [failed] = await sql<Row>(
          tx,
          `UPDATE mandates SET status = 'failed', updated_at = now() WHERE id = $1 RETURNING ${COLUMNS}`,
          [created.id],
        );
        return Object.assign(failed!, {
          refusal: error instanceof ProviderRejected ? "refused" : "unavailable",
        });
      }
    });
    const refusal = (row as Row & { refusal?: string }).refusal;
    if (refusal === "refused") {
      throw coded(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "The payment partner refused to set this up.",
        "mandate_refused",
      );
    }
    if (refusal === "unavailable") {
      throw coded(
        HttpStatus.SERVICE_UNAVAILABLE,
        "The payment partner could not be reached.",
        "payments_unavailable",
      );
    }
    return view(row);
  }

  /**
   * Cancels the person's open mandate, unless something still depends on it. The partner is told
   * first: if it cannot be reached the mandate stays as it was, rather than looking cancelled here
   * while the partner can still collect.
   */
  async cancel(userId: string): Promise<MandateResponse> {
    return this.db.transaction(async (tx) => {
      const [open] = await sql<Row>(
        tx,
        `SELECT ${COLUMNS} FROM mandates WHERE user_id = $1 AND status IN ('pending', 'active') FOR UPDATE`,
        [userId],
      );
      if (!open)
        throw new NotFoundException({
          message: "You have no auto-debit to cancel.",
          code: "no_mandate",
        });
      if ((await this.commitments.count(userId)) > 0) {
        throw coded(
          HttpStatus.CONFLICT,
          "You're in a saving plan or circle that depends on auto-debit. Finish or leave it first.",
          "active_commitments",
        );
      }
      const provider = this.providers.byName(open.provider);
      if (provider) {
        try {
          await provider.cancelMandate({
            providerId: open.provider_id,
            providerMandateId: open.provider_mandate_id,
            authorizationCode: open.authorization_code,
          });
        } catch (error) {
          if (error instanceof ProviderUnavailable) {
            throw coded(
              HttpStatus.SERVICE_UNAVAILABLE,
              "The payment partner could not be reached. Nothing was cancelled.",
              "payments_unavailable",
            );
          }
          if (error instanceof ProviderRejected) {
            throw coded(
              HttpStatus.UNPROCESSABLE_ENTITY,
              "The payment partner refused to cancel it.",
              "mandate_cancel_refused",
            );
          }
          throw error;
        }
      }
      const [done] = await sql<Row>(
        tx,
        `UPDATE mandates SET status = 'cancelled', cancelled_at = now(), updated_at = now()
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [open.id],
      );
      return view(done!);
    });
  }
}
