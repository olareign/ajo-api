import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { DataSource } from "typeorm";
import {
  BREACHED_PASSWORDS,
  type BreachedPasswords,
} from "../adapters/breached-passwords/breached-passwords.port.js";
import { Totp } from "../auth/totp.js";
import { FieldEncryption } from "../crypto/field-encryption.js";
import { sql } from "../database/sql.js";
import { describeDevice } from "../identity/device.js";
import { PasswordHasher } from "../identity/password-hasher.js";
import { checkPassword } from "../identity/password-policy.js";
import { createOneTimeToken, hashToken } from "../identity/tokens.js";
import { AdminAudit, type AuditActor } from "./admin-audit.service.js";
import type { AdminPrincipal } from "./admin-principal.js";
import type { AdminRole } from "./admin-roles.js";

type Tx = Parameters<typeof sql>[0];

/** Staff sign in with a password and a code every time, and are locked out briefly after a few misses. */
export const MAX_FAILED = 5;
export const LOCK_MINUTES = 15;
/** A session ends after this long without a request, or this long in all, whichever comes first. */
export const IDLE_MINUTES = 30;
export const SESSION_HOURS = 8;
const MAX_SESSIONS = 3;
/** How long a new member has to use their one-time setup code. */
export const SETUP_HOURS = 24;
/** Wrong setup codes tolerated before the code is cancelled and has to be issued again. */
const MAX_SETUP_MISSES = 10;
export const ADMIN_PASSWORD_MIN = 14;

/** One answer for every way a sign-in can fail, so it never says which part was wrong. */
const SIGN_IN_FAILED =
  "Those details didn't work. After a few tries the account is locked for a while.";
const SETUP_FAILED = "That setup code didn't work, or it has expired. Ask the owner for a new one.";
const CODE_WRONG = "That code is incorrect.";

type AdminRow = {
  id: string;
  email: string;
  display_name: string;
  role: AdminRole;
  status: "invited" | "active" | "disabled";
  password_hash: string | null;
  totp_secret: string | null;
  totp_confirmed_at: Date | null;
  totp_last_step: string | null;
  setup_token_hash: string | null;
  setup_expires_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
};

export type Client = Readonly<{ ip: string | undefined; userAgent: string | undefined }>;
const context = (id: string) => `admin:${id}`;
const SETUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A code to read out or paste, like K7M2Q-9HRX4-BT3EA-WZ6PD: 100 bits, no look-alike characters. */
export function makeSetupCode(): string {
  const bytes = randomBytes(20);
  const chars = Array.from(bytes, (b) => SETUP_ALPHABET[b % SETUP_ALPHABET.length]!);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}
const normaliseSetupCode = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();
export const hashSetupCode = (code: string) =>
  createHash("sha256").update(normaliseSetupCode(code), "utf8").digest("hex");

@Injectable()
export class AdminAuth {
  constructor(
    private readonly db: DataSource,
    private readonly hasher: PasswordHasher,
    private readonly audit: AdminAudit,
    @Inject(FieldEncryption) private readonly encryption: FieldEncryption,
    @Inject(Totp) private readonly totp: Totp,
    @Inject(BREACHED_PASSWORDS) private readonly breached: BreachedPasswords,
  ) {}

  // ---- joining ------------------------------------------------------------------------------------

  /** Adds a member (or starts again for one who is locked out): a one-time code, shown once, for the person. */
  async invite(
    by: AuditActor,
    input: { email: string; name: string; role: AdminRole },
  ): Promise<{ id: string; setupCode: string; expiresAt: Date }> {
    const code = makeSetupCode();
    const row = await this.db.transaction(async (tx) => {
      const [existing] = await sql<{ id: string }>(
        tx,
        `SELECT id FROM admin_users WHERE email = $1 FOR UPDATE`,
        [input.email],
      );
      if (existing)
        throw new ConflictException({
          message: "That person is already on the team.",
          code: "admin_exists",
        });
      const [created] = await sql<{ id: string; setup_expires_at: Date }>(
        tx,
        `INSERT INTO admin_users (email, display_name, role, setup_token_hash, setup_expires_at, created_by)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5::int), $6)
         RETURNING id, setup_expires_at`,
        [input.email, input.name, input.role, hashSetupCode(code), SETUP_HOURS, by.id],
      );
      await this.audit.record(
        by,
        "team.invite",
        "ok",
        { type: "admin", id: created!.id },
        { email: input.email, role: input.role },
        tx,
      );
      return created!;
    });
    return { id: row.id, setupCode: code, expiresAt: row.setup_expires_at };
  }

  /** A new code for someone who lost their authenticator or password: their password and app are wiped, and they start again. */
  async reissue(by: AuditActor, adminId: string): Promise<{ setupCode: string; expiresAt: Date }> {
    if (by.id === adminId) {
      throw new ConflictException({
        message: "Ask another owner to reset you.",
        code: "admin_self",
      });
    }
    const code = makeSetupCode();
    const row = await this.db.transaction(async (tx) => {
      const [admin] = await sql<{ email: string }>(
        tx,
        `UPDATE admin_users
            SET status = 'invited', password_hash = NULL, totp_secret = NULL, totp_confirmed_at = NULL,
                totp_last_step = NULL, failed_login_count = 0, locked_until = NULL,
                setup_token_hash = $2, setup_expires_at = now() + make_interval(hours => $3::int)
          WHERE id = $1 RETURNING email`,
        [adminId, hashSetupCode(code), SETUP_HOURS],
      );
      if (!admin) throw new NotFoundException();
      await sql(
        tx,
        `UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL`,
        [adminId],
      );
      await this.audit.record(
        by,
        "team.reissue",
        "ok",
        { type: "admin", id: adminId },
        { email: admin.email },
        tx,
      );
      const [expires] = await sql<{ setup_expires_at: Date }>(
        tx,
        `SELECT setup_expires_at FROM admin_users WHERE id = $1`,
        [adminId],
      );
      return expires!;
    });
    return { setupCode: code, expiresAt: row.setup_expires_at };
  }

  async disable(by: AuditActor, adminId: string): Promise<void> {
    if (by.id === adminId) {
      throw new ConflictException({
        message: "You can't turn off your own access.",
        code: "admin_self",
      });
    }
    await this.db.transaction(async (tx) => {
      // Lock every active owner first, in one fixed order: two owners turning each other off at the same
      // moment then wait in turn, and the second finds only itself left.
      await sql(
        tx,
        `SELECT id FROM admin_users WHERE role = 'owner' AND status = 'active' ORDER BY id FOR UPDATE`,
      );
      const [target] = await sql<{ role: AdminRole; status: string }>(
        tx,
        `SELECT role, status FROM admin_users WHERE id = $1 FOR UPDATE`,
        [adminId],
      );
      if (!target) throw new NotFoundException();
      if (target.role === "owner" && target.status === "active") {
        // Always keep an owner: with none, nobody could add or reset anyone.
        const [others] = await sql<{ n: string }>(
          tx,
          `SELECT count(*)::text AS n FROM admin_users WHERE role = 'owner' AND status = 'active' AND id <> $1`,
          [adminId],
        );
        if (Number(others!.n) === 0) {
          throw new ConflictException({
            message: "Keep at least one active owner.",
            code: "admin_last_owner",
          });
        }
      }
      const [admin] = await sql<{ email: string }>(
        tx,
        `UPDATE admin_users SET status = 'disabled', setup_token_hash = NULL WHERE id = $1 RETURNING email`,
        [adminId],
      );
      await sql(
        tx,
        `UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL`,
        [adminId],
      );
      await this.audit.record(
        by,
        "team.disable",
        "ok",
        { type: "admin", id: adminId },
        { email: admin?.email },
        tx,
      );
    });
  }

  /** The setup code is checked for this email, and wrong ones are counted: ten and it is cancelled. */
  private async withSetup<T>(
    email: string,
    code: string,
    run: (tx: Tx, admin: AdminRow) => Promise<T>,
  ): Promise<T> {
    const outcome = await this.db.transaction(async (tx) => {
      const [admin] = await sql<AdminRow>(
        tx,
        `SELECT * FROM admin_users WHERE email = $1 FOR UPDATE`,
        [email],
      );
      if (
        !admin ||
        admin.status !== "invited" ||
        !admin.setup_token_hash ||
        !admin.setup_expires_at
      ) {
        await this.hasher.verifyDummy(code);
        return "refused" as const;
      }
      if (
        admin.setup_expires_at.getTime() < Date.now() ||
        admin.setup_token_hash !== hashSetupCode(code)
      ) {
        const misses = admin.failed_login_count + 1;
        await sql(
          tx,
          `UPDATE admin_users SET failed_login_count = $2::int,
                  setup_token_hash = CASE WHEN $2::int >= $3::int THEN NULL ELSE setup_token_hash END
            WHERE id = $1`,
          [admin.id, misses, MAX_SETUP_MISSES],
        );
        return "refused" as const;
      }
      return { value: await run(tx, admin) };
    });
    if (outcome === "refused")
      throw new UnauthorizedException({ message: SETUP_FAILED, code: "admin_setup_refused" });
    return outcome.value;
  }

  /** Step 1 of joining: the setup code and a password; answers with the key for the authenticator app. */
  async startSetup(input: {
    email: string;
    setupCode: string;
    password: string;
  }): Promise<{ secret: string; otpauthUri: string }> {
    return this.withSetup(input.email, input.setupCode, async (tx, admin) => {
      const problems = await checkPassword(input.password, admin.email, this.breached);
      if (problems.length > 0 || input.password.length < ADMIN_PASSWORD_MIN) {
        throw new BadRequestException({
          message: `Use a password of at least ${ADMIN_PASSWORD_MIN} characters that isn't in a known breach and doesn't contain your email.`,
          code: "admin_password_weak",
        });
      }
      const { secret, uri } = this.totp.createSecret(admin.email);
      await sql(
        tx,
        `UPDATE admin_users SET password_hash = $2, totp_secret = $3, totp_confirmed_at = NULL, totp_last_step = NULL WHERE id = $1`,
        [
          admin.id,
          await this.hasher.hash(input.password),
          this.encryption.encrypt(secret, context(admin.id)),
        ],
      );
      return { secret, otpauthUri: uri };
    });
  }

  /** Step 2: a code from the app proves it works; the member is active and signed in. */
  async confirmSetup(
    input: { email: string; setupCode: string; code: string },
    client: Client,
  ): Promise<Session> {
    return this.withSetup(input.email, input.setupCode, async (tx, admin) => {
      if (!admin.password_hash || !admin.totp_secret) {
        throw new BadRequestException({
          message: "Choose your password first.",
          code: "admin_setup_incomplete",
        });
      }
      const check = this.totp.verify(
        this.encryption.decrypt(admin.totp_secret, context(admin.id)),
        input.code,
        null,
      );
      if (!check.ok)
        throw new UnauthorizedException({ message: CODE_WRONG, code: "admin_code_wrong" });
      await sql(
        tx,
        `UPDATE admin_users SET status = 'active', totp_confirmed_at = now(), totp_last_step = $2,
                setup_token_hash = NULL, setup_expires_at = NULL, failed_login_count = 0, last_login_at = now()
          WHERE id = $1`,
        [admin.id, check.step],
      );
      const session = await this.openSession(tx, admin, client);
      await this.audit.record(
        { id: admin.id, email: admin.email, role: admin.role, ip: client.ip },
        "team.joined",
        "ok",
        { type: "admin", id: admin.id },
        {},
        tx,
      );
      return session;
    });
  }

  // ---- signing in ---------------------------------------------------------------------------------

  async login(
    input: { email: string; password: string; code: string },
    client: Client,
  ): Promise<Session> {
    const result = await this.db.transaction(async (tx) => {
      const [admin] = await sql<AdminRow>(
        tx,
        `SELECT * FROM admin_users WHERE email = $1 FOR UPDATE`,
        [input.email],
      );
      const actor = (a?: AdminRow): AuditActor => ({
        id: a?.id ?? null,
        email: input.email,
        role: a?.role ?? "unknown",
        ip: client.ip,
      });
      if (!admin || admin.status !== "active" || !admin.password_hash || !admin.totp_secret) {
        await this.hasher.verifyDummy(input.password);
        await this.audit.record(
          actor(admin),
          "login",
          "failed",
          undefined,
          { why: "no such active member" },
          tx,
        );
        return "failed" as const;
      }
      if (admin.locked_until && admin.locked_until.getTime() > Date.now()) {
        await this.audit.record(actor(admin), "login", "denied", undefined, { why: "locked" }, tx);
        return "failed" as const;
      }
      const passwordOk = await this.hasher.verify(admin.password_hash, input.password);
      const last = admin.totp_last_step === null ? null : Number(admin.totp_last_step);
      const check = this.totp.verify(
        this.encryption.decrypt(admin.totp_secret, context(admin.id)),
        input.code,
        last,
      );
      if (!passwordOk || !check.ok) {
        const locked = await this.countMiss(tx, admin);
        await this.audit.record(
          actor(admin),
          "login",
          "failed",
          undefined,
          { why: passwordOk ? "wrong code" : "wrong password", locked },
          tx,
        );
        return "failed" as const;
      }
      await sql(
        tx,
        `UPDATE admin_users SET failed_login_count = 0, locked_until = NULL, totp_last_step = $2, last_login_at = now() WHERE id = $1`,
        [admin.id, check.step],
      );
      const session = await this.openSession(tx, admin, client);
      await this.audit.record(actor(admin), "login", "ok", undefined, {}, tx);
      return session;
    });
    if (result === "failed")
      throw new UnauthorizedException({ message: SIGN_IN_FAILED, code: "admin_sign_in_failed" });
    return result;
  }

  /** Counts a wrong answer; at the limit the account is locked for a while. Returns whether it now is. */
  private async countMiss(tx: Tx, admin: Pick<AdminRow, "id">): Promise<boolean> {
    const [row] = await sql<{ locked: boolean }>(
      tx,
      `UPDATE admin_users
          SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2::int THEN 0 ELSE failed_login_count + 1 END,
              locked_until = CASE WHEN failed_login_count + 1 >= $2::int
                                  THEN now() + make_interval(mins => $3::int) ELSE locked_until END
        WHERE id = $1 RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`,
      [admin.id, MAX_FAILED, LOCK_MINUTES],
    );
    return row?.locked ?? false;
  }

  /**
   * A fresh code before a sensitive action, on top of being signed in. Counted like a sign-in miss, and
   * a code is only ever good once, so one that was just used to sign in is refused until the next.
   */
  async stepUp(adminId: string, code: string | undefined): Promise<void> {
    const ok = await this.db.transaction(async (tx) => {
      const [admin] = await sql<AdminRow>(
        tx,
        `SELECT * FROM admin_users WHERE id = $1 FOR UPDATE`,
        [adminId],
      );
      if (!admin || admin.status !== "active" || !admin.totp_secret) return false;
      if (admin.locked_until && admin.locked_until.getTime() > Date.now()) return false;
      const last = admin.totp_last_step === null ? null : Number(admin.totp_last_step);
      const check = code
        ? this.totp.verify(
            this.encryption.decrypt(admin.totp_secret, context(admin.id)),
            code,
            last,
          )
        : ({ ok: false } as const);
      if (!check.ok) {
        await this.countMiss(tx, admin);
        return false;
      }
      await sql(
        tx,
        `UPDATE admin_users SET totp_last_step = $2, failed_login_count = 0 WHERE id = $1`,
        [admin.id, check.step],
      );
      return true;
    });
    if (!ok) {
      throw new UnauthorizedException({
        message: "Enter a fresh code from your authenticator app to do this.",
        code: "admin_code_required",
      });
    }
  }

  // ---- sessions -----------------------------------------------------------------------------------

  private async openSession(
    tx: Tx,
    admin: Pick<AdminRow, "id" | "email" | "display_name" | "role">,
    client: Client,
  ): Promise<Session> {
    const { token, hash } = createOneTimeToken();
    await sql(
      tx,
      `UPDATE admin_sessions SET revoked_at = now()
        WHERE admin_id = $1 AND revoked_at IS NULL AND id NOT IN (
          SELECT id FROM admin_sessions WHERE admin_id = $1 AND revoked_at IS NULL
           ORDER BY created_at DESC LIMIT $2)`,
      [admin.id, MAX_SESSIONS - 1],
    );
    const [row] = await sql<{ expires_at: Date }>(
      tx,
      `INSERT INTO admin_sessions (admin_id, token_hash, ip, device, expires_at)
       VALUES ($1, $2, $3::inet, $4, now() + make_interval(hours => $5::int)) RETURNING expires_at`,
      [admin.id, hash, client.ip ?? null, describeDevice(client.userAgent).label, SESSION_HOURS],
    );
    return {
      token,
      expiresAt: row!.expires_at,
      admin: { id: admin.id, email: admin.email, name: admin.display_name, role: admin.role },
    };
  }

  /** The member behind a session token, or null when it is unknown, ended, idle too long or the member is disabled. */
  async authenticate(token: string, client: Client): Promise<AdminPrincipal | null> {
    if (token.length < 20 || token.length > 200) return null;
    const [row] = await this.db.query<
      {
        id: string;
        admin_id: string;
        email: string;
        display_name: string;
        role: AdminRole;
        device: string;
      }[]
    >(
      `SELECT s.id, s.admin_id, a.email, a.display_name, a.role, coalesce(s.device, '') AS device
         FROM admin_sessions s JOIN admin_users a ON a.id = s.admin_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND s.last_seen_at > now() - make_interval(mins => $2::int) AND a.status = 'active'`,
      [hashToken(token), IDLE_MINUTES],
    );
    if (!row) return null;
    await this.db.query(
      `UPDATE admin_sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '30 seconds'`,
      [row.id],
    );
    return {
      id: row.admin_id,
      email: row.email,
      name: row.display_name,
      role: row.role,
      sessionId: row.id,
      ip: client.ip,
      device: row.device,
    };
  }

  async logout(admin: AdminPrincipal): Promise<void> {
    await this.db.query(`UPDATE admin_sessions SET revoked_at = now() WHERE id = $1`, [
      admin.sessionId,
    ]);
    await this.audit.record(admin, "logout", "ok");
  }

  async team(): Promise<
    {
      id: string;
      email: string;
      name: string;
      role: AdminRole;
      status: string;
      lastLoginAt: Date | null;
      createdAt: Date;
    }[]
  > {
    const rows = await this.db.query<
      {
        id: string;
        email: string;
        display_name: string;
        role: AdminRole;
        status: string;
        last_login_at: Date | null;
        created_at: Date;
      }[]
    >(
      `SELECT id, email, display_name, role, status, last_login_at, created_at FROM admin_users ORDER BY created_at`,
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.display_name,
      role: r.role,
      status: r.status,
      lastLoginAt: r.last_login_at,
      createdAt: r.created_at,
    }));
  }
}

export type Session = Readonly<{
  token: string;
  expiresAt: Date;
  admin: Readonly<{ id: string; email: string; name: string; role: AdminRole }>;
}>;
