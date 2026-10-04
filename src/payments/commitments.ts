import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

/**
 * How many things (saving plans, èsúsú circles) currently depend on a person's auto-debit. A mandate
 * cannot be cancelled while this is above nothing. A plan depends on it only if the person asked it to
 * collect from their bank when the wallet is short; a circle that is open or running always does.
 */
@Injectable()
export class ActiveCommitments {
  constructor(private readonly db: DataSource) {}

  async count(userId: string): Promise<number> {
    const [row] = await this.db.query<{ n: string }[]>(
      `SELECT ((SELECT count(*) FROM savings_plans
                 WHERE user_id = $1 AND topup_from_bank AND status IN ('active', 'paused'))
             + (SELECT count(*) FROM group_members m JOIN groups g ON g.id = m.group_id
                 WHERE m.user_id = $1 AND m.status = 'active' AND g.status IN ('open', 'picking', 'running')))::text AS n`,
      [userId],
    );
    return Number(row?.n ?? 0);
  }
}
