import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import {
  BREACHED_PASSWORDS,
  type BreachedPasswords,
} from "../adapters/breached-passwords/breached-passwords.port.js";
import { BOT_CHECK, type BotCheck } from "../adapters/bot-check/bot-check.port.js";
import { MAILER, type Mailer } from "../adapters/mail/mailer.port.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { accountExistsEmail } from "./emails.js";
import { EmailVerification } from "./email-verification.service.js";
import { PasswordHasher } from "./password-hasher.js";
import { checkPassword } from "./password-policy.js";
import { hashToken } from "./tokens.js";

export const INVALID_LINK = "This link is invalid or has expired.";
export const BOT_CHECK_FAILED = "bot_check_failed";
export const BOT_CHECK_UNAVAILABLE = "bot_check_unavailable";

@Injectable()
export class SignUpService {
  private readonly logger = new Logger(SignUpService.name);

  constructor(
    private readonly db: DataSource,
    private readonly hasher: PasswordHasher,
    @Inject(BREACHED_PASSWORDS) private readonly breached: BreachedPasswords,
    @Inject(BOT_CHECK) private readonly botCheck: BotCheck,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly verification: EmailVerification,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Creates an unverified account. The outcome is identical whether or not the email is
   * already registered (the owner gets a warning email instead), so sign-up cannot be
   * used to discover who has an account.
   */
  async signUp(input: {
    email: string;
    password: string;
    displayName: string;
    botToken?: string;
  }): Promise<void> {
    // First, before any hashing, lookup or network call about the password: a bot costs us nothing.
    const human = await this.botCheck.verify(input.botToken);
    if (human === "failed") {
      throw new BadRequestException({
        message: "Please complete the check and try again.",
        code: BOT_CHECK_FAILED,
      });
    }
    if (human === "unavailable") {
      throw new ServiceUnavailableException({
        message: "We couldn't run the check just now. Please try again in a moment.",
        code: BOT_CHECK_UNAVAILABLE,
      });
    }

    const problems = await checkPassword(input.password, input.email, this.breached);
    if (problems.length > 0) {
      throw new BadRequestException({
        message: "Password does not meet the requirements",
        details: { password: problems },
      });
    }

    // Hash before looking anything up, so both paths take the same time.
    const passwordHash = await this.hasher.hash(input.password);

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
      return userId ? await this.verification.createLink(tx, userId) : null;
    });

    if (created) {
      // The account exists either way; the user can ask for a new link.
      await this.verification.send(input.email, input.displayName, created);
      return;
    }
    try {
      await this.mailer.send({
        to: input.email,
        idempotencyKey: `exists-${randomUUID()}`,
        ...accountExistsEmail({ to: input.email, signInLink: `${this.env.WEB_APP_URL}/sign-in` }),
      });
    } catch (error) {
      this.logger.error({ err: error }, "Could not send sign-up email");
    }
  }

  /**
   * Sends a new link to an account that still needs confirming. Answers nothing about whether
   * the address has an account, and the email goes out without waiting, so neither the answer
   * nor its timing tells.
   */
  async resendVerification(email: string): Promise<void> {
    const pending = await this.db.transaction(async (tx) => {
      const [user] = await sql<{ id: string; email: string; display_name: string }>(
        tx,
        `SELECT id, email, display_name FROM users
          WHERE email = $1 AND NOT email_verified AND status = 'active' FOR UPDATE`,
        [email],
      );
      if (!user) return null;
      const link = await this.verification.createLinkIfAllowed(tx, user.id);
      return link ? { user, link } : null;
    });
    if (pending)
      void this.verification.send(pending.user.email, pending.user.display_name, pending.link);
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
        `UPDATE users
            SET email_verified = true,
                email_verified_at = coalesce(email_verified_at, now()),
                updated_at = now()
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
