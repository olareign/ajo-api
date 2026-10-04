import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

/**
 * How many things (saving plans, èsúsú circles) currently depend on a person's auto-debit. A mandate
 * cannot be cancelled while this is above nothing. A plan depends on it only if the person asked it to
 * collect from their bank when the wallet is short.
 */
@Injectable()
export class ActiveCommitments {
  constructor(private readonly db: DataSource) {}

  async count(userId: string): Promise<number> {
    const [row] = await this.db.query<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM savings_plans
        WHERE user_id = $1 AND topup_from_bank AND status IN ('active', 'paused')`,
      [userId],
    );
    return Number(row?.n ?? 0);
  }
}
