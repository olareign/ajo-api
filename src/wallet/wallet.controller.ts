import { Controller, Get, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { DataSource } from "typeorm";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { KycService } from "../kyc/kyc.service.js";
import { currencyFor } from "../kyc/partners.js";
import { PaymentProviders } from "../payments/providers/providers.service.js";
import {
  InsightsQuery,
  InsightsResponse,
  StatementQuery,
  StatementResponse,
} from "./reports.dto.js";
import { WalletReports } from "./reports.service.js";
import {
  RailsResponse,
  TransactionsQuery,
  TransactionsResponse,
  WalletsResponse,
  type TransactionItem,
} from "./wallet.dto.js";

@ApiTags("wallet")
@ApiBearerAuth()
@Controller("wallet")
export class WalletController {
  constructor(
    private readonly db: DataSource,
    private readonly kyc: KycService,
    private readonly providers: PaymentProviders,
    private readonly reports: WalletReports,
  ) {}

  /** What this person can do with money today: their currency, whether they are approved, and which partners are live. */
  @Get("rails")
  @ApiOkResponse({ type: RailsResponse })
  async rails(@CurrentUser() auth: AccessClaims): Promise<RailsResponse> {
    const [user] = await this.db.query<{ country: string | null }[]>(
      `SELECT country FROM users WHERE id = $1`,
      [auth.userId],
    );
    const country = user?.country ?? null;
    return {
      country,
      currency: currencyFor(country),
      kycApproved: await this.kyc.isApproved(auth.userId),
      connected: this.providers.capabilities(country),
    };
  }

  /** Balances are derived from ledger entries; only the caller's own accounts, from the session. */
  @Get()
  @ApiOkResponse({ type: WalletsResponse })
  async wallets(@CurrentUser() auth: AccessClaims): Promise<WalletsResponse> {
    const rows = await this.db.query<{ currency: string; kind: string; balance: string }[]>(
      `SELECT a.currency, a.kind,
              coalesce(sum(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END), 0)::text AS balance
         FROM ledger_accounts a
         LEFT JOIN ledger_entries e ON e.account_id = a.id
        WHERE a.owner_type = 'user' AND a.owner_id = $1 AND a.kind IN ('available', 'locked', 'savings')
        GROUP BY a.currency, a.kind`,
      [auth.userId],
    );
    const byCurrency = new Map<string, { available: bigint; locked: bigint; savings: bigint }>();
    for (const row of rows) {
      const wallet = byCurrency.get(row.currency) ?? { available: 0n, locked: 0n, savings: 0n };
      wallet[row.kind as "available" | "locked" | "savings"] += BigInt(row.balance);
      byCurrency.set(row.currency, wallet);
    }
    const money = (amount: bigint, currency: string) => ({ amount: amount.toString(), currency });
    return {
      wallets: [...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, w]) => ({
          currency,
          available: money(w.available, currency),
          locked: money(w.locked, currency),
          savings: money(w.savings, currency),
        })),
    };
  }

  @Get("transactions")
  @ApiOkResponse({ type: TransactionsResponse })
  async transactions(
    @CurrentUser() auth: AccessClaims,
    @Query() query: TransactionsQuery,
  ): Promise<TransactionsResponse> {
    const limit = query.limit ?? 20;
    const rows = await this.db.query<
      {
        id: string;
        transaction_id: string;
        type: string;
        kind: string;
        direction: "debit" | "credit";
        amount: string;
        currency: string;
        created_at: Date;
      }[]
    >(
      `SELECT e.id::text, e.transaction_id, t.type, a.kind, e.direction, e.amount::text, e.currency, t.created_at
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE a.owner_type = 'user' AND a.owner_id = $1 AND a.kind IN ('available', 'locked', 'savings')
          AND ($2::bigint IS NULL OR e.id < $2::bigint)
        ORDER BY e.id DESC
        LIMIT $3`,
      [auth.userId, query.before ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const items: TransactionItem[] = page.map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      type: r.type,
      account: r.kind,
      direction: r.direction === "credit" ? "in" : "out",
      amount: { amount: r.amount, currency: r.currency },
      currency: r.currency,
      createdAt: r.created_at.toISOString(),
    }));
    return { items, next: rows.length > limit ? page[page.length - 1]!.id : null };
  }

  /** Every line on the caller's own accounts in a date range, with opening and closing balances. */
  @Get("statement")
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({ type: StatementResponse })
  statement(
    @CurrentUser() auth: AccessClaims,
    @Query() query: StatementQuery,
  ): Promise<StatementResponse> {
    return this.reports.statement(auth.userId, query.from, query.to);
  }

  /** Money in, money out, saved and month-end balances, month by month. */
  @Get("insights")
  @ApiOkResponse({ type: InsightsResponse })
  insights(
    @CurrentUser() auth: AccessClaims,
    @Query() query: InsightsQuery,
  ): Promise<InsightsResponse> {
    return this.reports.insights(auth.userId, query.months ?? 12);
  }
}
