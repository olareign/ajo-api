import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import {
  BREACHED_PASSWORDS,
  type BreachedPasswords,
} from "../adapters/breached-passwords/breached-passwords.port.js";
import { MAILER, type Mailer } from "../adapters/mail/mailer.port.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { accountExistsEmail, verificationEmail } from "./emails.js";
import { PasswordHasher } from "./password-hasher.js";
import { checkPassword } from "./password-policy.js";
import { createOneTimeToken, hashToken } from "./tokens.js";

export const VERIFICATION_TTL_HOURS = 24;
export const INVALID_LINK = "This link is invalid or has expired.";

@Injectable()
export class SignUpService {
  private readonly logger = new Logger(SignUpService.name);

  constructor(
    private readonly db: DataSource,
    private readonly hasher: PasswordHasher,
    @Inject(BREACHED_PASSWORDS) private readonly breached: BreachedPasswords,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Creates an unverified account. The outcome is identical whether or not the email is
   * already registered (the owner gets a warning email instead), so sign-up cannot be
   * used to discover who has an account.
   */
  async signUp(input: { email: string; password: string; displayName: string }): Promise<void> {
    const problems = await checkPassword(input.password, input.email, this.breached);
    if (problems.length > 0) {
      throw new BadRequestException({
        message: "Password does not meet the requirements",
        details: { password: problems },
      });
    }

    // Hash before looking anything up, so both paths take the same time.
    const passwordHash = await this.hasher.hash(input.password);
    const { token, hash } = createOneTimeToken();

    const created = await this.db.transaction(async (tx) => {
      const rows = await sql<{ id: string }>(
        tx,
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [input.email, passwordHash, input.displayName],
      );
      const userId = rows[0]?.id;
      if (userId) {
        await sql(
          tx,
          `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + make_interval(hours => $3))`,
          [userId, hash, VERIFICATION_TTL_HOURS],
        );
      }
      return userId;
    });

    const email = created
      ? verificationEmail({
          to: input.email,
          name: input.displayName,
          link: `${this.env.WEB_APP_URL}/verify-email?token=${token}`,
        })
      : accountExistsEmail({ to: input.email, signInLink: `${this.env.WEB_APP_URL}/sign-in` });

    try {
      await this.mailer.send({ to: input.email, idempotencyKey: hash, ...email });
    } catch (error) {
      // The account exists either way; the user can ask for a new link.
      this.logger.error({ err: error }, "Could not send sign-up email");
    }
  }

  /** Consumes a verification token exactly once, atomically. */
  async verifyEmail(token: string): Promise<void> {
    const verified = await this.db.transaction(async (tx) => {
      const rows = await sql<{ user_id: string }>(
        tx,
        `UPDATE email_verification_tokens
            SET used_at = now()
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [hashToken(token)],
      );
      const userId = rows[0]?.user_id;
      if (!userId) return false;
      await sql(
        tx,
        `UPDATE users SET email_verified_at = coalesce(email_verified_at, now()), updated_at = now()
          WHERE id = $1`,
        [userId],
      );
      return true;
    });
    if (!verified) {
      throw new BadRequestException(INVALID_LINK);
    }
  }
}
