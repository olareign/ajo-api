import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { Notifications } from "../notifications/notifications.service.js";
import { BankPulls } from "../payments/bank-pulls.service.js";
import { Scheduler } from "../scheduler/scheduler.service.js";
import { moneyText } from "./money-text.js";
import { PLAN_COLUMNS, planRef, type PlanRow } from "./savings.service.js";
import {
  GIVE_UP_AFTER_DAYS,
  MAX_FAILED_PASSES,
  REMIND_HOURS_BEFORE,
  RETRY_EVERY_HOURS,
  WAIT_FOR_BANK_MINUTES,
  zoneFor,
} from "./savings-rules.js";

type Tx = Parameters<typeof sql>[0];

type DebitRow = {
  id: string;
  seq: number;
  due_on: string;
  attempts: number;
  pull_key: string | null;
  topup_intent_id: string | null;
  overdue: boolean;
};

/** What to do after the plan's transaction has committed (talking to a partner never happens inside one). */
type Next = { kind: "pull"; key: string; shortfall: bigint; debitId: string } | { kind: "none" };

/**
 * Takes each saving plan's debits when they fall due, and ends plans that have run their course. Every
 * pass is safe to repeat and to run twice at once: a plan is locked while its debit is worked on, the
 * ledger posting has a key made from the debit, and a debit that is already settled is skipped.
 */
@Injectable()
export class SavingsRunner implements OnModuleInit {
  private readonly logger = new Logger(SavingsRunner.name);

  constructor(
    private readonly db: DataSource,
    private readonly ledger: LedgerService,
    private readonly notifications: Notifications,
    private readonly pulls: BankPulls,
    private readonly scheduler: Scheduler,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: "savings",
      run: async () => {
        await this.remindUpcoming();
        await this.runDue();
        await this.matureFinished();
      },
    });
  }

  // ---- taking debits ------------------------------------------------------------------------------

  /** Works through every debit that is due, one at a time. Returns how many it looked at. */
  async runDue(limit = 100): Promise<number> {
    const tried: string[] = [];
    for (let i = 0; i < limit; i += 1) {
      const [candidate] = await this.db.query<{ id: string; plan_id: string }[]>(
        `SELECT d.id, d.plan_id FROM savings_debits d JOIN savings_plans p ON p.id = d.plan_id
          WHERE d.status = 'scheduled' AND d.next_attempt_at <= now() AND p.status = 'active'
            AND d.id <> ALL($1::uuid[])
          ORDER BY d.next_attempt_at, d.seq LIMIT 1`,
        [tried],
      );
      if (!candidate) break;
      tried.push(candidate.id);
      try {
        const next = await this.attempt(candidate.plan_id, candidate.id);
        if (next.kind === "pull") await this.pull(next);
      } catch (error) {
        // One debit failing must not stop the others; it is tried again on the next pass.
        this.logger.error(
          `Debit ${candidate.id} could not be worked on: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    return tried.length;
  }

  private async attempt(planId: string, debitId: string): Promise<Next> {
    return this.db.transaction(async (tx): Promise<Next> => {
      // The plan first, always: ending, pausing, topping up and maturing take this same lock first.
      const [plan] = await sql<PlanRow>(
        tx,
        `SELECT ${PLAN_COLUMNS} FROM savings_plans WHERE id = $1 FOR UPDATE`,
        [planId],
      );
      if (!plan || plan.status !== "active") return { kind: "none" };
      const [debit] = await sql<DebitRow>(
        tx,
        `SELECT id, seq, due_on::text, attempts, pull_key, topup_intent_id,
                ((now() AT TIME ZONE $3)::date > due_on + $2::int) AS overdue
           FROM savings_debits
          WHERE id = $1 AND status = 'scheduled' AND next_attempt_at <= now() FOR UPDATE`,
        [debitId, GIVE_UP_AFTER_DAYS, zoneFor(plan.currency)],
      );
      // Settled or moved on while we waited for the lock.
      if (!debit) return { kind: "none" };

      const wallet = await this.ledger.userAccount(
        plan.user_id,
        "available",
        plan.currency,
        undefined,
        tx,
      );
      const saved = await this.ledger.userAccount(
        plan.user_id,
        "savings",
        plan.currency,
        planRef(plan.id),
        tx,
      );
      const balance = BigInt(await this.ledger.balance(wallet, tx));
      const amount = BigInt(plan.amount);

      if (balance >= amount) {
        const posted = await this.ledger.post(
          {
            type: "savings_debit",
            idempotencyKey: `savings-debit:${debit.id}`,
            reference: planRef(plan.id),
            entries: [
              { accountId: wallet, direction: "debit", amount: amount.toString() },
              { accountId: saved, direction: "credit", amount: amount.toString() },
            ],
          },
          {},
          tx,
        );
        await sql(
          tx,
          `UPDATE savings_debits SET status = 'paid', paid_at = now(), ledger_transaction_id = $2, note = NULL WHERE id = $1`,
          [debit.id, posted.id],
        );
        await this.notifications.notify(
          plan.user_id,
          {
            kind: "plan.debit_paid",
            title: `${moneyText(amount, plan.currency)} saved`,
            body: `Debit ${debit.seq} of ${plan.total_debits} for ${plan.name} was taken from your wallet.`,
            link: `/save/${plan.id}`,
            dedupeKey: `debit:${debit.id}:paid`,
          },
          tx,
        );
        await this.matureIfFinished(tx, plan);
        return { kind: "none" };
      }

      const shortfall = amount - balance;
      // A collection from the bank was started but we did not get to note it: finish noting it.
      if (debit.pull_key && !debit.topup_intent_id) {
        return { kind: "pull", key: debit.pull_key, shortfall, debitId: debit.id };
      }
      if (debit.topup_intent_id) {
        const [intent] = await sql<{ status: string }>(
          tx,
          `SELECT status FROM payment_intents WHERE id = $1`,
          [debit.topup_intent_id],
        );
        if (
          intent &&
          (intent.status === "pending" || intent.status === "created") &&
          !debit.overdue
        ) {
          // The bank is still collecting: look again soon. This is waiting, not failing.
          await sql(
            tx,
            `UPDATE savings_debits SET next_attempt_at = now() + make_interval(mins => $2::int),
                    note = 'Waiting for your bank' WHERE id = $1`,
            [debit.id, WAIT_FOR_BANK_MINUTES],
          );
          return { kind: "none" };
        }
      }

      // Nothing in flight, and the wallet is short: this pass counts as a miss.
      const passes = debit.attempts + 1;
      if (passes > MAX_FAILED_PASSES || debit.overdue) {
        await sql(
          tx,
          `UPDATE savings_debits SET status = 'failed', attempts = $2::int,
                  note = 'Not enough in your wallet' WHERE id = $1`,
          [debit.id, passes],
        );
        await this.notifications.notify(
          plan.user_id,
          {
            kind: "plan.debit_missed",
            title: `A saving was missed`,
            body: `We couldn't take ${moneyText(amount, plan.currency)} for ${plan.name} (debit ${debit.seq}). It has been skipped; add money to your wallet so the next one goes through.`,
            link: `/save/${plan.id}`,
            dedupeKey: `debit:${debit.id}:missed`,
            email: true,
          },
          tx,
        );
        await this.matureIfFinished(tx, plan);
        return { kind: "none" };
      }

      const canPull = plan.topup_from_bank && (await this.pulls.available(plan.user_id));
      if (canPull) {
        const key = `plan-debit:${debit.id}:${passes}`;
        await sql(
          tx,
          `UPDATE savings_debits SET attempts = $2::int, pull_key = $3, topup_intent_id = NULL,
                  next_attempt_at = now() + make_interval(mins => $4::int), note = 'Collecting from your bank'
            WHERE id = $1`,
          [debit.id, passes, key, WAIT_FOR_BANK_MINUTES],
        );
        return { kind: "pull", key, shortfall, debitId: debit.id };
      }
      await sql(
        tx,
        `UPDATE savings_debits SET attempts = $2::int, pull_key = NULL, topup_intent_id = NULL,
                next_attempt_at = now() + make_interval(hours => $3::int), note = 'Not enough in your wallet'
          WHERE id = $1`,
        [debit.id, passes, RETRY_EVERY_HOURS],
      );
      await this.notifications.notify(
        plan.user_id,
        {
          kind: "plan.debit_short",
          title: `Add money to your wallet`,
          body: `Your wallet doesn't have ${moneyText(amount, plan.currency)} for ${plan.name}. We'll try again tomorrow, so add money before then.`,
          link: `/wallet/add`,
          dedupeKey: `debit:${debit.id}:short:${passes}`,
          email: true,
        },
        tx,
      );
      return { kind: "none" };
    });
  }

  /** Collects the shortfall from the bank, outside any plan lock, and notes which payment it is. */
  private async pull(next: Extract<Next, { kind: "pull" }>): Promise<void> {
    const [owner] = await this.db.query<{ user_id: string }[]>(
      `SELECT p.user_id FROM savings_debits d JOIN savings_plans p ON p.id = d.plan_id WHERE d.id = $1`,
      [next.debitId],
    );
    try {
      const started = await this.pulls.start(owner!.user_id, next.shortfall.toString(), next.key);
      await this.db.query(
        `UPDATE savings_debits SET topup_intent_id = $2 WHERE id = $1 AND pull_key = $3`,
        [next.debitId, started.id, next.key],
      );
    } catch (error) {
      // Nothing was collected (no auto-debit any more, partner off): count it as an ordinary miss next time.
      await this.db.query(
        `UPDATE savings_debits SET pull_key = NULL WHERE id = $1 AND pull_key = $2`,
        [next.debitId, next.key],
      );
      throw error;
    }
  }

  // ---- reminders ----------------------------------------------------------------------------------

  /** Tells people a day ahead, and says so plainly (and by email) when their wallet will not cover it. */
  async remindUpcoming(limit = 200): Promise<number> {
    const due = await this.db.query<
      {
        id: string;
        seq: number;
        due_on: string;
        user_id: string;
        name: string;
        currency: string;
        amount: string;
        plan_id: string;
        total: number;
      }[]
    >(
      `SELECT d.id, d.seq, d.due_on::text, p.user_id, p.name, p.currency, p.amount::text, p.id AS plan_id, p.total_debits AS total
         FROM savings_debits d JOIN savings_plans p ON p.id = d.plan_id
        WHERE d.status = 'scheduled' AND p.status = 'active' AND d.attempts = 0
          AND d.next_attempt_at > now() AND d.next_attempt_at <= now() + make_interval(hours => $1::int)
        ORDER BY d.next_attempt_at LIMIT $2`,
      [REMIND_HOURS_BEFORE, limit],
    );
    for (const d of due) {
      const wallet = await this.ledger.userAccount(d.user_id, "available", d.currency);
      const short = BigInt(await this.ledger.balance(wallet)) < BigInt(d.amount);
      await this.notifications.notify(d.user_id, {
        kind: "plan.debit_soon",
        title: `${moneyText(d.amount, d.currency)} is due for ${d.name}`,
        body: short
          ? `Debit ${d.seq} of ${d.total} is due on ${d.due_on}. Your wallet doesn't cover it yet, so add money before then.`
          : `Debit ${d.seq} of ${d.total} will be taken from your wallet on ${d.due_on}.`,
        link: short ? "/wallet/add" : `/save/${d.plan_id}`,
        dedupeKey: `debit:${d.id}:reminder`,
        email: short,
      });
    }
    return due.length;
  }

  // ---- maturity -----------------------------------------------------------------------------------

  /** Ends any plan with nothing left to take, in case the last debit was settled some other way. */
  async matureFinished(limit = 50): Promise<number> {
    const ready = await this.db.query<{ id: string }[]>(
      `SELECT p.id FROM savings_plans p
        WHERE p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM savings_debits d WHERE d.plan_id = p.id AND d.status = 'scheduled')
        LIMIT $1`,
      [limit],
    );
    for (const { id } of ready) {
      await this.db.transaction(async (tx) => {
        const [plan] = await sql<PlanRow>(
          tx,
          `SELECT ${PLAN_COLUMNS} FROM savings_plans WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (plan) await this.matureIfFinished(tx, plan);
      });
    }
    return ready.length;
  }

  /**
   * When every debit has been settled (paid, missed or skipped), moves what is saved back to the
   * wallet and closes the plan. The posting's key is made from the plan, so it can only happen once.
   */
  private async matureIfFinished(tx: Tx, plan: PlanRow): Promise<void> {
    if (plan.status !== "active") return;
    const [left] = await sql<{ n: string }>(
      tx,
      `SELECT count(*)::text AS n FROM savings_debits WHERE plan_id = $1 AND status = 'scheduled'`,
      [plan.id],
    );
    if (Number(left!.n) > 0) return;
    const wallet = await this.ledger.userAccount(
      plan.user_id,
      "available",
      plan.currency,
      undefined,
      tx,
    );
    const saved = await this.ledger.userAccount(
      plan.user_id,
      "savings",
      plan.currency,
      planRef(plan.id),
      tx,
    );
    const balance = BigInt(await this.ledger.balance(saved, tx));
    if (balance > 0n) {
      await this.ledger.post(
        {
          type: "savings_maturity",
          idempotencyKey: `savings-maturity:${plan.id}`,
          reference: planRef(plan.id),
          entries: [
            { accountId: saved, direction: "debit", amount: balance.toString() },
            { accountId: wallet, direction: "credit", amount: balance.toString() },
          ],
        },
        {},
        tx,
      );
    }
    await sql(
      tx,
      `UPDATE savings_plans SET status = 'completed', closed_at = now(), payout_amount = $2, updated_at = now() WHERE id = $1`,
      [plan.id, balance.toString()],
    );
    await this.notifications.notify(
      plan.user_id,
      {
        kind: "plan.matured",
        title: `${plan.name} is complete`,
        body:
          balance > 0n
            ? `${moneyText(balance, plan.currency)} is now in your wallet. You can keep it there or withdraw it to your bank.`
            : "The plan has ended. Nothing was saved, so there is nothing to pay out.",
        link: `/save/${plan.id}`,
        dedupeKey: `plan:${plan.id}:matured`,
        email: true,
      },
      tx,
    );
  }
}
