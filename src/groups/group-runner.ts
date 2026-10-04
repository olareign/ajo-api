import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { Notifications } from "../notifications/notifications.service.js";
import { BankPulls } from "../payments/bank-pulls.service.js";
import { Scheduler } from "../scheduler/scheduler.service.js";
import { moneyText } from "../savings/money-text.js";
import { GroupLifecycle } from "./group-lifecycle.js";
import { depositRef, GROUP_COLUMNS, potRef, type GroupRow, type Tx } from "./group-model.js";
import {
  DEFAULTER_BLOCK_DAYS,
  RETRY_EVERY_HOURS,
  REMIND_HOURS_BEFORE,
  WAIT_FOR_BANK_MINUTES,
} from "./group-rules.js";
import { TrustService } from "./trust.service.js";

type Contribution = {
  id: string;
  round_no: number;
  member_id: string;
  amount: string;
  attempts: number;
  pull_key: string | null;
  topup_intent_id: string | null;
  due_on: string;
  /** Whole days past the day it was due, where the circle is. */
  days_late: number;
};

type Next =
  { kind: "pull"; key: string; shortfall: bigint; contributionId: string } | { kind: "none" };

/**
 * The clock of every running circle: taking each member's contribution on its day, covering a missed
 * one from the deposit after the grace period, paying each round out, and finishing the circle. Like
 * the savings runner, every pass is safe to repeat and to run twice at once.
 */
@Injectable()
export class GroupRunner implements OnModuleInit {
  private readonly logger = new Logger(GroupRunner.name);

  constructor(
    private readonly db: DataSource,
    private readonly ledger: LedgerService,
    private readonly lifecycle: GroupLifecycle,
    private readonly trust: TrustService,
    private readonly notifications: Notifications,
    private readonly pulls: BankPulls,
    private readonly scheduler: Scheduler,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: "groups",
      run: async () => {
        await this.expireUnfilled();
        await this.closePicking();
        await this.remindUpcoming();
        await this.collectDue();
        await this.payOutReady();
        await this.completeFinished();
      },
    });
  }

  // ---- before the rounds ------------------------------------------------------------------------

  /** A circle still open when its first round is due has not filled in time: it is called off and deposits returned. */
  async expireUnfilled(limit = 50): Promise<number> {
    const due = await this.db.query<{ id: string }[]>(
      `SELECT id FROM groups WHERE status = 'open' AND (now() AT TIME ZONE time_zone)::date >= start_date LIMIT $1`,
      [limit],
    );
    for (const { id } of due) {
      await this.db.transaction(async (tx) => {
        const group = await this.lock(tx, id);
        if (group.status === "open")
          await this.lifecycle.refundAll(tx, group, "It didn't fill before its first round.");
      });
    }
    return due.length;
  }

  /** When picking time is up, anyone who has not picked is given a turn that is left, and the rounds begin. */
  async closePicking(limit = 50): Promise<number> {
    const due = await this.db.query<{ id: string }[]>(
      `SELECT id FROM groups WHERE status = 'picking' AND pick_deadline <= now() LIMIT $1`,
      [limit],
    );
    for (const { id } of due) {
      await this.db.transaction(async (tx) => {
        const group = await this.lock(tx, id);
        if (group.status === "picking") await this.lifecycle.closePicking(tx, group);
      });
    }
    return due.length;
  }

  // ---- reminders ----------------------------------------------------------------------------------

  /** Tells members a day ahead, and the person whose turn it is that their pot is coming. */
  async remindUpcoming(limit = 300): Promise<number> {
    const due = await this.db.query<
      {
        id: string;
        member_id: string;
        name: string;
        currency: string;
        amount: string;
        due_on: string;
        group_id: string;
        round_no: number;
      }[]
    >(
      `SELECT c.id, c.member_id, g.name, g.currency, c.amount::text, r.due_on::text, g.id AS group_id, c.round_no
         FROM group_contributions c JOIN groups g ON g.id = c.group_id
         JOIN group_rounds r ON r.group_id = c.group_id AND r.round_no = c.round_no
        WHERE c.status = 'scheduled' AND g.status = 'running' AND c.attempts = 0
          AND c.next_attempt_at > now() AND c.next_attempt_at <= now() + make_interval(hours => $1::int)
        ORDER BY c.next_attempt_at LIMIT $2`,
      [REMIND_HOURS_BEFORE, limit],
    );
    for (const c of due) {
      const wallet = await this.ledger.userAccount(c.member_id, "available", c.currency);
      const short = BigInt(await this.ledger.balance(wallet)) < BigInt(c.amount);
      await this.notifications.notify(c.member_id, {
        kind: "group.contribution_soon",
        title: `${moneyText(c.amount, c.currency)} is due for ${c.name}`,
        body: short
          ? `Round ${c.round_no} is collected on ${c.due_on}. Your wallet doesn't cover it yet, so add money before then.`
          : `Round ${c.round_no} will be taken from your wallet on ${c.due_on}.`,
        link: short ? "/wallet/add" : `/circles/${c.group_id}`,
        dedupeKey: `contribution:${c.id}:reminder`,
        email: short,
      });
    }
    const turns = await this.db.query<
      {
        recipient_id: string;
        name: string;
        currency: string;
        pot: string;
        due_on: string;
        group_id: string;
        round_no: number;
      }[]
    >(
      `SELECT r.recipient_id, g.name, g.currency, (g.contribution * g.size)::text AS pot, r.due_on::text, g.id AS group_id, r.round_no
         FROM group_rounds r JOIN groups g ON g.id = r.group_id
        WHERE r.status = 'scheduled' AND g.status = 'running'
          AND (r.due_on + make_interval(hours => 8)) AT TIME ZONE g.time_zone > now()
          AND (r.due_on + make_interval(hours => 8)) AT TIME ZONE g.time_zone <= now() + make_interval(hours => $1::int)
        LIMIT $2`,
      [REMIND_HOURS_BEFORE, limit],
    );
    for (const t of turns) {
      await this.notifications.notify(t.recipient_id, {
        kind: "group.your_turn_soon",
        title: `Your turn in ${t.name} is coming`,
        body: `Round ${t.round_no} is collected on ${t.due_on}. ${moneyText(t.pot, t.currency)} is paid out to you once everyone has paid.`,
        link: `/circles/${t.group_id}`,
        dedupeKey: `group:${t.group_id}:turn-soon:${t.round_no}`,
      });
    }
    return due.length + turns.length;
  }

  // ---- collecting ---------------------------------------------------------------------------------

  async collectDue(limit = 200): Promise<number> {
    const tried: string[] = [];
    for (let i = 0; i < limit; i += 1) {
      const [candidate] = await this.db.query<{ id: string; group_id: string }[]>(
        `SELECT c.id, c.group_id FROM group_contributions c JOIN groups g ON g.id = c.group_id
          WHERE c.status = 'scheduled' AND c.next_attempt_at <= now() AND g.status = 'running'
            AND c.id <> ALL($1::uuid[])
          ORDER BY c.next_attempt_at, c.round_no LIMIT 1`,
        [tried],
      );
      if (!candidate) break;
      tried.push(candidate.id);
      try {
        const next = await this.attempt(candidate.group_id, candidate.id);
        if (next.kind === "pull") await this.pull(next);
      } catch (error) {
        this.logger.error(
          `Contribution ${candidate.id} could not be worked on: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    return tried.length;
  }

  private async attempt(groupId: string, contributionId: string): Promise<Next> {
    return this.db.transaction(async (tx): Promise<Next> => {
      // The circle first, always: picking, leaving, swapping, paying out and finishing take this lock first too.
      const group = await this.lock(tx, groupId);
      if (group.status !== "running") return { kind: "none" };
      const [c] = await sql<Contribution>(
        tx,
        `SELECT c.id, c.round_no, c.member_id, c.amount::text, c.attempts, c.pull_key, c.topup_intent_id,
                r.due_on::text AS due_on,
                GREATEST(0, ((now() AT TIME ZONE $2)::date - r.due_on))::int AS days_late
           FROM group_contributions c JOIN group_rounds r ON r.group_id = c.group_id AND r.round_no = c.round_no
          WHERE c.id = $1 AND c.status = 'scheduled' AND c.next_attempt_at <= now() FOR UPDATE OF c`,
        [contributionId, group.time_zone],
      );
      if (!c) return { kind: "none" };

      const amount = BigInt(c.amount);
      const wallet = await this.ledger.userAccount(
        c.member_id,
        "available",
        group.currency,
        undefined,
        tx,
      );
      const balance = BigInt(await this.ledger.balance(wallet, tx));
      if (balance >= amount) {
        await this.collect(tx, group, c, wallet);
        return { kind: "none" };
      }

      const shortfall = amount - balance;
      const overdue = c.days_late > group.grace_days;
      if (c.pull_key && !c.topup_intent_id && !overdue) {
        return { kind: "pull", key: c.pull_key, shortfall, contributionId: c.id };
      }
      if (c.topup_intent_id && !overdue) {
        const [intent] = await sql<{ status: string }>(
          tx,
          `SELECT status FROM payment_intents WHERE id = $1`,
          [c.topup_intent_id],
        );
        if (intent && (intent.status === "pending" || intent.status === "created")) {
          await sql(
            tx,
            `UPDATE group_contributions SET next_attempt_at = now() + make_interval(mins => $2::int), note = 'Waiting for your bank' WHERE id = $1`,
            [c.id, WAIT_FOR_BANK_MINUTES],
          );
          return { kind: "none" };
        }
      }

      if (overdue) {
        await this.coverFromDeposit(tx, group, c);
        return { kind: "none" };
      }

      const passes = c.attempts + 1;
      if (await this.pulls.available(c.member_id)) {
        const key = `group-pull:${c.id}:${passes}`;
        await sql(
          tx,
          `UPDATE group_contributions SET attempts = $2::int, pull_key = $3, topup_intent_id = NULL,
                  next_attempt_at = now() + make_interval(mins => $4::int), note = 'Collecting from your bank' WHERE id = $1`,
          [c.id, passes, key, WAIT_FOR_BANK_MINUTES],
        );
        return { kind: "pull", key, shortfall, contributionId: c.id };
      }
      await sql(
        tx,
        `UPDATE group_contributions SET attempts = $2::int, pull_key = NULL, topup_intent_id = NULL,
                next_attempt_at = now() + make_interval(hours => $3::int), note = 'Not enough in your wallet' WHERE id = $1`,
        [c.id, passes, RETRY_EVERY_HOURS],
      );
      await this.notifications.notify(
        c.member_id,
        {
          kind: "group.contribution_short",
          title: `Add money to your wallet`,
          body: `Your wallet doesn't have ${moneyText(amount, group.currency)} for ${group.name}. We'll try again tomorrow; after ${group.grace_days} ${group.grace_days === 1 ? "day" : "days"} your deposit covers it and your record is marked.`,
          link: "/wallet/add",
          dedupeKey: `contribution:${c.id}:short:${passes}`,
          email: true,
        },
        tx,
      );
      return { kind: "none" };
    });
  }

  /** The contribution is paid from the wallet into the round's pot. On the day it is on time; later, late. */
  private async collect(tx: Tx, group: GroupRow, c: Contribution, wallet: string): Promise<void> {
    const pot = await this.lifecycle.pot(tx, group, c.round_no);
    const posted = await this.ledger.post(
      {
        type: "group_contribution",
        idempotencyKey: `group-contribution:${c.id}`,
        reference: potRef(group.id, c.round_no),
        entries: [
          { accountId: wallet, direction: "debit", amount: c.amount },
          { accountId: pot, direction: "credit", amount: c.amount },
        ],
      },
      {},
      tx,
    );
    const late = c.days_late > 0;
    await sql(
      tx,
      `UPDATE group_contributions SET status = $2, paid_at = now(), ledger_transaction_id = $3, note = NULL WHERE id = $1`,
      [c.id, late ? "late" : "paid", posted.id],
    );
    await this.trust.record(
      tx,
      c.member_id,
      late ? "payment_late" : "payment_on_time",
      `contribution:${c.id}`,
      group.id,
    );
    await this.notifications.notify(
      c.member_id,
      {
        kind: "group.contribution_paid",
        title: `${moneyText(c.amount, group.currency)} paid into ${group.name}`,
        body: `Round ${c.round_no} of ${group.size}${late ? " (a little late)" : ""}.`,
        link: `/circles/${group.id}`,
        dedupeKey: `contribution:${c.id}:paid`,
      },
      tx,
    );
  }

  /**
   * The grace period is over and the wallet is still short: the member's deposit pays the pot so the
   * round can be paid out in full, their record is marked, a late charge (if any) comes out of what is
   * left of the deposit, they cannot join or start circles for a while, and a recovery case is opened.
   */
  private async coverFromDeposit(tx: Tx, group: GroupRow, c: Contribution): Promise<void> {
    const amount = BigInt(c.amount);
    const locked = await this.ledger.userAccount(
      c.member_id,
      "locked",
      group.currency,
      depositRef(group.id),
      tx,
    );
    const held = BigInt(await this.ledger.balance(locked, tx));
    const cover = held < amount ? held : amount;
    if (cover > 0n) {
      const pot = await this.lifecycle.pot(tx, group, c.round_no);
      await this.ledger.post(
        {
          type: "group_deposit_cover",
          idempotencyKey: `group-cover:${c.id}`,
          reference: potRef(group.id, c.round_no),
          entries: [
            { accountId: locked, direction: "debit", amount: cover.toString() },
            { accountId: pot, direction: "credit", amount: cover.toString() },
          ],
        },
        {},
        tx,
      );
    }
    const full = cover === amount;
    await sql(tx, `UPDATE group_contributions SET status = $2, note = $3 WHERE id = $1`, [
      c.id,
      full ? "covered" : "missed",
      full ? "Covered by the deposit" : "Not covered in full",
    ]);
    // A late charge, from what is left of the deposit (never more than is there).
    const fee = (amount * BigInt(group.late_fee_bps)) / 10_000n;
    const left = held - cover;
    const charged = fee < left ? fee : left;
    if (charged > 0n) {
      await this.ledger.post(
        {
          type: "group_late_fee",
          idempotencyKey: `group-late-fee:${c.id}`,
          reference: `group:${group.id}`,
          entries: [
            { accountId: locked, direction: "debit", amount: charged.toString() },
            {
              accountId: await this.ledger.systemAccount("fees", group.currency, "group-late", tx),
              direction: "credit",
              amount: charged.toString(),
            },
          ],
        },
        {},
        tx,
      );
    }
    await this.trust.record(tx, c.member_id, "payment_missed", `contribution:${c.id}`, group.id);
    await this.trust.block(
      tx,
      c.member_id,
      DEFAULTER_BLOCK_DAYS,
      `Missed a payment in ${group.name}`,
    );
    await sql(
      tx,
      `INSERT INTO recovery_cases (group_id, member_id, round_no, amount_owed, covered_by_deposit)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
      [group.id, c.member_id, c.round_no, c.amount, cover.toString()],
    );
    await this.notifications.notify(
      c.member_id,
      {
        kind: "group.payment_missed",
        title: `A payment for ${group.name} was missed`,
        body: `${moneyText(cover, group.currency)} of your deposit paid it, so the round could go ahead.${charged > 0n ? ` A ${moneyText(charged, group.currency)} late charge was taken too.` : ""} You can't join or start a circle for ${DEFAULTER_BLOCK_DAYS} days, and the team will be in touch about what you owe.`,
        link: `/circles/${group.id}`,
        dedupeKey: `contribution:${c.id}:missed`,
        email: true,
      },
      tx,
    );
    await this.notifications.notify(
      group.creator_id,
      {
        kind: "group.member_defaulted",
        title: `A payment in ${group.name} was covered`,
        body: `A member's payment for round ${c.round_no} was missed. Their deposit covered it, so the round will pay out in full.`,
        link: `/circles/${group.id}`,
        dedupeKey: `contribution:${c.id}:creator`,
      },
      tx,
    );
  }

  /** Collects the shortfall from the bank, outside any lock, and notes which payment it is. */
  private async pull(next: Extract<Next, { kind: "pull" }>): Promise<void> {
    const [row] = await this.db.query<{ member_id: string }[]>(
      `SELECT member_id FROM group_contributions WHERE id = $1`,
      [next.contributionId],
    );
    try {
      const started = await this.pulls.start(row!.member_id, next.shortfall.toString(), next.key);
      await this.db.query(
        `UPDATE group_contributions SET topup_intent_id = $2 WHERE id = $1 AND pull_key = $3`,
        [next.contributionId, started.id, next.key],
      );
    } catch (error) {
      await this.db.query(
        `UPDATE group_contributions SET pull_key = NULL WHERE id = $1 AND pull_key = $2`,
        [next.contributionId, next.key],
      );
      throw error;
    }
  }

  // ---- paying out ---------------------------------------------------------------------------------

  /** A round whose every contribution is settled (paid, late, covered or missed) is paid out to its recipient. */
  async payOutReady(limit = 50): Promise<number> {
    const ready = await this.db.query<{ group_id: string; round_no: number }[]>(
      `SELECT r.group_id, r.round_no FROM group_rounds r JOIN groups g ON g.id = r.group_id
        WHERE r.status = 'scheduled' AND g.status = 'running'
          AND NOT EXISTS (SELECT 1 FROM group_contributions c
                           WHERE c.group_id = r.group_id AND c.round_no = r.round_no AND c.status = 'scheduled')
        ORDER BY r.due_on, r.round_no LIMIT $1`,
      [limit],
    );
    for (const { group_id, round_no } of ready) {
      await this.db.transaction(async (tx) => {
        const group = await this.lock(tx, group_id);
        const [round] = await sql<{ recipient_id: string; status: string }>(
          tx,
          `SELECT recipient_id, status FROM group_rounds WHERE group_id = $1 AND round_no = $2 FOR UPDATE`,
          [group_id, round_no],
        );
        if (!round || round.status !== "scheduled" || group.status !== "running") return;
        const [open] = await sql<{ n: string }>(
          tx,
          `SELECT count(*)::text AS n FROM group_contributions WHERE group_id = $1 AND round_no = $2 AND status = 'scheduled'`,
          [group_id, round_no],
        );
        if (Number(open!.n) > 0) return;

        const pot = await this.lifecycle.pot(tx, group, round_no);
        const held = BigInt(await this.ledger.balance(pot, tx));
        const full = BigInt(group.contribution) * BigInt(group.size);
        const fee = (held * BigInt(group.fee_bps)) / 10_000n;
        const net = held - fee;
        if (held > 0n) {
          const wallet = await this.ledger.userAccount(
            round.recipient_id,
            "available",
            group.currency,
            undefined,
            tx,
          );
          const entries = [
            { accountId: pot, direction: "debit" as const, amount: held.toString() },
            ...(net > 0n
              ? [{ accountId: wallet, direction: "credit" as const, amount: net.toString() }]
              : []),
            ...(fee > 0n
              ? [
                  {
                    accountId: await this.ledger.systemAccount(
                      "fees",
                      group.currency,
                      "group-payout",
                      tx,
                    ),
                    direction: "credit" as const,
                    amount: fee.toString(),
                  },
                ]
              : []),
          ];
          await this.ledger.post(
            {
              type: "group_payout",
              idempotencyKey: `group-payout:${group.id}:${round_no}`,
              reference: potRef(group.id, round_no),
              entries,
            },
            {},
            tx,
          );
        }
        await sql(
          tx,
          `UPDATE group_rounds SET status = $3, payout_amount = $4, fee_amount = $5, paid_out_at = now() WHERE group_id = $1 AND round_no = $2`,
          [
            group_id,
            round_no,
            held === full ? "paid_out" : "paid_out_short",
            net.toString(),
            fee.toString(),
          ],
        );
        await this.notifications.notify(
          round.recipient_id,
          {
            kind: "group.payout",
            title: `${moneyText(net, group.currency)} paid out to you`,
            body: `Your turn in ${group.name} (round ${round_no} of ${group.size}) is done. It's in your wallet${fee > 0n ? `, after a ${moneyText(fee, group.currency)} fee` : ""}.`,
            link: `/circles/${group.id}`,
            dedupeKey: `group:${group.id}:payout:${round_no}`,
            email: true,
          },
          tx,
        );
        const others = await sql<{ user_id: string }>(
          tx,
          `SELECT user_id FROM group_members WHERE group_id = $1 AND status = 'active' AND user_id <> $2`,
          [group_id, round.recipient_id],
        );
        for (const o of others) {
          await this.notifications.notify(
            o.user_id,
            {
              kind: "group.round_paid_out",
              title: `Round ${round_no} of ${group.name} is paid out`,
              body: `${round_no} of ${group.size} turns done.`,
              link: `/circles/${group.id}`,
              dedupeKey: `group:${group.id}:round-out:${round_no}`,
            },
            tx,
          );
        }
      });
    }
    return ready.length;
  }

  // ---- finishing ----------------------------------------------------------------------------------

  /** After the last round: deposits are released, a finished circle goes on everyone's record who did not miss, and it is archived. */
  async completeFinished(limit = 50): Promise<number> {
    const done = await this.db.query<{ id: string }[]>(
      `SELECT g.id FROM groups g
        WHERE g.status = 'running' AND NOT EXISTS (SELECT 1 FROM group_rounds r WHERE r.group_id = g.id AND r.status = 'scheduled')
        LIMIT $1`,
      [limit],
    );
    for (const { id } of done) {
      await this.db.transaction(async (tx) => {
        const group = await this.lock(tx, id);
        if (group.status !== "running") return;
        const members = await sql<{ user_id: string; missed: string }>(
          tx,
          `SELECT m.user_id, (SELECT count(*) FROM group_contributions c
                               WHERE c.group_id = m.group_id AND c.member_id = m.user_id AND c.status IN ('covered', 'missed'))::text AS missed
             FROM group_members m WHERE m.group_id = $1 AND m.status = 'active'`,
          [id],
        );
        for (const m of members) {
          await this.lifecycle.refundDeposit(tx, group, m.user_id);
          if (Number(m.missed) === 0)
            await this.trust.record(tx, m.user_id, "group_completed", `group:${id}`, id);
          await this.notifications.notify(
            m.user_id,
            {
              kind: "group.completed",
              title: `${group.name} is complete`,
              body: "Every turn has been paid. Any deposit you had locked is back in your wallet.",
              link: `/circles/${id}`,
              dedupeKey: `group:${id}:completed`,
              email: true,
            },
            tx,
          );
        }
        await sql(
          tx,
          `UPDATE groups SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`,
          [id],
        );
      });
    }
    return done.length;
  }

  private async lock(tx: Tx, id: string): Promise<GroupRow> {
    const [group] = await sql<GroupRow>(
      tx,
      `SELECT ${GROUP_COLUMNS} FROM groups WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!group) throw new Error(`group ${id} is missing`);
    return group;
  }
}
