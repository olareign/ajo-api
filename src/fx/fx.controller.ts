import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { DataSource } from "typeorm";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { convertMinor, crossRate, DISPLAY_CURRENCIES } from "./convert.js";
import { FxEquivalentsResponse } from "./fx.dto.js";
import { FxService } from "./fx.service.js";

@ApiTags("wallet")
@ApiBearerAuth()
@Controller("fx")
export class FxController {
  constructor(
    private readonly db: DataSource,
    private readonly fx: FxService,
  ) {}

  /**
   * What the caller's own wallets are worth in the other currencies Àjọ shows, at the latest rates.
   * For showing only: no money changes currency here, and the person is told so.
   */
  @Get("wallet")
  @ApiOkResponse({ type: FxEquivalentsResponse })
  async wallet(@CurrentUser() auth: AccessClaims): Promise<FxEquivalentsResponse> {
    const rates = await this.fx.rates();
    if (!rates) return { available: false, asOf: null, stale: false, sample: false, wallets: [] };
    const rows = await this.db.query<{ currency: string; total: string }[]>(
      `SELECT a.currency,
              coalesce(sum(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END), 0)::text AS total
         FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.owner_type = 'user' AND a.owner_id = $1 AND a.kind IN ('available', 'locked', 'savings')
        GROUP BY a.currency ORDER BY a.currency`,
      [auth.userId],
    );
    const wallets = rows
      .filter((row) => rates.rates[row.currency] !== undefined)
      .map((row) => {
        const from = rates.rates[row.currency]!;
        return {
          currency: row.currency,
          total: row.total,
          equivalents: DISPLAY_CURRENCIES.filter(
            (to) => to !== row.currency && rates.rates[to] !== undefined,
          ).map((to) => ({
            currency: to,
            amount: convertMinor(BigInt(row.total), from, rates.rates[to]!).toString(),
            rate: crossRate(from, rates.rates[to]!),
          })),
        };
      });
    return {
      available: true,
      asOf: rates.asOf.toISOString(),
      stale: rates.stale,
      sample: rates.source === "sample",
      wallets,
    };
  }
}
