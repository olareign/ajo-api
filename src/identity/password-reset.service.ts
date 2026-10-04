import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  BREACHED_PASSWORDS,
  type BreachedPasswords,
} from "../adapters/breached-passwords/breached-passwords.port.js";
import { MAILER, type Mailer } from "../adapters/mail/mailer.port.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { passwordChangedEmail, passwordResetEmail } from "./emails.js";
import { PasswordHasher } from "./password-hasher.js";
import { TrustedDevicesService } from "./trusted-devices.service.js";
import { checkPassword } from "./password-policy.js";
import { INVALID_LINK } from "./sign-up.service.js";
import { createOneTimeToken, hashToken } from "./tokens.js";

export const RESET_TTL_MINUTES = 60;

@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly db: DataSource,
    private readonly hasher: PasswordHasher,
    private readonly trusted: TrustedDevicesService,
    @Inject(BREACHED_PASSWORDS) private readonly breached: BreachedPasswords,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Emails a reset link if the address has an account. The caller answers the same either way, and
   * the email is sent without waiting, so neither the response nor its timing reveals who has one.
   * A new request cancels any earlier link.
   */
  async request(email: string): Promise<void> {
    const { token, hash } = createOneTimeToken();
    const user = await this.db.transaction(async (tx) => {
      const rows = await sql<{ id: string; display_name: string }>(
        tx,
        `SELECT id, display_name FROM users WHERE email = $1`,
        [email],
      );
      const found = rows[0];
      if (!found) return null;
      await sql(
        tx,
        `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
        [found.id],
      );
      await sql(
        tx,
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3))`,
        [found.id, hash, RESET_TTL_MINUTES],
      );
      return found;
    });
    if (!user) return;

    const message = passwordResetEmail({
      to: email,
      name: user.display_name,
      link: `${this.env.WEB_APP_URL}/reset-password?token=${token}`,
    });
    this.send(email, hash, message);
  }

  /** Sets a new password from a reset link, once, and signs the person out everywhere. */
  async reset(token: string, password: string): Promise<void> {
    const rows = await this.db.query<
      { id: string; user_id: string; email: string; display_name: string }[]
    >(
      `SELECT t.id, t.user_id, u.email, u.display_name
         FROM password_reset_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > now()`,
      [hashToken(token)],
    );
    const link = rows[0];
    if (!link) throw new BadRequestException(INVALID_LINK);

    // Checked before the link is used up, so a weak choice does not cost the person their link.
    const problems = await checkPassword(password, link.email, this.breached);
    if (problems.length > 0) {
      throw new BadRequestException({
        message: "Password does not meet the requirements",
        details: { password: problems },
      });
    }
    const passwordHash = await this.hasher.hash(password);

    const changed = await this.db.transaction(async (tx) => {
      const used = await sql<{ user_id: string }>(
        tx,
        `UPDATE password_reset_tokens SET used_at = now()
          WHERE id = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [link.id],
      );
      if (!used[0]) return false;
      // Following the link proves the mailbox is theirs, so it also confirms the email and
      // clears any lockout.
      await sql(
        tx,
        `UPDATE users
            SET password_hash = $2,
                email_verified = true,
                email_verified_at = coalesce(email_verified_at, now()),
                failed_login_count = 0,
                locked_until = NULL,
                updated_at = now()
          WHERE id = $1`,
        [link.user_id, passwordHash],
      );
      await sql(
        tx,
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_reset'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [link.user_id],
      );
      // A new password means the old one may have been known to someone: no device stays trusted.
      await this.trusted.forgetAllIn(tx, link.user_id);
      await sql(
        tx,
        `UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`,
        [link.user_id],
      );
      return true;
    });
    if (!changed) throw new BadRequestException(INVALID_LINK);

    this.send(
      link.email,
      `changed-${link.id}`,
      passwordChangedEmail({
        to: link.email,
        name: link.display_name,
        signInLink: `${this.env.WEB_APP_URL}/sign-in`,
      }),
    );
  }

  private send(
    to: string,
    idempotencyKey: string,
    message: { subject: string; text: string; html: string },
  ) {
    this.mailer.send({ to, idempotencyKey, ...message }).catch((error: unknown) => {
      this.logger.error({ err: error }, "Could not send password email");
    });
  }
}
