import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { KycService } from "../kyc/kyc.service.js";
import { AdminAudit, type AuditActor } from "./admin-audit.service.js";

type CaseRow = {
  id: string;
  status: string;
  round_no: number;
  amount_owed: string;
  covered_by_deposit: string;
  created_at: Date;
  resolved_at: Date | null;
  group_id: string;
  group_name: string;
  currency: string;
  member_id: string;
  member_name: string;
  member_email: string;
};

const SELECT = `SELECT c.id, c.status, c.round_no, c.amount_owed::text, c.covered_by_deposit::text, c.created_at, c.resolved_at,
                       g.id AS group_id, g.name AS group_name, g.currency,
                       u.id AS member_id, u.display_name AS member_name, u.email AS member_email
                  FROM recovery_cases c JOIN groups g ON g.id = c.group_id JOIN users u ON u.id = c.member_id`;

const shape = (r: CaseRow) => ({
  id: r.id,
  status: r.status,
  round: r.round_no,
  currency: r.currency,
  amountOwed: r.amount_owed,
  coveredByDeposit: r.covered_by_deposit,
  stillOwed: (BigInt(r.amount_owed) - BigInt(r.covered_by_deposit)).toString(),
  openedAt: r.created_at,
  resolvedAt: r.resolved_at,
  group: { id: r.group_id, name: r.group_name },
  member: { id: r.member_id, name: r.member_name, email: r.member_email },
});

/**
 * Recovery cases from missed circle payments: read them, keep notes, record how each ended. Recording
 * an outcome moves no money; it only says what happened, in the person's own file and the audit log.
 */
@Injectable()
export class AdminCases {
  constructor(
    private readonly db: DataSource,
    private readonly audit: AdminAudit,
    private readonly kyc: KycService,
  ) {}

  async list(by: AuditActor, status: "open" | "resolved" | "written_off") {
    const rows = await this.db.query<CaseRow[]>(
      `${SELECT} WHERE c.status = $1 ORDER BY c.created_at DESC LIMIT 100`,
      [status],
    );
    await this.audit.record(by, "case.list", "ok", undefined, { status, count: rows.length });
    return rows.map(shape);
  }

  async detail(by: AuditActor, id: string) {
    const [row] = await this.db.query<CaseRow[]>(`${SELECT} WHERE c.id = $1`, [id]);
    if (!row) throw new NotFoundException({ message: "No such case.", code: "case_not_found" });
    const [notes, member, kyc] = await Promise.all([
      this.db.query<{ id: string; note: string; created_at: Date; admin: string }[]>(
        `SELECT n.id::text, n.note, n.created_at, a.display_name AS admin
           FROM recovery_case_notes n JOIN admin_users a ON a.id = n.admin_id WHERE n.case_id = $1 ORDER BY n.id`,
        [id],
      ),
      this.db.query<
        { username: string | null; country: string | null; phone: string | null; status: string }[]
      >(`SELECT username::text AS username, country, phone, status FROM users WHERE id = $1`, [
        row.member_id,
      ]),
      this.kyc.summaryFor(row.member_id),
    ]);
    await this.audit.record(by, "case.view", "ok", { type: "case", id });
    return {
      ...shape(row),
      memberDetails: {
        username: member[0]?.username ?? null,
        country: member[0]?.country ?? null,
        phone: member[0]?.phone ?? null,
        accountStatus: member[0]?.status ?? "unknown",
        kycStatus: kyc.status,
        kycTier: kyc.tier,
        kycVia: kyc.via,
      },
      notes: notes.map((n) => ({ id: n.id, note: n.note, at: n.created_at, by: n.admin })),
    };
  }

  async addNote(by: AuditActor & { id: string }, id: string, note: string) {
    await this.db.transaction(async (tx) => {
      const [found] = await sql<{ id: string }>(
        tx,
        `SELECT id FROM recovery_cases WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!found) throw new NotFoundException({ message: "No such case.", code: "case_not_found" });
      await sql(
        tx,
        `INSERT INTO recovery_case_notes (case_id, admin_id, note) VALUES ($1, $2, $3)`,
        [id, by.id, note],
      );
      await this.audit.record(
        by,
        "case.note",
        "ok",
        { type: "case", id },
        { length: note.length },
        tx,
      );
    });
  }

  /** Records how a case ended. Only an open case can be closed, and once only. */
  async close(
    by: AuditActor & { id: string },
    id: string,
    outcome: "resolved" | "written_off",
    reason: string,
  ) {
    await this.db.transaction(async (tx) => {
      const [row] = await sql<{ status: string }>(
        tx,
        `SELECT status FROM recovery_cases WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!row) throw new NotFoundException({ message: "No such case.", code: "case_not_found" });
      if (row.status !== "open") {
        throw new ConflictException({
          message: "That case is already closed.",
          code: "case_closed",
        });
      }
      await sql(tx, `UPDATE recovery_cases SET status = $2, resolved_at = now() WHERE id = $1`, [
        id,
        outcome,
      ]);
      await sql(
        tx,
        `INSERT INTO recovery_case_notes (case_id, admin_id, note) VALUES ($1, $2, $3)`,
        [
          id,
          by.id,
          `Closed as ${outcome === "resolved" ? "resolved" : "written off"}: ${reason}`.slice(
            0,
            1000,
          ),
        ],
      );
      await this.audit.record(
        by,
        "case.close",
        "ok",
        { type: "case", id },
        { outcome, reason },
        tx,
      );
    });
  }
}
