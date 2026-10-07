import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { KycService } from "../kyc/kyc.service.js";
import { AdminAudit, type AuditActor } from "./admin-audit.service.js";

const LIKE_SPECIAL = /[\\%_]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string) => UUID.test(value);

export type PersonSummary = {
  id: string;
  email: string;
  displayName: string;
  username: string | null;
  country: string | null;
  status: string;
  createdAt: Date;
};

/** Looking people up, and suspending or reinstating them. Every look is recorded, because it is a look at personal details. */
@Injectable()
export class AdminPeople {
  constructor(
    private readonly db: DataSource,
    private readonly audit: AdminAudit,
    private readonly kyc: KycService,
  ) {}

  async search(by: AuditActor, q: string): Promise<PersonSummary[]> {
    const byEmail = q.includes("@");
    const rows = await this.db.query<
      {
        id: string;
        email: string;
        display_name: string;
        username: string | null;
        country: string | null;
        status: string;
        created_at: Date;
      }[]
    >(
      byEmail
        ? `SELECT id, email, display_name, username::text AS username, country, status, created_at
             FROM users WHERE email = $1 LIMIT 1`
        : `SELECT id, email, display_name, username::text AS username, country, status, created_at
             FROM users WHERE username::text LIKE $1 ESCAPE '\\' ORDER BY username LIMIT 20`,
      [byEmail ? q : `${q.replace(LIKE_SPECIAL, "\\$&")}%`],
    );
    await this.audit.record(by, "user.search", "ok", undefined, { q, found: rows.length });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      username: r.username,
      country: r.country,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  /** One person as staff need to see them: standing, identity, money held, what is going on, recent security events. */
  async detail(by: AuditActor, id: string) {
    const [user] = await this.db.query<
      {
        id: string;
        email: string;
        display_name: string;
        username: string | null;
        country: string | null;
        goal: string | null;
        status: string;
        status_note: string | null;
        email_verified: boolean;
        phone: string | null;
        phone_verified: boolean;
        kyc_override: string | null;
        created_at: Date;
        closed_at: Date | null;
      }[]
    >(
      `SELECT id, email, display_name, username::text AS username, country, goal, status, status_note,
              email_verified, phone, phone_verified_at IS NOT NULL AS phone_verified, kyc_override,
              created_at, closed_at
         FROM users WHERE id = $1`,
      [id],
    );
    if (!user)
      throw new NotFoundException({ message: "No such person.", code: "person_not_found" });
    const [balances, counts, events, kyc] = await Promise.all([
      this.db.query<{ currency: string; kind: string; balance: string }[]>(
        `SELECT a.currency, a.kind,
                coalesce(sum(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END), 0)::text AS balance
           FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
          WHERE a.owner_type = 'user' AND a.owner_id = $1 AND a.kind IN ('available', 'locked', 'savings')
          GROUP BY a.currency, a.kind ORDER BY a.currency, a.kind`,
        [id],
      ),
      this.db.query<{ plans: string; circles: string; cases: string; sessions: string }[]>(
        `SELECT (SELECT count(*) FROM savings_plans WHERE user_id = $1 AND status IN ('active', 'paused'))::text AS plans,
                (SELECT count(*) FROM group_members m JOIN groups g ON g.id = m.group_id
                  WHERE m.user_id = $1 AND m.status = 'active' AND g.status IN ('open', 'picking', 'running'))::text AS circles,
                (SELECT count(*) FROM recovery_cases WHERE member_id = $1 AND status = 'open')::text AS cases,
                (SELECT count(*) FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now())::text AS sessions`,
        [id],
      ),
      this.db.query<{ kind: string; created_at: Date }[]>(
        `SELECT kind, created_at FROM security_events WHERE user_id = $1 ORDER BY id DESC LIMIT 10`,
        [id],
      ),
      this.kyc.summaryFor(id),
    ]);
    await this.audit.record(by, "user.view", "ok", { type: "user", id });
    const c = counts[0]!;
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.email_verified,
      displayName: user.display_name,
      username: user.username,
      country: user.country,
      goal: user.goal,
      phone: user.phone,
      phoneVerified: user.phone_verified,
      status: user.status,
      statusNote: user.status_note,
      createdAt: user.created_at,
      closedAt: user.closed_at,
      kyc: { status: kyc.status, tier: kyc.tier, via: kyc.via, override: user.kyc_override },
      balances: balances.map((b) => ({ currency: b.currency, kind: b.kind, amount: b.balance })),
      activePlans: Number(c.plans),
      activeCircles: Number(c.circles),
      openCases: Number(c.cases),
      activeSessions: Number(c.sessions),
      recentSecurity: events.map((e) => ({ kind: e.kind, at: e.created_at })),
    };
  }

  /**
   * Stops a person signing in, now: their status changes and every session ends. Their money is not
   * touched, and nothing is told to them. Only an active account can be suspended.
   */
  async suspend(by: AuditActor, id: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await sql<{ status: string }>(
        tx,
        `SELECT status FROM users WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row)
        throw new NotFoundException({ message: "No such person.", code: "person_not_found" });
      if (row.status !== "active") {
        throw new ConflictException({
          message: `This account is ${row.status}, so it can't be suspended.`,
          code: "not_active",
        });
      }
      await sql(
        tx,
        `UPDATE users SET status = 'suspended', status_note = $2, updated_at = now() WHERE id = $1`,
        [id, reason],
      );
      await sql(
        tx,
        `UPDATE sessions SET revoked_at = now(), revoked_reason = 'admin' WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );
      await this.audit.record(by, "user.suspend", "ok", { type: "user", id }, { reason }, tx);
    });
  }

  /** Lets a suspended person sign in again. An account the person closed, or that is locked, is not reinstated here. */
  async reinstate(by: AuditActor, id: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await sql<{ status: string }>(
        tx,
        `SELECT status FROM users WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row)
        throw new NotFoundException({ message: "No such person.", code: "person_not_found" });
      if (row.status !== "suspended") {
        throw new ConflictException({
          message: `This account is ${row.status}, so it can't be reinstated.`,
          code: "not_suspended",
        });
      }
      await sql(
        tx,
        `UPDATE users SET status = 'active', status_note = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      await this.audit.record(by, "user.reinstate", "ok", { type: "user", id }, { reason }, tx);
    });
  }

  async overview() {
    const [row] = await this.db.query<
      {
        users: string;
        active: string;
        suspended: string;
        pending_kyc: string;
        open_cases: string;
        admins: string;
      }[]
    >(
      `SELECT (SELECT count(*) FROM users)::text AS users,
              (SELECT count(*) FROM users WHERE status = 'active')::text AS active,
              (SELECT count(*) FROM users WHERE status = 'suspended')::text AS suspended,
              (SELECT count(DISTINCT user_id) FROM kyc_steps WHERE status = 'pending')::text AS pending_kyc,
              (SELECT count(*) FROM recovery_cases WHERE status = 'open')::text AS open_cases,
              (SELECT count(*) FROM admin_users WHERE status = 'active')::text AS admins`,
    );
    const r = row!;
    return {
      users: Number(r.users),
      activeUsers: Number(r.active),
      suspendedUsers: Number(r.suspended),
      pendingKyc: Number(r.pending_kyc),
      openCases: Number(r.open_cases),
      admins: Number(r.admins),
    };
  }
}
