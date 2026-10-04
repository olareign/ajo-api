import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { summarise, type KycSummary, type StepRow } from "./kyc-status.js";

@Injectable()
export class KycService {
  constructor(private readonly db: DataSource) {}

  /** The person's progress, from their own rows only. */
  async summaryFor(userId: string): Promise<KycSummary> {
    const rows = await this.db.query<StepRow[]>(
      `SELECT step, status, reason FROM kyc_steps WHERE user_id = $1`,
      [userId],
    );
    return summarise(rows);
  }

  async isApproved(userId: string): Promise<boolean> {
    return (await this.summaryFor(userId)).status === "approved";
  }
}
