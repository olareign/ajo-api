import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import {
  resolveKyc,
  summarise,
  type KycOverride,
  type KycSummary,
  type StepRow,
} from "./kyc-status.js";

@Injectable()
export class KycService implements OnModuleInit {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    if (this.env.KYC_AUTO_APPROVE) {
      // Loud on purpose: this skips the checks the gate exists for, and must not outlive testing.
      this.logger.warn("KYC_AUTO_APPROVE is on: every account counts as approved without checks");
    }
  }

  /**
   * The person's progress, from their own rows only, with the owner's switches applied while the
   * real checks are pended (see `resolveKyc`).
   */
  async summaryFor(userId: string): Promise<KycSummary> {
    const [rows, owner] = await Promise.all([
      this.db.query<StepRow[]>(`SELECT step, status, reason FROM kyc_steps WHERE user_id = $1`, [
        userId,
      ]),
      this.db.query<{ kyc_override: KycOverride | null }[]>(
        `SELECT kyc_override FROM users WHERE id = $1`,
        [userId],
      ),
    ]);
    return resolveKyc(summarise(rows), {
      override: owner[0]?.kyc_override ?? null,
      autoApprove: this.env.KYC_AUTO_APPROVE,
    });
  }

  async isApproved(userId: string): Promise<boolean> {
    return (await this.summaryFor(userId)).status === "approved";
  }
}
