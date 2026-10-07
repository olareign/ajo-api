import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";

type Tx = Parameters<typeof sql>[0];

/** Who did it, as the audit log records them (copied, so it still reads right after a rename). */
export type AuditActor = Readonly<{
  id: string | null;
  email: string;
  role: string;
  ip: string | undefined;
}>;
export type AuditTarget = Readonly<{ type: string; id: string }>;
export type AuditOutcome = "ok" | "denied" | "failed";

export type AuditRow = {
  id: string;
  at: Date;
  admin_email: string;
  role: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown>;
  outcome: AuditOutcome;
};

/**
 * Everything staff do goes here: reads of a person's details as well as changes, refusals as well as
 * successes. The table cannot be edited or emptied (the database refuses), so the record is
 * trustworthy. Keep `detail` to what a reviewer needs; never a password, a code or a secret.
 */
@Injectable()
export class AdminAudit {
  constructor(private readonly db: DataSource) {}

  async record(
    actor: AuditActor,
    action: string,
    outcome: AuditOutcome,
    target?: AuditTarget,
    detail: Record<string, unknown> = {},
    within?: Tx,
  ): Promise<void> {
    const text = `INSERT INTO admin_audit (admin_id, admin_email, role, action, target_type, target_id, detail, ip, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::inet, $9)`;
    const params = [
      actor.id,
      actor.email.slice(0, 254),
      actor.role,
      action,
      target?.type ?? null,
      target?.id ?? null,
      JSON.stringify(detail),
      actor.ip ?? null,
      outcome,
    ];
    if (within) await sql(within, text, params);
    else await this.db.query(text, params);
  }

  /** Newest first, a page at a time, narrowed by who, what or which target. */
  async list(filter: {
    admin?: string;
    action?: string;
    target?: string;
    before?: string;
    limit: number;
  }): Promise<{ items: AuditRow[]; next: string | null }> {
    const rows = await this.db.query<AuditRow[]>(
      `SELECT id::text, at, admin_email, role, action, target_type, target_id, detail, outcome
         FROM admin_audit
        WHERE ($1::text IS NULL OR admin_email = $1::text)
          AND ($2::text IS NULL OR action LIKE $2::text || '%')
          AND ($3::text IS NULL OR target_id = $3::text)
          AND ($4::bigint IS NULL OR id < $4::bigint)
        ORDER BY id DESC LIMIT $5`,
      [
        filter.admin ?? null,
        filter.action ?? null,
        filter.target ?? null,
        filter.before ?? null,
        filter.limit + 1,
      ],
    );
    const items = rows.slice(0, filter.limit);
    return { items, next: rows.length > filter.limit ? items[items.length - 1]!.id : null };
  }
}
