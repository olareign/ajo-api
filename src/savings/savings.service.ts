import {
  BadRequestException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { PinService } from "../identity/pin.service.js";
import { currencyFor } from "../kyc/partners.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { Notifications } from "../notifications/notifications.service.js";
import { BankPulls } from "../payments/bank-pulls.service.js";
import { PaymentContext } from "../payments/payment-context.js";
import { coded, requestHash } from "../payments/payment-intents.js";
import { moneyText } from "./money-text.js";
import type { PlanDetailResponse, PlanDto, PlanResponse, PreviewResponse } from "./savings.dto.js";
import {
  MAX_OPEN_PLANS,
  daysBetween,
  planProblem,
  scheduleDates,
  todayIn,
  zoneFor,
  AMOUNT_LIMITS,
  type PlanInput,
} from "./savings-rules.js";

type Tx = Parameters<typeof sql>[0];

export type PlanRow = {
  id: string;
  user_id: string;
  name: string;
  currency: string;
  amount: string;
  frequency: "daily" | "weekly" | "monthly";
  total_debits: number;
  start_date: string;
  topup_from_bank: boolean;
  status: "active" | "paused" | "completed" | "cancelled";
  closed_at: Date | null;
  payout_amount: string | null;
  penalty_amount: string;
  request_hash: string;
  created_at: Date;
};

export const PLAN_COLUMNS = `id, user_id, name, currency, amount::text, frequency, total_debits,
  start_date::text, topup_from_bank, status, closed_at, payout_amount::text, penalty_amount::text,
  request_hash, created_at`;

const money = (amount: string | bigint, currency: string) => ({
  amount: amount.toString(),
  currency,
});

/** The ledger account a plan's savings sit in: one per plan, so what is saved is read, never counted. */
export const planRef = (planId: string) => `plan:${planId}`;

const closed = () => coded(HttpStatus.CONFLICT, "That plan has already ended.", "plan_closed");

/** What a person can do with their saving plans. Every change to money goes through the ledger. */
@Injectable()
export class Savings {
  constructor(
    private readonly db: DataSource,
    private readonly ledger: LedgerService,
    private readonly context: PaymentContext,
    private readonly pulls: BankPulls,
    private readonly pins: PinService,
    private readonly notifications: Notifications,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---- before saying yes -------------------------------------------------------------------------

  /** The days and total for a plan the person is thinking about. Saves nothing. */
  async preview(userId: string, input: PlanInput): Promise<PreviewResponse> {
    const { currency } = await this.currencyOf(userId);
    this.check(input, currency);
    const dates = scheduleDates(input.startDate, input.frequency, input.totalDebits);
    return {
      dates,
      total: money(BigInt(input.amount) * BigInt(input.totalDebits), currency),
      endDate: dates[dates.length - 1]!,
    };
  }

  // ---- making a plan -----------------------------------------------------------------------------

  async create(
    userId: string,
    input: PlanDto,
    idempotencyKey: string,
  ): Promise<PlanDetailResponse> {
    const { currency } = await this.currencyOf(userId);
    this.check(input, currency);
    if (input.topupFromBank && !(await this.pulls.available(userId))) {
      throw coded(
        HttpStatus.CONFLICT,
        "Set up auto-debit first, or turn off collecting from your bank.",
        "no_mandate",
      );
    }
    const hash = requestHash(
      "plan",
      input.name.trim(),
      input.amount,
      input.frequency,
      input.totalDebits,
      input.startDate,
      input.topupFromBank === true,
    );
    const dates = scheduleDates(input.startDate, input.frequency, input.totalDebits);

    const id = await this.db.transaction(async (tx) => {
      // One person's plans are made one at a time, so the limit on open plans cannot be passed by a double tap.
      await sql(tx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const [existing] = await sql<{ id: string; request_hash: string }>(
        tx,
        `SELECT id, request_hash FROM savings_plans WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, idempotencyKey],
      );
      if (existing) {
        if (existing.request_hash !== hash) {
          throw coded(
            HttpStatus.CONFLICT,
            "That idempotency key was already used for a different request.",
            "idempotency_key_reused",
          );
        }
        return existing.id;
      }
      const [{ open }] = (await sql<{ open: string }>(
        tx,
        `SELECT count(*)::text AS open FROM savings_plans WHERE user_id = $1 AND status IN ('active', 'paused')`,
        [userId],
      )) as [{ open: string }];
      if (Number(open) >= MAX_OPEN_PLANS) {
        throw coded(
          HttpStatus.CONFLICT,
          `You can have up to ${MAX_OPEN_PLANS} plans going at once. Finish or end one first.`,
          "too_many_plans",
        );
      }
      const [plan] = await sql<{ id: string }>(
        tx,
        `INSERT INTO savings_plans (user_id, name, currency, amount, frequency, total_debits, start_date,
                                    topup_from_bank, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          userId,
          input.name.trim(),
          currency,
          input.amount,
          input.frequency,
          input.totalDebits,
          input.startDate,
          input.topupFromBank === true,
          idempotencyKey,
          hash,
        ],
      );
      const planId = plan!.id;
      await sql(
        tx,
        `INSERT INTO savings_debits (plan_id, seq, due_on, next_attempt_at)
         SELECT $1, s.seq, s.due_on, ((s.due_on + time '08:00') AT TIME ZONE $4)
           FROM unnest($2::int[], $3::date[]) AS s(seq, due_on)`,
        [planId, dates.map((_, i) => i + 1), dates, zoneFor(currency)],
      );
      await this.ledger.userAccount(userId, "savings", currency, planRef(planId), tx);
      await this.notifications.notify(
        userId,
        {
          kind: "plan.created",
          title: `${input.name.trim()} is set up`,
          body: `We'll save ${moneyText(input.amount, currency)} ${input.frequency}, ${input.totalDebits} times, starting ${input.startDate}.`,
          link: `/save/${planId}`,
          dedupeKey: `plan:${planId}:created`,
        },
        tx,
      );
      return planId;
    });
    return this.detail(userId, id);
  }

  // ---- looking ----------------------------------------------------------------------------------

  async list(userId: string): Promise<PlanResponse[]> {
    const rows = await this.db.query<ViewRow[]>(
      `${VIEW_SELECT} WHERE p.user_id = $1
        ORDER BY (p.status IN ('active', 'paused')) DESC, p.created_at DESC`,
      [userId],
    );
    return rows.map(view);
  }

  async detail(userId: string, id: string): Promise<PlanDetailResponse> {
    const [row] = await this.db.query<ViewRow[]>(
      `${VIEW_SELECT} WHERE p.user_id = $1 AND p.id = $2`,
      [userId, id],
    );
    if (!row) throw new NotFoundException();
    const schedule = await this.db.query<{ seq: number; due_on: string; status: string }[]>(
      `SELECT seq, due_on::text, status FROM savings_debits WHERE plan_id = $1 ORDER BY seq`,
      [id],
    );
    const history = await this.db.query<
      { type: string; direction: string; amount: string; created_at: Date }[]
    >(
      `SELECT t.type, e.direction, e.amount::text, t.created_at
         FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE a.owner_type = 'user' AND a.owner_id = $1 AND a.kind = 'savings' AND a.ref = $2
        ORDER BY e.id DESC LIMIT 50`,
      [userId, planRef(id)],
    );
    return {
      ...view(row),
      earlyWithdrawalPenaltyBps: this.env.EARLY_WITHDRAWAL_PENALTY_BPS,
      schedule: schedule.map((d) => ({ seq: d.seq, dueOn: d.due_on, status: d.status })),
      history: history.map((h) => ({
        type: h.type,
        direction: h.direction === "credit" ? "in" : "out",
        amount: money(h.amount, row.currency),
        createdAt: h.created_at.toISOString(),
      })),
    };
  }

  // ---- changing a plan ---------------------------------------------------------------------------

  /** Stops the debits until the person says go. Saying it twice changes nothing. */
  async pause(userId: string, id: string): Promise<PlanDetailResponse> {
    await this.db.transaction(async (tx) => {
      const plan = await this.lock(tx, userId, id);
      if (plan.status === "paused") return;
      if (plan.status !== "active") throw closed();
      await sql(
        tx,
        `UPDATE savings_plans SET status = 'paused', paused_at = now(), updated_at = now() WHERE id = $1`,
        [id],
      );
    });
    return this.detail(userId, id);
  }

  /**
   * Starts the debits again. Any debit whose day went by while paused moves forward, all together, so
   * the plan keeps its shape and the first one is due today instead of piling up.
   */
  async resume(userId: string, id: string): Promise<PlanDetailResponse> {
    await this.db.transaction(async (tx) => {
      const plan = await this.lock(tx, userId, id);
      if (plan.status === "active") return;
      if (plan.status !== "paused") throw closed();
      const today = todayIn(plan.currency);
      const [first] = await sql<{ due_on: string | null }>(
        tx,
        `SELECT min(due_on)::text AS due_on FROM savings_debits WHERE plan_id = $1 AND status = 'scheduled'`,
        [id],
      );
      const late = first?.due_on && first.due_on < today ? daysBetween(first.due_on, today) : 0;
      if (late > 0) {
        await sql(
          tx,
          `UPDATE savings_debits
              SET due_on = due_on + $2::int, attempts = 0, pull_key = NULL,
                  next_attempt_at = (((due_on + $2::int) + time '08:00') AT TIME ZONE $3)
            WHERE plan_id = $1 AND status = 'scheduled'`,
          [id, late, zoneFor(plan.currency)],
        );
      }
      await sql(
        tx,
        `UPDATE savings_plans SET status = 'active', paused_at = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
    });
    return this.detail(userId, id);
  }

  /** Adds money from the wallet to a plan right now. The same key twice adds it once. */
  async topUp(
    userId: string,
    id: string,
    amount: string,
    idempotencyKey: string,
  ): Promise<PlanDetailResponse> {
    await this.db.transaction(async (tx) => {
      const plan = await this.lock(tx, userId, id);
      if (plan.status !== "active" && plan.status !== "paused") throw closed();
      const limits = AMOUNT_LIMITS[plan.currency];
      if (limits && (BigInt(amount) < limits.min || BigInt(amount) > limits.max)) {
        throw new BadRequestException({
          message: "That amount isn't allowed for a top-up.",
          code: "amount_not_allowed",
        });
      }
      const wallet = await this.ledger.userAccount(
        userId,
        "available",
        plan.currency,
        undefined,
        tx,
      );
      const saved = await this.ledger.userAccount(
        userId,
        "savings",
        plan.currency,
        planRef(id),
        tx,
      );
      const key = `savings-topup:${id}:${idempotencyKey}`;
      const [replay] = await sql<{ id: string }>(
        tx,
        `SELECT id FROM ledger_transactions WHERE idempotency_key = $1`,
        [key],
      );
      if (!replay && BigInt(await this.ledger.balance(wallet, tx)) < BigInt(amount)) {
        throw coded(
          HttpStatus.CONFLICT,
          "You don't have enough in your wallet for that.",
          "insufficient_funds",
        );
      }
      await this.ledger.post(
        {
          type: "savings_topup",
          idempotencyKey: key,
          reference: planRef(id),
          entries: [
            { accountId: wallet, direction: "debit", amount },
            { accountId: saved, direction: "credit", amount },
          ],
        },
        {},
        tx,
      );
    });
    return this.detail(userId, id);
  }

  /**
   * Ends the plan now and brings what is saved back to the wallet, less the early-withdrawal charge
   * (none unless the owner sets one). The PIN is checked first. Ending an ended plan changes nothing.
   */
  async withdrawEarly(userId: string, id: string, pin: string): Promise<PlanDetailResponse> {
    await this.pins.verify(userId, pin);
    await this.db.transaction(async (tx) => {
      const plan = await this.lock(tx, userId, id);
      if (plan.status === "cancelled") return;
      if (plan.status === "completed") throw closed();
      const wallet = await this.ledger.userAccount(
        userId,
        "available",
        plan.currency,
        undefined,
        tx,
      );
      const saved = await this.ledger.userAccount(
        userId,
        "savings",
        plan.currency,
        planRef(id),
        tx,
      );
      const balance = BigInt(await this.ledger.balance(saved, tx));
      const penalty = (balance * BigInt(this.env.EARLY_WITHDRAWAL_PENALTY_BPS)) / 10_000n;
      const back = balance - penalty;
      if (balance > 0n) {
        const entries = [
          { accountId: saved, direction: "debit" as const, amount: balance.toString() },
          ...(back > 0n
            ? [{ accountId: wallet, direction: "credit" as const, amount: back.toString() }]
            : []),
          ...(penalty > 0n
            ? [
                {
                  accountId: await this.ledger.systemAccount(
                    "fees",
                    plan.currency,
                    "early-withdrawal",
                    tx,
                  ),
                  direction: "credit" as const,
                  amount: penalty.toString(),
                },
              ]
            : []),
        ];
        await this.ledger.post(
          {
            type: "savings_early_withdrawal",
            idempotencyKey: `savings-close:${id}`,
            reference: planRef(id),
            entries,
          },
          {},
          tx,
        );
      }
      await sql(
        tx,
        `UPDATE savings_debits SET status = 'skipped' WHERE plan_id = $1 AND status = 'scheduled'`,
        [id],
      );
      await sql(
        tx,
        `UPDATE savings_plans SET status = 'cancelled', closed_at = now(), payout_amount = $2,
                penalty_amount = $3, updated_at = now() WHERE id = $1`,
        [id, back.toString(), penalty.toString()],
      );
      await this.notifications.notify(
        userId,
        {
          kind: "plan.ended_early",
          title: `${plan.name} was ended`,
          body:
            balance === 0n
              ? "The plan was ended before anything was saved."
              : `${moneyText(back, plan.currency)} went back to your wallet${penalty > 0n ? `, after a ${moneyText(penalty, plan.currency)} early-withdrawal charge` : ""}.`,
          link: `/save/${id}`,
          dedupeKey: `plan:${id}:ended`,
          email: true,
        },
        tx,
      );
    });
    return this.detail(userId, id);
  }

  // ---- helpers ----------------------------------------------------------------------------------

  private async lock(tx: Tx, userId: string, id: string): Promise<PlanRow> {
    const [plan] = await sql<PlanRow>(
      tx,
      `SELECT ${PLAN_COLUMNS} FROM savings_plans WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [id, userId],
    );
    if (!plan) throw new NotFoundException();
    return plan;
  }

  private async currencyOf(userId: string): Promise<{ currency: string }> {
    const person = await this.context.person(userId);
    const currency = currencyFor(person.country);
    if (!currency) {
      throw coded(HttpStatus.CONFLICT, "Choose your country first.", "country_required");
    }
    return { currency };
  }

  private check(input: PlanInput, currency: string): void {
    const problem = planProblem(input, currency, todayIn(currency));
    if (problem) throw new BadRequestException({ message: problem, code: "plan_invalid" });
  }
}

type ViewRow = PlanRow & {
  saved: string;
  paid: string;
  failed: string;
  next_due: string | null;
  last_due: string;
};

/** A plan with what is saved (from the ledger) and how its debits stand. */
const VIEW_SELECT = `
  SELECT ${PLAN_COLUMNS.split(",")
    .map((c) => `p.${c.trim()}`)
    .join(", ")},
         coalesce((SELECT sum(CASE e.direction WHEN 'credit' THEN e.amount ELSE -e.amount END)
                     FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
                    WHERE a.owner_type = 'user' AND a.owner_id = p.user_id AND a.kind = 'savings'
                      AND a.ref = 'plan:' || p.id::text), 0)::text AS saved,
         (SELECT count(*) FROM savings_debits d WHERE d.plan_id = p.id AND d.status = 'paid')::text AS paid,
         (SELECT count(*) FROM savings_debits d WHERE d.plan_id = p.id AND d.status = 'failed')::text AS failed,
         (SELECT min(d.due_on) FROM savings_debits d WHERE d.plan_id = p.id AND d.status = 'scheduled')::text AS next_due,
         (SELECT max(d.due_on) FROM savings_debits d WHERE d.plan_id = p.id)::text AS last_due
    FROM savings_plans p`;

/** The response's fields as a plain object, so a detail can spread it. */
type PlainPlan = { [K in keyof PlanResponse]: PlanResponse[K] };

function view(row: ViewRow): PlainPlan {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    frequency: row.frequency,
    amount: money(row.amount, row.currency),
    totalDebits: row.total_debits,
    startDate: row.start_date,
    endDate: row.last_due,
    saved: money(row.saved, row.currency),
    target: money(BigInt(row.amount) * BigInt(row.total_debits), row.currency),
    paidDebits: Number(row.paid),
    failedDebits: Number(row.failed),
    nextDebit:
      row.next_due && (row.status === "active" || row.status === "paused")
        ? { dueOn: row.next_due, amount: money(row.amount, row.currency) }
        : null,
    topupFromBank: row.topup_from_bank,
    payout: row.payout_amount === null ? null : money(row.payout_amount, row.currency),
    penalty: money(row.penalty_amount, row.currency),
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
  };
}
