import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { PasswordHasher } from "../identity/password-hasher.js";
import { createOneTimeToken, hashToken } from "../identity/tokens.js";
import { AccessTokens } from "./access-tokens.js";

export const MAX_FAILED_LOGINS = 10;
export const LOCKOUT_MINUTES = 15;
export const SESSION_MAX_DAYS = 30;
export const REFRESH_IDLE_DAYS = 7;
export const BAD_CREDENTIALS = "Email or password is incorrect.";
const SESSION_ENDED = "Your session has ended. Please sign in again.";

export type TokenPair = Readonly<{
  tokenType: "Bearer";
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}>;

export type ClientContext = Readonly<{ ip?: string; userAgent?: string }>;

type UserRow = {
  id: string;
  password_hash: string;
  email_verified_at: Date | null;
  status: string;
  failed_login_count: number;
  locked: boolean;
};

@Injectable()
export class SessionService {
  constructor(
    private readonly db: DataSource,
    private readonly hasher: PasswordHasher,
    @Inject(AccessTokens) private readonly accessTokens: AccessTokens,
  ) {}

  async login(email: string, password: string, client: ClientContext): Promise<TokenPair> {
    // Committed outcome first, then any error, so failure counters are never rolled back.
    const outcome = await this.db.transaction(async (tx) => {
      // Row lock serialises concurrent guesses against one account.
      const [user] = await sql<UserRow>(
        tx,
        `SELECT id, password_hash, email_verified_at, status, failed_login_count,
                coalesce(locked_until > now(), false) AS locked
           FROM users WHERE email = $1 FOR UPDATE`,
        [email],
      );
      if (!user || user.locked || user.status !== "active") {
        await this.hasher.verifyDummy(password);
        return { kind: "bad_credentials" } as const;
      }
      if (!(await this.hasher.verify(user.password_hash, password))) {
        const failures = user.failed_login_count + 1;
        const lock = failures >= MAX_FAILED_LOGINS;
        await sql(
          tx,
          `UPDATE users
              SET failed_login_count = $2,
                  locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
            WHERE id = $1`,
          [user.id, lock ? 0 : failures, lock, LOCKOUT_MINUTES],
        );
        return { kind: "bad_credentials" } as const;
      }
      await sql(tx, `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [
        user.id,
      ]);
      if (!user.email_verified_at) return { kind: "unverified" } as const;

      const [session] = await sql<{ id: string }>(
        tx,
        `INSERT INTO sessions (user_id, expires_at, ip, user_agent)
         VALUES ($1, now() + make_interval(days => $2), $3, left($4, 512))
         RETURNING id`,
        [user.id, SESSION_MAX_DAYS, client.ip ?? null, client.userAgent ?? null],
      );
      const refreshToken = await this.issueRefreshToken(tx, session!.id);
      return { kind: "ok", userId: user.id, sessionId: session!.id, refreshToken } as const;
    });

    if (outcome.kind === "bad_credentials") throw new UnauthorizedException(BAD_CREDENTIALS);
    if (outcome.kind === "unverified") {
      throw new ForbiddenException("Verify your email before signing in.");
    }
    return this.tokenPair(outcome.userId, outcome.sessionId, outcome.refreshToken);
  }

  /**
   * Rotates a refresh token. Presenting a token that was already used means it was copied:
   * the whole session is revoked, so neither the thief nor the victim can continue with it.
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const outcome = await this.db.transaction(async (tx) => {
      const [row] = await sql<{
        id: string;
        session_id: string;
        user_id: string;
        used: boolean;
        valid: boolean;
      }>(
        tx,
        `SELECT rt.id, rt.session_id, s.user_id, rt.used_at IS NOT NULL AS used,
                (rt.expires_at > now() AND s.revoked_at IS NULL AND s.expires_at > now()) AS valid
           FROM refresh_tokens rt
           JOIN sessions s ON s.id = rt.session_id
          WHERE rt.token_hash = $1
          FOR UPDATE OF rt, s`,
        [hashToken(refreshToken)],
      );
      if (!row) return { kind: "invalid" } as const;
      if (row.used) {
        await sql(
          tx,
          `UPDATE sessions SET revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, 'refresh_reuse')
            WHERE id = $1`,
          [row.session_id],
        );
        return { kind: "invalid" } as const;
      }
      if (!row.valid) return { kind: "invalid" } as const;

      await sql(tx, `UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [row.id]);
      await sql(tx, `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [row.session_id]);
      const next = await this.issueRefreshToken(tx, row.session_id);
      return {
        kind: "ok",
        userId: row.user_id,
        sessionId: row.session_id,
        refreshToken: next,
      } as const;
    });

    if (outcome.kind === "invalid") throw new UnauthorizedException(SESSION_ENDED);
    return this.tokenPair(outcome.userId, outcome.sessionId, outcome.refreshToken);
  }

  async isActive(sessionId: string, userId: string): Promise<boolean> {
    const rows: unknown[] = await this.db.query(
      `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.status = 'active'`,
      [sessionId, userId],
    );
    return rows.length > 0;
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
  }

  async logoutAll(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout_all'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }

  private async issueRefreshToken(
    tx: Parameters<typeof sql>[0],
    sessionId: string,
  ): Promise<string> {
    const { token, hash } = createOneTimeToken();
    await sql(
      tx,
      `INSERT INTO refresh_tokens (session_id, token_hash, expires_at)
       SELECT $1, $2, least(now() + make_interval(days => $3), s.expires_at)
         FROM sessions s WHERE s.id = $1`,
      [sessionId, hash, REFRESH_IDLE_DAYS],
    );
    return token;
  }

  private async tokenPair(
    userId: string,
    sessionId: string,
    refreshToken: string,
  ): Promise<TokenPair> {
    const access = await this.accessTokens.issue({ userId, sessionId });
    return {
      tokenType: "Bearer",
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken,
    };
  }
}
