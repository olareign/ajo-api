import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { FieldEncryption } from "../crypto/field-encryption.js";
import { sql } from "../database/sql.js";
import { PasswordHasher } from "../identity/password-hasher.js";
import { recordSecurityEvent } from "../identity/security-events.js";
import { TrustedDevicesService } from "../identity/trusted-devices.service.js";
import { createOneTimeToken, hashToken } from "../identity/tokens.js";
import { generateRecoveryCodes, hashRecoveryCode } from "./recovery-codes.js";
import { Totp } from "./totp.js";

export const CHALLENGE_MINUTES = 5;
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const MAX_FAILED_CODES = 10;
export const MFA_LOCKOUT_MINUTES = 15;
export const WRONG_CODE = "That code is incorrect.";
export const CHALLENGE_DEAD = "That sign-in took too long. Please start again.";
export const MFA_LOCKED = "Too many wrong codes. Try again in 15 minutes.";
const WRONG_PASSWORD = "That password is incorrect.";

/** What a step-up check found. Worked out inside the transaction, refused after it is saved. */
export type StepUp = "ok" | "wrong_password" | "mfa_required" | "no_code" | "locked" | "wrong_code";

type Tx = Parameters<typeof sql>[0];
export type CodeInput = Readonly<{ code?: string; recoveryCode?: string }>;

@Injectable()
export class MfaService {
  constructor(
    private readonly db: DataSource,
    private readonly hasher: PasswordHasher,
    @Inject(FieldEncryption) private readonly encryption: FieldEncryption,
    @Inject(Totp) private readonly totp: Totp,
    private readonly trusted: TrustedDevicesService,
  ) {}

  private context(userId: string): string {
    return `user:${userId}`;
  }

  async isEnabled(tx: Tx, userId: string): Promise<boolean> {
    const rows = await sql(
      tx,
      `SELECT 1 FROM user_mfa WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
      [userId],
    );
    return rows.length > 0;
  }

  /** For money coming in: the second lock must exist; no code is asked for. */
  async requireEnrolled(userId: string): Promise<void> {
    const rows = await this.db.query<{ one: number }[]>(
      `SELECT 1 AS one FROM user_mfa WHERE user_id = $1 AND confirmed_at IS NOT NULL`,
      [userId],
    );
    if (rows.length === 0) {
      throw new ForbiddenException({
        message: "Turn on the authenticator app before you move money.",
        code: "mfa_enrolment_required",
      });
    }
  }

  /** Starts (or restarts) setup: a new secret, kept unconfirmed until a correct code proves it works. */
  async enrol(userId: string, email: string): Promise<{ secret: string; otpauthUri: string }> {
    const { secret, uri } = this.totp.createSecret(email);
    const sealed = this.encryption.encrypt(secret, this.context(userId));
    const written = await this.db.query<{ user_id: string }[]>(
      `INSERT INTO user_mfa (user_id, totp_secret) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET totp_secret = EXCLUDED.totp_secret, created_at = now()
         WHERE user_mfa.confirmed_at IS NULL
       RETURNING user_id`,
      [userId, sealed],
    );
    // Nothing returned means a confirmed secret already exists and was left alone.
    if (written.length === 0) {
      throw new ConflictException("The authenticator app is already turned on.");
    }
    return { secret, otpauthUri: uri };
  }

  /**
   * Turns the second factor on and returns the recovery codes, which are never shown again, and the
   * secret of the device that just proved it has the app: that phone is remembered, so the next
   * sign-in on it does not ask straight away.
   */
  async confirm(
    userId: string,
    code: string,
    userAgent: string | undefined,
  ): Promise<{ recoveryCodes: string[]; deviceToken: string }> {
    const codes = generateRecoveryCodes();
    let deviceToken = "";
    const outcome = await this.db.transaction(async (tx) => {
      const [row] = await sql<{ totp_secret: string; confirmed_at: Date | null }>(
        tx,
        `SELECT totp_secret, confirmed_at FROM user_mfa WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (!row) return "not_started" as const;
      if (row.confirmed_at) return "already" as const;
      const check = this.totp.verify(
        this.encryption.decrypt(row.totp_secret, this.context(userId)),
        code,
        null,
      );
      if (!check.ok) return "wrong" as const;
      await sql(
        tx,
        `UPDATE user_mfa SET confirmed_at = now(), last_used_step = $2,
                failed_attempts = 0, locked_until = NULL WHERE user_id = $1`,
        [userId, check.step],
      );
      await sql(tx, `DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
      for (const recoveryCode of codes) {
        await sql(tx, `INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
          userId,
          hashRecoveryCode(recoveryCode),
        ]);
      }
      deviceToken = await this.trusted.remember(tx, userId, userAgent);
      await recordSecurityEvent(tx, userId, "mfa_on", { userAgent });
      return "ok" as const;
    });
    if (outcome === "already")
      throw new ConflictException("The authenticator app is already turned on.");
    if (outcome === "not_started") {
      throw new BadRequestException("Start setting up the authenticator app again.");
    }
    if (outcome === "wrong") throw new BadRequestException(WRONG_CODE);
    return { recoveryCodes: codes, deviceToken };
  }

  /** Turning it off needs the password and a current code, so a stolen session alone cannot do it. */
  async disable(userId: string, password: string, code: string): Promise<void> {
    const outcome = await this.db.transaction(async (tx) => {
      const [row] = await sql<{
        totp_secret: string;
        last_used_step: string | null;
        password_hash: string;
      }>(
        tx,
        `SELECT m.totp_secret, m.last_used_step, u.password_hash
           FROM user_mfa m JOIN users u ON u.id = m.user_id
          WHERE m.user_id = $1 AND m.confirmed_at IS NOT NULL FOR UPDATE OF m`,
        [userId],
      );
      if (!row) return "not_enabled" as const;
      if (!(await this.hasher.verify(row.password_hash, password)))
        return "wrong_password" as const;
      const check = this.totp.verify(
        this.encryption.decrypt(row.totp_secret, this.context(userId)),
        code,
        row.last_used_step === null ? null : Number(row.last_used_step),
      );
      if (!check.ok) return "wrong_code" as const;
      await sql(tx, `DELETE FROM mfa_challenges WHERE user_id = $1`, [userId]);
      await this.trusted.forgetAllIn(tx, userId);
      await sql(tx, `DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
      await sql(tx, `DELETE FROM user_mfa WHERE user_id = $1`, [userId]);
      await recordSecurityEvent(tx, userId, "mfa_off");
      return "ok" as const;
    });
    if (outcome === "not_enabled")
      throw new BadRequestException("The authenticator app is not turned on.");
    // A `code` marks these as a refused answer, not an expired session, so the web app does not sign
    // the person out over a typo.
    if (outcome === "wrong_password") {
      throw new UnauthorizedException({ message: WRONG_PASSWORD, code: "password_wrong" });
    }
    if (outcome === "wrong_code") {
      throw new UnauthorizedException({ message: WRONG_CODE, code: "mfa_code_wrong" });
    }
  }

  /**
   * The gate in front of any money movement: the authenticator app must be turned on, and a fresh
   * code must come with the request. A code works once (the same replay rule as signing in) and wrong
   * ones count towards the same lockout, so a stolen session cannot be used to guess at it.
   */
  async requireForMoney(userId: string, code: string | undefined): Promise<void> {
    const outcome = await this.db.transaction(async (tx) => {
      const [mfa] = await sql<{
        totp_secret: string;
        last_used_step: string | null;
        failed_attempts: number;
        locked: boolean;
      }>(
        tx,
        `SELECT totp_secret, last_used_step, failed_attempts,
                coalesce(locked_until > now(), false) AS locked
           FROM user_mfa WHERE user_id = $1 AND confirmed_at IS NOT NULL FOR UPDATE`,
        [userId],
      );
      if (!mfa) return "not_enrolled" as const;
      if (code === undefined || code === "") return "no_code" as const;
      if (mfa.locked) return "locked" as const;

      const check = this.totp.verify(
        this.encryption.decrypt(mfa.totp_secret, this.context(userId)),
        code,
        mfa.last_used_step === null ? null : Number(mfa.last_used_step),
      );
      if (check.ok) {
        await sql(
          tx,
          `UPDATE user_mfa SET last_used_step = $2, failed_attempts = 0 WHERE user_id = $1`,
          [userId, check.step],
        );
        return "ok" as const;
      }
      const failures = mfa.failed_attempts + 1;
      const lock = failures >= MAX_FAILED_CODES;
      await sql(
        tx,
        `UPDATE user_mfa
            SET failed_attempts = $2::int,
                locked_until = CASE WHEN $3::boolean THEN now() + make_interval(mins => $4::int) ELSE locked_until END
          WHERE user_id = $1`,
        [userId, lock ? 0 : failures, lock, MFA_LOCKOUT_MINUTES],
      );
      return "wrong" as const;
    });

    if (outcome === "ok") return;
    if (outcome === "not_enrolled") {
      throw new ForbiddenException({
        message: "Turn on the authenticator app before you move money.",
        code: "mfa_enrolment_required",
      });
    }
    if (outcome === "no_code") {
      throw new UnauthorizedException({
        message: "Enter the code from your authenticator app.",
        code: "mfa_code_required",
      });
    }
    if (outcome === "locked") {
      throw new UnauthorizedException({ message: MFA_LOCKED, code: "mfa_locked" });
    }
    throw new UnauthorizedException({ message: WRONG_CODE, code: "mfa_code_wrong" });
  }

  /**
   * "Is it really you?" for changes to the account itself: the password, and a fresh authenticator
   * code when it is on (always, when `codeRequired`). The code follows the money gate's rules (used
   * once, wrong ones count towards the same lockout). Runs inside the caller's transaction and only
   * reports: the caller refuses after the transaction is saved, so a wrong code still counts.
   */
  async stepUp(
    tx: Tx,
    userId: string,
    password: string,
    code: string | undefined,
    codeRequired = false,
  ): Promise<StepUp> {
    const [user] = await sql<{ password_hash: string }>(
      tx,
      `SELECT password_hash FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!user || !(await this.hasher.verify(user.password_hash, password))) return "wrong_password";
    const [mfa] = await sql<{
      totp_secret: string;
      last_used_step: string | null;
      failed_attempts: number;
      locked: boolean;
    }>(
      tx,
      `SELECT totp_secret, last_used_step, failed_attempts,
              coalesce(locked_until > now(), false) AS locked
         FROM user_mfa WHERE user_id = $1 AND confirmed_at IS NOT NULL FOR UPDATE`,
      [userId],
    );
    if (!mfa) return codeRequired ? "mfa_required" : "ok";
    if (!code) return "no_code";
    if (mfa.locked) return "locked";
    const check = this.totp.verify(
      this.encryption.decrypt(mfa.totp_secret, this.context(userId)),
      code,
      mfa.last_used_step === null ? null : Number(mfa.last_used_step),
    );
    if (check.ok) {
      await sql(
        tx,
        `UPDATE user_mfa SET last_used_step = $2, failed_attempts = 0 WHERE user_id = $1`,
        [userId, check.step],
      );
      return "ok";
    }
    const failures = mfa.failed_attempts + 1;
    const lock = failures >= MAX_FAILED_CODES;
    await sql(
      tx,
      `UPDATE user_mfa
          SET failed_attempts = $2::int,
              locked_until = CASE WHEN $3::boolean THEN now() + make_interval(mins => $4::int) ELSE locked_until END
        WHERE user_id = $1`,
      [userId, lock ? 0 : failures, lock, MFA_LOCKOUT_MINUTES],
    );
    return "wrong_code";
  }

  /** Turns a step-up result that is not "ok" into the answer the person sees. */
  static refuse(outcome: Exclude<StepUp, "ok">): never {
    // Each carries a `code`, so the web app treats it as a refused answer, not an ended session.
    if (outcome === "wrong_password")
      throw new UnauthorizedException({ message: WRONG_PASSWORD, code: "password_wrong" });
    if (outcome === "mfa_required")
      throw new ForbiddenException({
        message: "Turn on the authenticator app first.",
        code: "mfa_enrolment_required",
      });
    if (outcome === "no_code")
      throw new UnauthorizedException({
        message: "Enter the code from your authenticator app.",
        code: "mfa_code_required",
      });
    if (outcome === "locked")
      throw new UnauthorizedException({ message: MFA_LOCKED, code: "mfa_locked" });
    throw new UnauthorizedException({ message: WRONG_CODE, code: "mfa_code_wrong" });
  }

  /** A new set of recovery codes, shown once; the old set stops working. Password and code first. */
  async renewRecoveryCodes(
    userId: string,
    password: string,
    code: string,
    client: Readonly<{ ip?: string; userAgent?: string }>,
  ): Promise<string[]> {
    const codes = generateRecoveryCodes();
    const outcome = await this.db.transaction(async (tx) => {
      const check = await this.stepUp(tx, userId, password, code, true);
      if (check !== "ok") return check;
      await sql(tx, `DELETE FROM mfa_recovery_codes WHERE user_id = $1`, [userId]);
      for (const recoveryCode of codes) {
        await sql(tx, `INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
          userId,
          hashRecoveryCode(recoveryCode),
        ]);
      }
      await recordSecurityEvent(tx, userId, "recovery_codes_renewed", client);
      return "ok" as const;
    });
    if (outcome !== "ok") MfaService.refuse(outcome);
    return codes;
  }

  /** After the password is right: a short-lived, single-use token that carries the sign-in to step two. */
  async createChallenge(tx: Tx, userId: string): Promise<string> {
    const { token, hash } = createOneTimeToken();
    await sql(
      tx,
      `INSERT INTO mfa_challenges (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [userId, hash, CHALLENGE_MINUTES],
    );
    return token;
  }

  /**
   * Checks a code (or a recovery code) against a challenge and returns whose sign-in it was. A
   * challenge allows five tries, and ten wrong codes in a row lock the second step for 15 minutes,
   * so a stolen password cannot be used to guess codes.
   */
  async completeChallenge(mfaToken: string, input: CodeInput): Promise<string> {
    const outcome = await this.db.transaction(async (tx) => {
      const [challenge] = await sql<{
        id: string;
        user_id: string;
        attempts: number;
        dead: boolean;
      }>(
        tx,
        `SELECT id, user_id, attempts,
                (used_at IS NOT NULL OR expires_at <= now() OR attempts >= $2) AS dead
           FROM mfa_challenges WHERE token_hash = $1 FOR UPDATE`,
        [hashToken(mfaToken), MAX_CHALLENGE_ATTEMPTS],
      );
      if (!challenge || challenge.dead) return { kind: "dead" } as const;

      const [mfa] = await sql<{
        totp_secret: string;
        last_used_step: string | null;
        failed_attempts: number;
        locked: boolean;
      }>(
        tx,
        `SELECT totp_secret, last_used_step, failed_attempts,
                coalesce(locked_until > now(), false) AS locked
           FROM user_mfa WHERE user_id = $1 AND confirmed_at IS NOT NULL FOR UPDATE`,
        [challenge.user_id],
      );
      if (!mfa) return { kind: "dead" } as const;
      if (mfa.locked) return { kind: "locked" } as const;

      let accepted = false;
      if (input.code !== undefined) {
        const check = this.totp.verify(
          this.encryption.decrypt(mfa.totp_secret, this.context(challenge.user_id)),
          input.code,
          mfa.last_used_step === null ? null : Number(mfa.last_used_step),
        );
        if (check.ok) {
          await sql(tx, `UPDATE user_mfa SET last_used_step = $2 WHERE user_id = $1`, [
            challenge.user_id,
            check.step,
          ]);
          accepted = true;
        }
      } else if (input.recoveryCode !== undefined) {
        const used = await sql(
          tx,
          `UPDATE mfa_recovery_codes SET used_at = now()
            WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING id`,
          [challenge.user_id, hashRecoveryCode(input.recoveryCode)],
        );
        accepted = used.length > 0;
      }

      if (accepted) {
        await sql(tx, `UPDATE mfa_challenges SET used_at = now() WHERE id = $1`, [challenge.id]);
        await sql(tx, `UPDATE user_mfa SET failed_attempts = 0 WHERE user_id = $1`, [
          challenge.user_id,
        ]);
        return { kind: "ok", userId: challenge.user_id } as const;
      }

      const attempts = challenge.attempts + 1;
      await sql(
        tx,
        `UPDATE mfa_challenges SET attempts = $2::int,
                used_at = CASE WHEN $2::int >= $3::int THEN now() ELSE used_at END WHERE id = $1`,
        [challenge.id, attempts, MAX_CHALLENGE_ATTEMPTS],
      );
      const failures = mfa.failed_attempts + 1;
      const lock = failures >= MAX_FAILED_CODES;
      await sql(
        tx,
        `UPDATE user_mfa
            SET failed_attempts = $2::int,
                locked_until = CASE WHEN $3::boolean THEN now() + make_interval(mins => $4::int) ELSE locked_until END
          WHERE user_id = $1`,
        [challenge.user_id, lock ? 0 : failures, lock, MFA_LOCKOUT_MINUTES],
      );
      return { kind: "wrong" } as const;
    });

    if (outcome.kind === "ok") return outcome.userId;
    if (outcome.kind === "locked") throw new UnauthorizedException(MFA_LOCKED);
    if (outcome.kind === "dead") throw new UnauthorizedException(CHALLENGE_DEAD);
    throw new UnauthorizedException(WRONG_CODE);
  }
}
