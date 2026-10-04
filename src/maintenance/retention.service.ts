import { Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";

/** How long finished rows are kept before they are deleted. */
export const RETENTION = {
  /** An expired session is kept a week, so recent sign-ins can still be looked into. */
  expiredSessionDays: 7,
  /** A revoked session (sign-out, password reset, suspected token theft) is kept a month. */
  revokedSessionDays: 30,
  /**
   * A refresh token is only useful until it expires: before that, a used one still reveals a
   * stolen copy. A day of slack after expiry covers clock differences.
   */
  expiredRefreshTokenDays: 1,
  /** Spent or expired one-time links and codes. */
  spentTokenDays: 7,
  /** A day of slack after a remembered device expires, for clock differences. */
  expiredTrustedDeviceDays: 1,
} as const;

export const PURGE_BATCH_SIZE = 1000;

export type PurgeReport = Record<
  | "refreshTokens"
  | "sessions"
  | "emailVerificationTokens"
  | "passwordResetTokens"
  | "mfaChallenges"
  | "trustedDevices",
  number
>;

type Target = Readonly<{ key: keyof PurgeReport; table: string; where: string }>;

// Order matters: tokens first, so sessions are not carrying a long tail of them when deleted.
const TARGETS: readonly Target[] = [
  {
    key: "refreshTokens",
    table: "refresh_tokens",
    where: `expires_at < now() - make_interval(days => ${RETENTION.expiredRefreshTokenDays})`,
  },
  {
    key: "sessions",
    table: "sessions",
    where: `expires_at < now() - make_interval(days => ${RETENTION.expiredSessionDays})
         OR revoked_at < now() - make_interval(days => ${RETENTION.revokedSessionDays})`,
  },
  {
    key: "trustedDevices",
    table: "trusted_devices",
    where: `expires_at < now() - make_interval(days => ${RETENTION.expiredTrustedDeviceDays})`,
  },
  ...(
    [
      ["emailVerificationTokens", "email_verification_tokens"],
      ["passwordResetTokens", "password_reset_tokens"],
      ["mfaChallenges", "mfa_challenges"],
    ] as const
  ).map(([key, table]) => ({
    key,
    table,
    where: `expires_at < now() - make_interval(days => ${RETENTION.spentTokenDays})
         OR used_at < now() - make_interval(days => ${RETENTION.spentTokenDays})`,
  })),
];

/**
 * Deletes finished sessions and tokens so those tables stay small. It works in short batches
 * (each its own transaction, skipping rows another process holds), so it never locks a table
 * or runs one huge delete, and it is safe to run on several instances or to interrupt.
 * Accounts and the ledger are never touched.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(private readonly db: DataSource) {}

  async purge(options: { batchSize?: number } = {}): Promise<PurgeReport> {
    const batchSize = options.batchSize ?? PURGE_BATCH_SIZE;
    const report: PurgeReport = {
      refreshTokens: 0,
      sessions: 0,
      emailVerificationTokens: 0,
      passwordResetTokens: 0,
      mfaChallenges: 0,
      trustedDevices: 0,
    };
    for (const target of TARGETS) {
      report[target.key] = await this.purgeTable(target, batchSize);
    }
    this.logger.log({ removed: report }, "Purged expired sessions and tokens");
    return report;
  }

  private async purgeTable({ table, where }: Target, batchSize: number): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.db.transaction(async (tx) => {
        const rows = await sql<{ id: string }>(
          tx,
          `DELETE FROM ${table}
            WHERE id IN (SELECT id FROM ${table} WHERE ${where} LIMIT $1 FOR UPDATE SKIP LOCKED)
            RETURNING id`,
          [batchSize],
        );
        return rows.length;
      });
      total += deleted;
      if (deleted < batchSize) return total;
    }
  }
}
