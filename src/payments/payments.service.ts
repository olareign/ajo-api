import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import type { PaymentResponse } from "./payments.dto.js";
import { PaymentEvents } from "./payment-events.service.js";
import {
  ProviderRejected,
  ProviderUnavailable,
  type FundingMethod,
  type PaymentProvider,
} from "./providers/provider.port.js";
import { PaymentProviders } from "./providers/providers.service.js";

/** A pending payment is only checked with the partner again after this long, so looking is cheap. */
const RECONCILE_AFTER_SECONDS = 30;
const UNAVAILABLE = "The payment partner could not be reached.";

type Tx = Parameters<typeof sql>[0];

export type IntentRow = {
  id: string;
  user_id: string;
  kind: "funding" | "withdrawal";
  provider: PaymentProvider["name"];
  method: PaymentResponse["method"];
  currency: string;
  amount: string;
  status: PaymentResponse["status"];
  reference: string;
  provider_id: string | null;
  request_hash: string;
  action: PaymentResponse["action"];
  failure_reason: string | null;
  created_at: Date;
};

const COLUMNS = `id, user_id, kind, provider, method, currency, amount::text, status, reference,
  provider_id, request_hash, action, failure_reason, created_at`;

export const requestHash = (...parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const newReference = (prefix: "ajf" | "ajw" | "ajm"): string =>
  `${prefix}_${randomBytes(12).toString("hex")}`;

export const coded = (status: HttpStatus, message: string, code: string) =>
  new HttpException({ message, code }, status);

export function view(row: IntentRow): PaymentResponse {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    method: row.method,
    amount: { amount: row.amount, currency: row.currency },
    action: row.action,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
  };
}

/** Why an attempt that did not start is answered as it is, for the first request and for every replay. */
function failure(row: IntentRow): HttpException {
  return row.failure_reason === UNAVAILABLE
    ? new ServiceUnavailableException({ message: UNAVAILABLE, code: "payments_unavailable" })
    : new UnprocessableEntityException({
        message: row.failure_reason ?? "The payment partner refused this payment.",
        code: "payment_refused",
      });
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: DataSource,
    private readonly providers: PaymentProviders,
    private readonly events: PaymentEvents,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async person(userId: string): Promise<{ email: string; country: string | null; name: string }> {
    const [user] = await this.db.query<{ email: string; country: string | null; name: string }[]>(
      `SELECT email, country, display_name AS name FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw new NotFoundException();
    return user;
  }

  /** The partner that serves this country, or a clear 503: nothing is started without one. */
  providerFor(country: string | null): PaymentProvider {
    const provider = this.providers.forCountry(country);
    if (!provider) {
      throw new ServiceUnavailableException({
        message: "Payments aren't switched on yet.",
        code: "payments_not_connected",
      });
    }
    return provider;
  }

  // ---- adding money ------------------------------------------------------------------------------

  /**
   * Starts adding money. The idempotency key makes this safe to repeat: the same key with the same
   * request returns the same payment (and never asks the partner twice), and the same key with a
   * different request is refused. Two requests arriving together queue on the database's own unique
   * key, so exactly one of them reaches the partner.
   */
  async fund(
    userId: string,
    input: { amount: string; method: FundingMethod },
    idempotencyKey: string,
  ): Promise<PaymentResponse> {
    const person = await this.person(userId);
    const provider = this.providerFor(person.country);
    if (!provider.supports.fund.includes(input.method)) {
      throw coded(
        HttpStatus.BAD_REQUEST,
        "That way of adding money isn't available in your country.",
        "method_not_available",
      );
    }
    const hash = requestHash("funding", input.method, input.amount, provider.currency);
    const id = randomUUID();
    const reference = newReference("ajf");

    const outcome = await this.db.transaction(async (tx) => {
      const [created] = await sql<{ id: string }>(
        tx,
        `INSERT INTO payment_intents (id, user_id, kind, provider, method, currency, amount, status, reference, idempotency_key, request_hash)
         VALUES ($1, $2, 'funding', $3, $4, $5, $6, 'created', $7, $8, $9)
         ON CONFLICT (user_id, kind, idempotency_key) DO NOTHING RETURNING id`,
        [
          id,
          userId,
          provider.name,
          input.method,
          provider.currency,
          input.amount,
          reference,
          idempotencyKey,
          hash,
        ],
      );
      if (!created) {
        // Someone else (or an earlier call) already made it. The insert waited for them to finish.
        const [existing] = await sql<IntentRow>(
          tx,
          `SELECT ${COLUMNS} FROM payment_intents WHERE user_id = $1 AND kind = 'funding' AND idempotency_key = $2`,
          [userId, idempotencyKey],
        );
        if (existing!.request_hash !== hash) {
          throw coded(
            HttpStatus.CONFLICT,
            "That idempotency key was already used for a different request.",
            "idempotency_key_reused",
          );
        }
        return existing!;
      }
      try {
        const start = await provider.initializeFunding({
          reference,
          amount: input.amount,
          email: person.email,
          method: input.method,
          returnUrl: `${this.env.WEB_APP_URL}/wallet/add/return?id=${id}`,
        });
        return await this.settleStart(tx, id, "pending", {
          providerId: start.providerId,
          action: start.action,
        });
      } catch (error) {
        if (error instanceof ProviderRejected) {
          return this.settleStart(tx, id, "failed", { reason: error.message.slice(0, 300) });
        }
        if (error instanceof ProviderUnavailable) {
          return this.settleStart(tx, id, "failed", { reason: UNAVAILABLE });
        }
        throw error;
      }
    });
    if (outcome.status === "failed") throw failure(outcome);
    return view(outcome);
  }

  private async settleStart(
    tx: Tx,
    id: string,
    status: "pending" | "failed",
    details: { providerId?: string | null; action?: PaymentResponse["action"]; reason?: string },
  ): Promise<IntentRow> {
    const [row] = await sql<IntentRow>(
      tx,
      `UPDATE payment_intents SET status = $2, provider_id = $3, action = $4, failure_reason = $5, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [
        id,
        status,
        details.providerId ?? null,
        details.action ? JSON.stringify(details.action) : null,
        details.reason ?? null,
      ],
    );
    return row!;
  }

  // ---- following a payment -----------------------------------------------------------------------

  /**
   * One of the person's own payments. A payment that has sat pending is checked with the partner as
   * well (one caller at a time, and not more than once in a while), so a webhook that never came
   * does not leave money uncounted.
   */
  async get(userId: string, id: string): Promise<PaymentResponse> {
    let row = await this.find(userId, id);
    if (row.status === "pending" && row.kind === "funding") {
      if (await this.claimReconcile(row.id)) {
        await this.reconcileFunding(row);
        row = await this.find(userId, id);
      }
    }
    return view(row);
  }

  private async find(userId: string, id: string): Promise<IntentRow> {
    const [row] = await this.db.query<IntentRow[]>(
      `SELECT ${COLUMNS} FROM payment_intents WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Whoever wins this update gets to ask the partner; everyone else just reads. */
  private async claimReconcile(id: string): Promise<boolean> {
    // Through `sql`: a plain `query` answers an UPDATE with [rows, count], which is always "something".
    const claimed = await this.db.transaction((tx) =>
      sql<{ id: string }>(
        tx,
        `UPDATE payment_intents SET updated_at = now()
          WHERE id = $1 AND status = 'pending' AND updated_at < now() - make_interval(secs => $2)
          RETURNING id`,
        [id, RECONCILE_AFTER_SECONDS],
      ),
    );
    return claimed.length > 0;
  }

  private async reconcileFunding(row: IntentRow): Promise<void> {
    const provider = this.providers.byName(row.provider);
    if (!provider) return;
    try {
      const paid = await provider.verifyFunding(row.reference, row.provider_id);
      if (paid.status === "pending") return;
      const kind = paid.status === "success" ? "funding.succeeded" : "funding.failed";
      await this.db.transaction((tx) =>
        this.events.apply(tx, provider.name, {
          eventId: `verify:${row.reference}:${paid.status}`,
          type: "verify",
          kind,
          reference: row.reference,
          amount: paid.amount,
          currency: paid.currency,
        }),
      );
    } catch (error) {
      // Not being able to ask is not an answer: leave it pending, and ask again later.
      if (!(error instanceof ProviderUnavailable || error instanceof ProviderRejected)) throw error;
    }
  }
}

export { BadRequestException, ConflictException };
