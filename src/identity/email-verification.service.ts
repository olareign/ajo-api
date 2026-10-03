import { Inject, Injectable, Logger } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { MAILER, type Mailer } from "../adapters/mail/mailer.port.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { verificationEmail } from "./emails.js";
import { createOneTimeToken } from "./tokens.js";

export const VERIFICATION_TTL_HOURS = 24;
/** The same address gets at most one verification email in this many seconds... */
export const RESEND_COOLDOWN_SECONDS = 60;
/** ...and at most this many in a day, however it is asked for. */
export const MAX_VERIFICATION_EMAILS_PER_DAY = 10;

export type VerificationLink = Readonly<{ token: string; hash: string }>;

/**
 * Creates and sends email-verification links. Every way of asking for one (sign-up, "resend",
 * a sign-in before confirming) goes through here, so the limits apply to all of them and
 * none can be used to flood someone's inbox.
 */
@Injectable()
export class EmailVerification {
  private readonly logger = new Logger(EmailVerification.name);

  constructor(
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Stores a new single-use link for the person, without any limit. */
  async createLink(
    tx: Pick<EntityManager, "queryRunner">,
    userId: string,
  ): Promise<VerificationLink> {
    const link = createOneTimeToken();
    await sql(
      tx,
      `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(hours => $3))`,
      [userId, link.hash, VERIFICATION_TTL_HOURS],
    );
    return link;
  }

  /**
   * Like `createLink`, but returns null when a link went out in the last minute or the day's
   * allowance is used. Callers answer the same either way. Hold a lock on the user's row first,
   * so two requests at once cannot both pass.
   */
  async createLinkIfAllowed(
    tx: Pick<EntityManager, "queryRunner">,
    userId: string,
  ): Promise<VerificationLink | null> {
    const [counts] = await sql<{ recent: number; today: number }>(
      tx,
      `SELECT count(*) FILTER (WHERE created_at > now() - make_interval(secs => $2))::int AS recent,
              count(*)::int AS today
         FROM email_verification_tokens
        WHERE user_id = $1 AND created_at > now() - interval '24 hours'`,
      [userId, RESEND_COOLDOWN_SECONDS],
    );
    if (!counts || counts.recent > 0 || counts.today >= MAX_VERIFICATION_EMAILS_PER_DAY)
      return null;
    return this.createLink(tx, userId);
  }

  /** Emails the link. Never rejects: a failed send is logged, and the person can ask again. */
  async send(to: string, name: string, link: VerificationLink): Promise<void> {
    const message = verificationEmail({
      to,
      name,
      link: `${this.env.WEB_APP_URL}/verify-email?token=${link.token}`,
    });
    try {
      await this.mailer.send({ to, idempotencyKey: link.hash, ...message });
    } catch (error) {
      this.logger.error({ err: error }, "Could not send verification email");
    }
  }
}
