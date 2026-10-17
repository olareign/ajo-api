import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";

/** How many days the dashboard's trends cover. */
export const DASHBOARD_DAYS = 30;

export type DayCount = Readonly<{ day: string; count: number }>;
export type MoneyByCurrency = Readonly<{
  currency: string;
  held: string;
  moneyIn: string;
  moneyOut: string;
}>;
export type DayFlow = Readonly<{
  day: string;
  currency: string;
  moneyIn: string;
  moneyOut: string;
}>;

export type Dashboard = Readonly<{
  days: number;
  people: Readonly<{
    total: number;
    active: number;
    suspended: number;
    joinedInPeriod: number;
    byCountry: readonly Readonly<{ country: string; count: number }>[];
    signups: readonly DayCount[];
  }>;
  work: Readonly<{
    pendingKyc: number;
    openCases: number;
    failedPayments: number;
    stuckPayments: number;
  }>;
  money: readonly MoneyByCurrency[];
  flow: readonly DayFlow[];
  circles: Readonly<{ open: number; picking: number; running: number; completed: number }>;
  plans: Readonly<{ active: number; paused: number; completed: number }>;
  recent: readonly Readonly<{
    id: string;
    userId: string;
    kind: "funding" | "withdrawal";
    status: string;
    amount: string;
    currency: string;
    createdAt: string;
  }>[];
}>;

/**
 * The back office's first screen: how many people, how much money, what is moving, and what is
 * waiting on staff. Totals and trends only; the latest payments carry an id to open the person
 * (which is logged), never a name or email. Every figure is one read of what is already stored.
 */
@Injectable()
export class AdminDashboard {
  constructor(private readonly db: DataSource) {}

  async read(): Promise<Dashboard> {
    const since = `now() - interval '${DASHBOARD_DAYS} days'`;
    const [counts] = await this.db.query<Record<string, string>[]>(
      `SELECT (SELECT count(*) FROM users)::text AS total,
              (SELECT count(*) FROM users WHERE status = 'active')::text AS active,
              (SELECT count(*) FROM users WHERE status = 'suspended')::text AS suspended,
              (SELECT count(*) FROM users WHERE created_at >= ${since})::text AS joined,
              (SELECT count(DISTINCT user_id) FROM kyc_steps WHERE status = 'pending')::text AS pending_kyc,
              (SELECT count(*) FROM recovery_cases WHERE status = 'open')::text AS open_cases,
              (SELECT count(*) FROM payment_intents WHERE status = 'failed' AND created_at >= ${since})::text AS failed,
              (SELECT count(*) FROM payment_intents WHERE status IN ('created', 'pending') AND created_at < now() - interval '1 day')::text AS stuck,
              (SELECT count(*) FROM groups WHERE status = 'open')::text AS g_open,
              (SELECT count(*) FROM groups WHERE status = 'picking')::text AS g_picking,
              (SELECT count(*) FROM groups WHERE status = 'running')::text AS g_running,
              (SELECT count(*) FROM groups WHERE status = 'completed')::text AS g_completed,
              (SELECT count(*) FROM savings_plans WHERE status = 'active')::text AS p_active,
              (SELECT count(*) FROM savings_plans WHERE status = 'paused')::text AS p_paused,
              (SELECT count(*) FROM savings_plans WHERE status = 'completed')::text AS p_completed`,
    );
    const c = counts!;
    const n = (k: string) => Number(c[k]);

    const [byCountry, signups, held, moved, flow, recent] = await Promise.all([
      this.db.query<{ country: string; count: string }[]>(
        `SELECT coalesce(country, 'unset') AS country, count(*)::text AS count
           FROM users GROUP BY 1 ORDER BY count(*) DESC`,
      ),
      this.db.query<{ day: string; count: string }[]>(
        `SELECT to_char(d, 'YYYY-MM-DD') AS day,
                (SELECT count(*) FROM users u WHERE u.created_at >= d AND u.created_at < d + interval '1 day')::text AS count
           FROM generate_series(date_trunc('day', now()) - interval '${DASHBOARD_DAYS - 1} days', date_trunc('day', now()), interval '1 day') d
          ORDER BY d`,
      ),
      this.db.query<{ currency: string; held: string }[]>(
        `SELECT a.currency,
                coalesce(sum(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END), 0)::text AS held
           FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id
          WHERE a.owner_type = 'user'
          GROUP BY a.currency ORDER BY a.currency`,
      ),
      this.db.query<{ currency: string; money_in: string; money_out: string }[]>(
        `SELECT currency,
                coalesce(sum(amount) FILTER (WHERE kind = 'funding'), 0)::text AS money_in,
                coalesce(sum(amount) FILTER (WHERE kind = 'withdrawal'), 0)::text AS money_out
           FROM payment_intents
          WHERE status = 'succeeded' AND created_at >= ${since}
          GROUP BY currency`,
      ),
      this.db.query<{ day: string; currency: string; money_in: string; money_out: string }[]>(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, currency,
                coalesce(sum(amount) FILTER (WHERE kind = 'funding'), 0)::text AS money_in,
                coalesce(sum(amount) FILTER (WHERE kind = 'withdrawal'), 0)::text AS money_out
           FROM payment_intents
          WHERE status = 'succeeded' AND created_at >= ${since}
          GROUP BY 1, 2 ORDER BY 1, 2`,
      ),
      this.db.query<
        {
          id: string;
          user_id: string;
          kind: "funding" | "withdrawal";
          status: string;
          amount: string;
          currency: string;
          created_at: Date;
        }[]
      >(
        `SELECT id, user_id, kind, status, amount::text AS amount, currency, created_at
           FROM payment_intents ORDER BY created_at DESC LIMIT 8`,
      ),
    ]);

    const movedBy = new Map(moved.map((m) => [m.currency, m]));
    const currencies = [
      ...new Set([...held.map((h) => h.currency), ...moved.map((m) => m.currency)]),
    ].sort();
    return {
      days: DASHBOARD_DAYS,
      people: {
        total: n("total"),
        active: n("active"),
        suspended: n("suspended"),
        joinedInPeriod: n("joined"),
        byCountry: byCountry.map((r) => ({ country: r.country, count: Number(r.count) })),
        signups: signups.map((r) => ({ day: r.day, count: Number(r.count) })),
      },
      work: {
        pendingKyc: n("pending_kyc"),
        openCases: n("open_cases"),
        failedPayments: n("failed"),
        stuckPayments: n("stuck"),
      },
      money: currencies.map((currency) => ({
        currency,
        held: held.find((h) => h.currency === currency)?.held ?? "0",
        moneyIn: movedBy.get(currency)?.money_in ?? "0",
        moneyOut: movedBy.get(currency)?.money_out ?? "0",
      })),
      flow: flow.map((f) => ({
        day: f.day,
        currency: f.currency,
        moneyIn: f.money_in,
        moneyOut: f.money_out,
      })),
      circles: {
        open: n("g_open"),
        picking: n("g_picking"),
        running: n("g_running"),
        completed: n("g_completed"),
      },
      plans: { active: n("p_active"), paused: n("p_paused"), completed: n("p_completed") },
      recent: recent.map((r) => ({
        id: r.id,
        userId: r.user_id,
        kind: r.kind,
        status: r.status,
        amount: r.amount,
        currency: r.currency,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }
}
