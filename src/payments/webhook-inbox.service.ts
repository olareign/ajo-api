import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { PaymentEvents, type Applied } from "./payment-events.service.js";
import { PaymentProviders } from "./providers/providers.service.js";
import type { PaymentProvider, ProviderEvent, ProviderName } from "./providers/provider.port.js";

/** An event that keeps failing is left for a person after this many tries. */
export const MAX_ATTEMPTS = 10;
const NEEDS_A_PERSON = MAX_ATTEMPTS + 1;

type Row = {
  id: string;
  provider: ProviderName;
  payload: ProviderEvent;
  status: "received" | "processed" | "ignored" | "failed";
  attempts: number;
};

/**
 * The webhook inbox. A partner's signed event is stored first, once (the same event again changes
 * nothing), and only then acted on, under a lock so two copies of the process cannot both act on it.
 * If acting fails the event stays stored and is tried again, so a crash or an outage loses nothing.
 */
@Injectable()
export class WebhookInbox {
  private readonly logger = new Logger(WebhookInbox.name);

  constructor(
    private readonly db: DataSource,
    private readonly events: PaymentEvents,
    private readonly providers: PaymentProviders,
  ) {}

  /** Stores each event once and acts on it. Throws InvalidWebhookSignature for a forged request. */
  async receive(
    provider: PaymentProvider,
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<number> {
    const events = provider.parseWebhook(rawBody, signature);
    const ids: string[] = [];
    for (const event of events) {
      const [stored] = await this.db.query<{ id: string }[]>(
        `INSERT INTO webhook_events (provider, event_id, kind, type, payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider, event_id) DO UPDATE SET provider = excluded.provider
         RETURNING id`,
        [provider.name, event.eventId, event.kind, event.type, JSON.stringify(event)],
      );
      ids.push(stored!.id);
    }
    // Acting is best-effort here: the event is safely stored, and anything that fails is retried.
    for (const id of ids) await this.process(id);
    return events.length;
  }

  /** Tries every stored event that has not been settled. Safe to run often, and from several places at once. */
  async drain(limit = 50): Promise<number> {
    const open = await this.db.query<{ id: string }[]>(
      `SELECT id FROM webhook_events WHERE status IN ('received', 'failed') AND attempts < $1
        ORDER BY received_at LIMIT $2`,
      [MAX_ATTEMPTS, limit],
    );
    for (const { id } of open) await this.process(id);
    return open.length;
  }

  async process(id: string): Promise<void> {
    const [row] = await this.db.query<Row[]>(
      `SELECT id, provider, payload, status, attempts FROM webhook_events WHERE id = $1`,
      [id],
    );
    if (!row || row.status === "processed" || row.status === "ignored") return;
    const provider = this.providers.byName(row.provider);
    if (!provider) return; // Its partner is not connected here (any longer): leave it stored.

    let event = row.payload;
    try {
      // Some partners' events do not say which payment they are about: ask, before taking any lock.
      if (!event.reference && provider.lookupReference && isAboutAPayment(event)) {
        const reference = await provider.lookupReference(event);
        if (reference) event = { ...event, reference };
      }
      await this.db.transaction(async (tx) => {
        const [locked] = await sql<{ id: string }>(
          tx,
          `SELECT id FROM webhook_events
            WHERE id = $1 AND status IN ('received', 'failed') FOR UPDATE SKIP LOCKED`,
          [id],
        );
        // Settled meanwhile, or being settled by another copy of this process: nothing to do.
        if (!locked) return;
        const outcome = await this.events.apply(tx, row.provider, event);
        await sql(
          tx,
          `UPDATE webhook_events SET status = $2, last_error = $3, processed_at = now(),
                  attempts = CASE WHEN $4::boolean THEN $5::int ELSE attempts + 1 END
            WHERE id = $1`,
          [
            id,
            statusOf(outcome),
            outcome.result === "applied" ? null : outcome.note.slice(0, 500),
            outcome.result === "attention",
            NEEDS_A_PERSON,
          ],
        );
        if (outcome.result === "attention") {
          this.logger.error(
            { eventId: row.payload.eventId, note: outcome.note },
            "Event needs a person",
          );
        }
      });
    } catch (error) {
      await this.db.query(
        `UPDATE webhook_events SET status = 'failed', attempts = attempts + 1, last_error = $2 WHERE id = $1 AND status IN ('received', 'failed')`,
        [id, String(error instanceof Error ? error.message : error).slice(0, 500)],
      );
      this.logger.warn(
        { err: error, eventId: row.payload.eventId },
        "Event not settled; will retry",
      );
    }
  }
}

const isAboutAPayment = (event: ProviderEvent) =>
  event.kind === "funding.succeeded" || event.kind === "funding.failed";

function statusOf(outcome: Applied): "processed" | "ignored" | "failed" {
  if (outcome.result === "applied") return "processed";
  return outcome.result === "ignored" ? "ignored" : "failed";
}
