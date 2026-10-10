import { BadRequestException, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

/** Money that arrives from outside a person's own accounts, and money that leaves them. */
export const MONEY_IN = ["funding", "group_payout", "payout_returned"] as const;
export const MONEY_OUT = [
  "withdrawal",
  "group_contribution",
  "group_late_fee",
  "group_deposit_cover",
] as const;
export const MAX_STATEMENT_DAYS = 366;
export const MAX_STATEMENT_LINES = 5_000;

const ZONES: Readonly<Record<string, string>> = { NG: "Africa/Lagos", GB: "Europe/London" };
const KINDS = "('available', 'locked', 'savings')";

const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
const isRealDay = (day: string) => new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

/**
 * Statements and monthly figures, always from the person's own ledger accounts and in their own time
 * zone. Read-only: nothing here changes money.
 */
@Injectable()
export class WalletReports {
  constructor(private readonly db: DataSource) {}

  private async zoneOf(userId: string): Promise<string> {
    const [row] = await this.db.query<{ country: string | null }[]>(
      `SELECT country FROM users WHERE id = $1`,
      [userId],
    );
    return ZONES[row?.country ?? ""] ?? "UTC";
  }

  async statement(userId: string, from: string, to: string) {
    if (!isRealDay(from) || !isRealDay(to)) {
      throw new BadRequestException({ message: "Those aren't real dates.", code: "bad_dates" });
    }
    const days = dayCount(from, to);
    if (days < 1) {
      throw new BadRequestException({
        message: "The last day comes before the first.",
        code: "bad_range",
      });
    }
    if (days > MAX_STATEMENT_DAYS) {
      throw new BadRequestException({
        message: "A statement covers a year at most. Choose a shorter range.",
        code: "range_too_long",
      });
    }
    const zone = await this.zoneOf(userId);
    // The range's edges as instants: midnight at the start of `from` and after `to`, in the person's zone.
    const params = [userId, from, to, zone];
    const start = `(($2::date)::timestamp AT TIME ZONE $4)`;
    const end = `((($3::date) + 1)::timestamp AT TIME ZONE $4)`;

    const lines = await this.db.query<
      {
        id: string;
        at: Date;
        type: string;
        kind: string;
        direction: "debit" | "credit";
        amount: string;
        currency: string;
        reference: string | null;
      }[]
    >(
      `SELECT e.id::text, t.created_at AS at, t.type, a.kind, e.direction, e.amount::text, e.currency, t.reference
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE a.owner_type = 'user' AND a.owner_id = $1 AND a.kind IN ${KINDS}
          AND t.created_at >= ${start} AND t.created_at < ${end}
        ORDER BY e.id
        LIMIT ${MAX_STATEMENT_LINES + 1}`,
      params,
    );
    const balances = await this.db.query<
      { currency: string; opening: string; closing: string; money_in: string; money_out: string }[]
    >(
      `SELECT e.currency,
              coalesce(sum(CASE WHEN t.created_at < ${start} THEN (CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END) END), 0)::text AS opening,
              coalesce(sum(CASE WHEN t.created_at < ${end} THEN (CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END) END), 0)::text AS closing,
              coalesce(sum(CASE WHEN t.created_at >= ${start} AND t.created_at < ${end} AND e.direction = 'credit' AND t.type = ANY($5::text[]) THEN e.amount END), 0)::text AS money_in,
              coalesce(sum(CASE WHEN t.created_at >= ${start} AND t.created_at < ${end} AND e.direction = 'debit' AND t.type = ANY($6::text[]) THEN e.amount END), 0)::text AS money_out
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE a.owner_type = 'user' AND a.owner_id = $1 AND a.kind IN ${KINDS}
        GROUP BY e.currency ORDER BY e.currency`,
      [...params, MONEY_IN, MONEY_OUT],
    );
    return {
      from,
      to,
      timeZone: zone,
      truncated: lines.length > MAX_STATEMENT_LINES,
      balances: balances.map((b) => ({
        currency: b.currency,
        opening: b.opening,
        closing: b.closing,
        moneyIn: b.money_in,
        moneyOut: b.money_out,
      })),
      lines: lines.slice(0, MAX_STATEMENT_LINES).map((l) => ({
        id: l.id,
        at: l.at.toISOString(),
        type: l.type,
        account: l.kind,
        direction: l.direction === "credit" ? "in" : "out",
        amount: l.amount,
        currency: l.currency,
        reference: l.reference,
      })),
    };
  }

  /** Month by month, the last `months` months including this one, in the person's time zone. */
  async insights(userId: string, months: number) {
    const zone = await this.zoneOf(userId);
    const rows = await this.db.query<
      {
        month: string;
        currency: string;
        money_in: string;
        money_out: string;
        saved_net: string;
        end_available: string;
        end_savings: string;
        end_locked: string;
      }[]
    >(
      `WITH bounds AS (
         SELECT date_trunc('month', (now() AT TIME ZONE $2)) - make_interval(months => $3::int - 1) AS first_month),
       months AS (
         SELECT generate_series((SELECT first_month FROM bounds), date_trunc('month', now() AT TIME ZONE $2), interval '1 month') AS m),
       mine AS (
         SELECT (t.created_at AT TIME ZONE $2) AS local_at, t.type, a.kind, e.currency,
                CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END AS signed,
                e.direction, e.amount
           FROM ledger_entries e
           JOIN ledger_accounts a ON a.id = e.account_id
           JOIN ledger_transactions t ON t.id = e.transaction_id
          WHERE a.owner_type = 'user' AND a.owner_id = $1 AND a.kind IN ${KINDS}),
       currencies AS (SELECT DISTINCT currency FROM mine)
       SELECT to_char(months.m, 'YYYY-MM') AS month, c.currency,
              coalesce(sum(x.amount) FILTER (WHERE x.direction = 'credit' AND x.type = ANY($4::text[]) AND date_trunc('month', x.local_at) = months.m), 0)::text AS money_in,
              coalesce(sum(x.amount) FILTER (WHERE x.direction = 'debit' AND x.type = ANY($5::text[]) AND date_trunc('month', x.local_at) = months.m), 0)::text AS money_out,
              coalesce(sum(x.signed) FILTER (WHERE x.kind = 'savings' AND date_trunc('month', x.local_at) = months.m), 0)::text AS saved_net,
              coalesce(sum(x.signed) FILTER (WHERE x.kind = 'available' AND x.local_at < months.m + interval '1 month'), 0)::text AS end_available,
              coalesce(sum(x.signed) FILTER (WHERE x.kind = 'savings' AND x.local_at < months.m + interval '1 month'), 0)::text AS end_savings,
              coalesce(sum(x.signed) FILTER (WHERE x.kind = 'locked' AND x.local_at < months.m + interval '1 month'), 0)::text AS end_locked
         FROM months CROSS JOIN currencies c
         LEFT JOIN mine x ON x.currency = c.currency
        GROUP BY months.m, c.currency
        ORDER BY c.currency, months.m`,
      [userId, zone, months, MONEY_IN, MONEY_OUT],
    );
    return {
      timeZone: zone,
      months: rows.map((r) => ({
        month: r.month,
        currency: r.currency,
        moneyIn: r.money_in,
        moneyOut: r.money_out,
        savedNet: r.saved_net,
        endAvailable: r.end_available,
        endSavings: r.end_savings,
        endLocked: r.end_locked,
      })),
    };
  }
}
