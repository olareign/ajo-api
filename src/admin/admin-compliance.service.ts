import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { KYC_STEPS, type KycStep } from "../kyc/kyc-status.js";
import { KycService } from "../kyc/kyc.service.js";
import { AdminAudit, type AuditActor } from "./admin-audit.service.js";

/**
 * The identity review queue. Identity checks are not connected to a partner yet, so there are no
 * documents here to open; what staff can do is decide a step that is waiting and, for one person,
 * approve or hold them by hand (what `pnpm kyc:override` did, now with a reason and a record).
 */
@Injectable()
export class AdminCompliance {
  constructor(
    private readonly db: DataSource,
    private readonly audit: AdminAudit,
    private readonly kyc: KycService,
  ) {}

  async queue(by: AuditActor) {
    const rows = await this.db.query<
      {
        id: string;
        email: string;
        display_name: string;
        country: string | null;
        waiting: string;
        oldest: Date;
        held: boolean;
      }[]
    >(
      `SELECT u.id, u.email, u.display_name, u.country,
              count(*) FILTER (WHERE s.status = 'pending')::text AS waiting,
              min(s.created_at) FILTER (WHERE s.status = 'pending') AS oldest,
              (u.kyc_override = 'denied') AS held
         FROM users u JOIN kyc_steps s ON s.user_id = u.id
        GROUP BY u.id
       HAVING count(*) FILTER (WHERE s.status = 'pending') > 0
        ORDER BY oldest LIMIT 50`,
    );
    await this.audit.record(by, "kyc.queue", "ok", undefined, { count: rows.length });
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      country: r.country,
      waitingSteps: Number(r.waiting),
      oldestAt: r.oldest,
      held: r.held,
    }));
  }

  async detail(by: AuditActor, userId: string) {
    const [user] = await this.db.query<
      {
        id: string;
        email: string;
        display_name: string;
        country: string | null;
        kyc_override: string | null;
      }[]
    >(`SELECT id, email, display_name, country, kyc_override FROM users WHERE id = $1`, [userId]);
    if (!user)
      throw new NotFoundException({ message: "No such person.", code: "person_not_found" });
    const [summary, steps, log] = await Promise.all([
      this.kyc.summaryFor(userId),
      this.db.query<
        {
          step: string;
          status: string;
          reason: string | null;
          provider_ref: string | null;
          created_at: Date;
          updated_at: Date;
        }[]
      >(
        `SELECT step, status, reason, provider_ref, created_at, updated_at FROM kyc_steps WHERE user_id = $1`,
        [userId],
      ),
      this.db.query<
        { previous_value: string | null; new_value: string | null; changed_at: Date }[]
      >(
        `SELECT previous_value, new_value, changed_at FROM kyc_override_log WHERE user_id = $1 ORDER BY id DESC LIMIT 10`,
        [userId],
      ),
    ]);
    await this.audit.record(by, "kyc.view", "ok", { type: "user", id: userId });
    const byStep = new Map(steps.map((s) => [s.step, s]));
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      country: user.country,
      status: summary.status,
      tier: summary.tier,
      via: summary.via,
      override: user.kyc_override,
      steps: KYC_STEPS.map((step) => {
        const row = byStep.get(step);
        return {
          step,
          status: row?.status ?? "not_started",
          reason: row?.reason ?? null,
          reference: row?.provider_ref ?? null,
          updatedAt: row?.updated_at ?? null,
        };
      }),
      overrideHistory: log.map((l) => ({
        from: l.previous_value,
        to: l.new_value,
        at: l.changed_at,
      })),
      documents: [] as never[],
    };
  }

  /** Decides one step that is waiting. Only a waiting step can be decided, and a rejection says why. */
  async decideStep(
    by: AuditActor,
    userId: string,
    step: string,
    decision: "approved" | "rejected",
    reason: string,
  ) {
    if (!(KYC_STEPS as readonly string[]).includes(step)) {
      throw new NotFoundException({ message: "No such step.", code: "step_not_found" });
    }
    await this.db.transaction(async (tx) => {
      const [row] = await sql<{ status: string }>(
        tx,
        `SELECT status FROM kyc_steps WHERE user_id = $1 AND step = $2 FOR UPDATE`,
        [userId, step as KycStep],
      );
      if (!row)
        throw new NotFoundException({
          message: "That step hasn't been submitted.",
          code: "step_not_found",
        });
      if (row.status !== "pending") {
        throw new ConflictException({
          message: "That step has already been decided.",
          code: "step_decided",
        });
      }
      await sql(
        tx,
        `UPDATE kyc_steps SET status = $3, reason = $4, updated_at = now() WHERE user_id = $1 AND step = $2`,
        [userId, step, decision, reason.slice(0, 300)],
      );
      await this.audit.record(
        by,
        "kyc.step",
        "ok",
        { type: "user", id: userId },
        { step, decision, reason },
        tx,
      );
    });
  }

  /** Approves a person without the checks, holds them back, or clears either. The database logs it too. */
  async override(
    by: AuditActor,
    userId: string,
    action: "approve" | "deny" | "clear",
    reason: string,
  ) {
    const value = action === "approve" ? "approved" : action === "deny" ? "denied" : null;
    await this.db.transaction(async (tx) => {
      const [row] = await sql<{ kyc_override: string | null }>(
        tx,
        `SELECT kyc_override FROM users WHERE id = $1 FOR UPDATE`,
        [userId],
      );
      if (!row)
        throw new NotFoundException({ message: "No such person.", code: "person_not_found" });
      await sql(tx, `UPDATE users SET kyc_override = $2, updated_at = now() WHERE id = $1`, [
        userId,
        value,
      ]);
      await this.audit.record(
        by,
        "kyc.override",
        "ok",
        { type: "user", id: userId },
        { from: row.kyc_override, to: value, reason },
        tx,
      );
    });
  }
}
