import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";
import { MAILER, type Mailer } from "../adapters/mail/mailer.port.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { notificationEmail } from "../identity/emails.js";
import { Scheduler } from "../scheduler/scheduler.service.js";

type Tx = Parameters<typeof sql>[0];

export type NewNotification = Readonly<{
  /** A short machine name for the sort of message, e.g. "plan.debit_failed". */
  kind: string;
  title: string;
  body: string;
  /** An in-app path to open, such as "/save/<id>". */
  link?: string;
  /** The same key for the same person is only ever sent once. */
  dedupeKey: string;
  /** Also send an email. Anything about money not moving should. */
  email?: boolean;
}>;

export type NotificationRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  created_at: Date;
  read_at: Date | null;
};

/** An email that keeps failing is left after this many tries. */
export const MAX_EMAIL_ATTEMPTS = 5;

/**
 * One place that tells people things. A message is first saved for the app (and, if asked, queued for
 * email) inside the caller's own database transaction when it has one, so "the debit failed" and
 * "tell them it failed" commit together. Email goes out afterwards from the queue.
 */
@Injectable()
export class Notifications implements OnModuleInit {
  private readonly logger = new Logger(Notifications.name);

  constructor(
    private readonly db: DataSource,
    private readonly scheduler: Scheduler,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({ name: "notifications", run: () => this.sendQueuedEmails() });
  }

  /** Returns whether it was new (false: this person already had this message). */
  async notify(userId: string, message: NewNotification, within?: Tx): Promise<boolean> {
    const text = `INSERT INTO notifications (user_id, kind, title, body, link, dedupe_key, email_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`;
    const params = [
      userId,
      message.kind,
      message.title.slice(0, 120),
      message.body.slice(0, 500),
      message.link ?? null,
      message.dedupeKey,
      message.email ? "pending" : "none",
    ];
    const rows = within
      ? await sql<{ id: string }>(within, text, params)
      : await this.db.query<{ id: string }[]>(text, params);
    return rows.length > 0;
  }

  async list(userId: string, limit: number, before?: string) {
    const rows = await this.db.query<(NotificationRow & { seq: string })[]>(
      `SELECT id, kind, title, body, link, created_at, read_at, seq::text AS seq
         FROM notifications
        WHERE user_id = $1 AND ($3::bigint IS NULL OR seq < $3::bigint)
        ORDER BY seq DESC LIMIT $2`,
      [userId, limit + 1, before ?? null],
    );
    const page = rows.slice(0, limit);
    const [counted] = await this.db.query<{ unread: string }[]>(
      `SELECT count(*)::text AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
    return {
      items: page,
      next: rows.length > limit ? page[page.length - 1]!.seq : null,
      unread: Number(counted?.unread ?? 0),
    };
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.db.query(
      `UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
      [id, userId],
    );
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
  }

  /**
   * Sends the emails waiting in the queue. Each is claimed under a row lock that skips rows another
   * copy holds, and an email that fails stays queued for the next pass until it has failed enough times.
   */
  async sendQueuedEmails(limit = 25): Promise<number> {
    let sent = 0;
    // An email that fails is not tried again in the same pass, or one outage would use up every attempt at once.
    const tried: string[] = [];
    for (let i = 0; i < limit; i += 1) {
      const done = await this.db.transaction(async (tx) => {
        const [row] = await sql<{
          id: string;
          title: string;
          body: string;
          link: string | null;
          email: string;
          name: string;
          attempts: number;
        }>(
          tx,
          `SELECT n.id, n.title, n.body, n.link, u.email, u.display_name AS name, n.email_attempts AS attempts
             FROM notifications n JOIN users u ON u.id = n.user_id
            WHERE n.email_status = 'pending' AND n.email_attempts < $1 AND n.id <> ALL($2::uuid[])
            ORDER BY n.created_at LIMIT 1 FOR UPDATE OF n SKIP LOCKED`,
          [MAX_EMAIL_ATTEMPTS, tried],
        );
        if (!row) return "none" as const;
        tried.push(row.id);
        const message = notificationEmail({
          name: row.name,
          title: row.title,
          body: row.body,
          link: `${this.env.WEB_APP_URL}${row.link ?? "/today"}`,
        });
        try {
          await this.mailer.send({
            to: row.email,
            ...message,
            // The same key is never delivered twice, even if the mark below is lost.
            idempotencyKey: `notification:${row.id}`,
          });
          await sql(tx, `UPDATE notifications SET email_status = 'sent' WHERE id = $1`, [row.id]);
          return "sent" as const;
        } catch (error) {
          const attempts = row.attempts + 1;
          await sql(
            tx,
            `UPDATE notifications SET email_attempts = $2::int,
                    email_status = CASE WHEN $2::int >= $3::int THEN 'failed' ELSE 'pending' END WHERE id = $1`,
            [row.id, attempts, MAX_EMAIL_ATTEMPTS],
          );
          this.logger.warn(
            `Email for notification ${row.id} failed (${attempts}): ${error instanceof Error ? error.message : "unknown"}`,
          );
          return "failed" as const;
        }
      });
      if (done === "none") break;
      if (done === "sent") sent += 1;
    }
    return sent;
  }
}
