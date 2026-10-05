import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  BREACHED_PASSWORDS,
  type BreachedPasswords,
} from "../adapters/breached-passwords/breached-passwords.port.js";
import { MAILER, type Mailer } from "../adapters/mail/mailer.port.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { describeDevice } from "../identity/device.js";
import { securityChangeEmail } from "../identity/emails.js";
import { PasswordHasher } from "../identity/password-hasher.js";
import { checkPassword } from "../identity/password-policy.js";
import { isAcceptablePin } from "../identity/pin-policy.js";
import { PinService } from "../identity/pin.service.js";
import { recordSecurityEvent, type SecurityEventKind } from "../identity/security-events.js";
import { TrustedDevicesService } from "../identity/trusted-devices.service.js";
import { MfaService } from "./mfa.service.js";
import type { ClientContext } from "./session.service.js";

export type SessionView = Readonly<{
  id: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}>;
export type TrustedDeviceView = Readonly<{
  id: string;
  device: string;
  lastUsedAt: string;
  expiresAt: string;
}>;
export type SecurityEventView = Readonly<{
  kind: SecurityEventKind;
  device: string | null;
  ip: string | null;
  at: string;
}>;

const BAD_PIN = "Choose a PIN that isn't a repeat, a run of digits or a pair.";

/** Shows only the first part of an address: enough to recognise a network, not to trace a person. */
export const maskIp = (ip: string | null): string | null => {
  if (!ip) return null;
  if (ip.includes(".")) return ip.split(".").slice(0, 2).join(".") + ".x.x";
  return ip.split(":").slice(0, 2).join(":") + ":…";
};

/**
 * Looking after the account from Me: the password, the PIN, the devices signed in or remembered, and
 * a record of what happened. Every change asks again who it is (password, and the authenticator code
 * when it is on), is written to the security record in the same transaction, and is emailed.
 */
@Injectable()
export class AccountSecurity {
  private readonly logger = new Logger(AccountSecurity.name);

  constructor(
    private readonly db: DataSource,
    private readonly hasher: PasswordHasher,
    private readonly mfa: MfaService,
    private readonly pins: PinService,
    private readonly trusted: TrustedDevicesService,
    @Inject(BREACHED_PASSWORDS) private readonly breached: BreachedPasswords,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * A new password, from inside the app. Every other device is signed out and no device stays
   * remembered (the old password may have been known to someone); this one stays signed in.
   */
  async changePassword(
    userId: string,
    sessionId: string,
    input: Readonly<{ currentPassword: string; newPassword: string; code?: string }>,
    client: ClientContext,
  ): Promise<void> {
    const [user] = await this.db.query<{ email: string }[]>(
      `SELECT email FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw new NotFoundException();
    // Checked before anything is asked of the person's code, so a weak choice costs nothing.
    const problems = await checkPassword(input.newPassword, user.email, this.breached);
    if (problems.length > 0)
      throw new BadRequestException({
        message: "Password does not meet the requirements",
        details: { password: problems },
      });
    const hash = await this.hasher.hash(input.newPassword);

    const outcome = await this.db.transaction(async (tx) => {
      const check = await this.mfa.stepUp(tx, userId, input.currentPassword, input.code);
      if (check !== "ok") return check;
      await sql(tx, `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [
        userId,
        hash,
      ]);
      await sql(
        tx,
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'password_changed'
          WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [userId, sessionId],
      );
      await this.trusted.forgetAllIn(tx, userId);
      await recordSecurityEvent(tx, userId, "password_changed", client);
      return "ok" as const;
    });
    if (outcome !== "ok") MfaService.refuse(outcome);
    this.notify(userId, "password", "Every other device was signed out.", `password-${Date.now()}`);
  }

  /** A new PIN, with the current one. Wrong current PINs count towards the PIN lockout. */
  async changePin(
    userId: string,
    input: Readonly<{ currentPin: string; newPin: string }>,
    client: ClientContext,
  ): Promise<void> {
    if (!isAcceptablePin(input.newPin)) throw new BadRequestException(BAD_PIN);
    await this.pins.verify(userId, input.currentPin);
    const hash = await this.hasher.hash(input.newPin);
    await this.db.transaction(async (tx) => {
      await sql(
        tx,
        `UPDATE transaction_pins SET pin_hash = $2, failed_attempts = 0, locked_until = NULL, updated_at = now()
          WHERE user_id = $1`,
        [userId, hash],
      );
      await recordSecurityEvent(tx, userId, "pin_changed", client);
    });
    this.notify(userId, "PIN", "Use the new PIN for your next payment.", `pin-${Date.now()}`);
  }

  /**
   * A forgotten PIN: the password and an authenticator code (it must be on) set a new one and clear
   * any PIN lockout. Without the authenticator a stolen password alone could reset it, so it is required.
   */
  async resetPin(
    userId: string,
    input: Readonly<{ password: string; code: string; newPin: string }>,
    client: ClientContext,
  ): Promise<void> {
    if (!isAcceptablePin(input.newPin)) throw new BadRequestException(BAD_PIN);
    const hash = await this.hasher.hash(input.newPin);
    const outcome = await this.db.transaction(async (tx) => {
      const check = await this.mfa.stepUp(tx, userId, input.password, input.code, true);
      if (check !== "ok") return check;
      const rows = await sql<{ user_id: string }>(
        tx,
        `UPDATE transaction_pins SET pin_hash = $2, failed_attempts = 0, locked_until = NULL, updated_at = now()
          WHERE user_id = $1 RETURNING user_id`,
        [userId, hash],
      );
      if (rows.length === 0) return "no_pin" as const;
      await recordSecurityEvent(tx, userId, "pin_reset", client);
      return "ok" as const;
    });
    if (outcome === "no_pin") throw new BadRequestException("You haven't set a PIN yet.");
    if (outcome !== "ok") MfaService.refuse(outcome);
    this.notify(
      userId,
      "PIN",
      "It was reset with your password and authenticator code.",
      `pin-${Date.now()}`,
    );
  }

  /** Devices signed in now, the newest use first; this one is marked. */
  async sessions(userId: string, currentSessionId: string): Promise<SessionView[]> {
    const rows = await this.db.query<
      {
        id: string;
        user_agent: string | null;
        ip: string | null;
        created_at: Date;
        last_seen_at: Date;
      }[]
    >(
      `SELECT id, user_agent, host(ip) AS ip, created_at, last_seen_at FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_seen_at DESC, id`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      device: describeDevice(r.user_agent ?? undefined).label,
      ip: maskIp(r.ip),
      createdAt: r.created_at.toISOString(),
      lastSeenAt: r.last_seen_at.toISOString(),
      current: r.id === currentSessionId,
    }));
  }

  /** Signs one of the person's own devices out. Someone else's session reads as not found. */
  async signOutDevice(userId: string, sessionId: string, client: ClientContext): Promise<void> {
    const done = await this.db.transaction(async (tx) => {
      const rows = await sql<{ id: string }>(
        tx,
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'signed_out_by_user'
          WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
        [sessionId, userId],
      );
      if (rows.length === 0) return false;
      await recordSecurityEvent(tx, userId, "device_signed_out", client);
      return true;
    });
    if (!done)
      throw new NotFoundException({
        message: "That device isn't signed in.",
        code: "session_not_found",
      });
  }

  /** Devices that skip the authenticator code at sign-in. */
  async trustedDevices(userId: string): Promise<TrustedDeviceView[]> {
    const rows = await this.db.query<
      { id: string; label: string; last_used_at: Date; expires_at: Date }[]
    >(
      `SELECT id, label, last_used_at, expires_at FROM trusted_devices
        WHERE user_id = $1 AND expires_at > now() ORDER BY last_used_at DESC, id`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.id,
      device: r.label,
      lastUsedAt: r.last_used_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
    }));
  }

  async forgetDevice(userId: string, id: string, client: ClientContext): Promise<void> {
    const done = await this.db.transaction(async (tx) => {
      const rows = await sql<{ id: string }>(
        tx,
        `DELETE FROM trusted_devices WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, userId],
      );
      if (rows.length === 0) return false;
      await recordSecurityEvent(tx, userId, "device_forgotten", client);
      return true;
    });
    if (!done)
      throw new NotFoundException({
        message: "That device isn't remembered.",
        code: "device_not_found",
      });
  }

  /** The last 50 things that happened to the account, newest first. */
  async events(userId: string): Promise<SecurityEventView[]> {
    const rows = await this.db.query<
      { kind: SecurityEventKind; device: string | null; ip: string | null; created_at: Date }[]
    >(
      `SELECT kind, device, host(ip) AS ip, created_at FROM security_events
        WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
      [userId],
    );
    return rows.map((r) => ({
      kind: r.kind,
      device: r.device,
      ip: maskIp(r.ip),
      at: r.created_at.toISOString(),
    }));
  }

  /** Emailed without waiting: the change is made either way, and a mail outage must not undo it. */
  private notify(userId: string, what: string, detail: string, key: string): void {
    void (async () => {
      const [user] = await this.db.query<{ email: string; display_name: string }[]>(
        `SELECT email, display_name FROM users WHERE id = $1`,
        [userId],
      );
      if (!user) return;
      await this.mailer.send({
        to: user.email,
        idempotencyKey: `security-${userId}-${key}`,
        ...securityChangeEmail({
          name: user.display_name,
          what,
          detail,
          link: `${this.env.WEB_APP_URL}/me/security`,
        }),
      });
    })().catch((error: unknown) => {
      this.logger.error({ err: error }, "Could not send a security email");
    });
  }
}
