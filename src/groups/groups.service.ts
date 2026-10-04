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
import { newInviteCode } from "../friends/invites.service.js";
import { currencyFor } from "../kyc/partners.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { Notifications } from "../notifications/notifications.service.js";
import { BankPulls } from "../payments/bank-pulls.service.js";
import { PaymentContext } from "../payments/payment-context.js";
import { coded, requestHash } from "../payments/payment-intents.js";
import { moneyText } from "../savings/money-text.js";
import { todayIn } from "../savings/savings-rules.js";
import { GroupLifecycle } from "./group-lifecycle.js";
import {
  depositRef,
  GROUP_COLUMNS,
  money,
  type GroupRow,
  type MemberRow,
  type Tx,
  MEMBER_COLUMNS,
} from "./group-model.js";
import {
  earlySpots,
  groupProblem,
  isEarly,
  MAX_OPEN_GROUPS,
  potOf,
  roundDates,
  zoneFor,
  type GroupInput,
} from "./group-rules.js";
import { TrustService } from "./trust.service.js";
import type { Trust } from "./trust-rules.js";

export type Summary = {
  id: string;
  name: string;
  community: string | null;
  status: GroupRow["status"];
  currency: string;
  contribution: string;
  frequency: string;
  size: number;
  memberCount: number;
  startDate: string;
  orderMethod: string;
  visibility: string;
  pot: string;
  creator: { username: string | null; displayName: string };
  isMember: boolean;
  isCreator: boolean;
  mySpot: number | null;
  friendsIn: number;
  inviteCode: string | null;
};

type SummaryRow = GroupRow & {
  member_count: number;
  creator_name: string;
  creator_username: string | null;
  is_member: boolean;
  my_spot: number | null;
  friends_in: number;
  fof: number;
  fits: boolean;
};

const FRIENDS_OF = (
  me: string,
) => `SELECT CASE WHEN low_id = ${me} THEN high_id ELSE low_id END AS fid
    FROM friendships WHERE status = 'accepted' AND ${me} IN (low_id, high_id)`;

const SUMMARY_SELECT = `
  SELECT ${GROUP_COLUMNS.split(",")
    .map((c) => `g.${c.trim()}`)
    .join(", ")},
         (SELECT count(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active')::int AS member_count,
         cr.display_name AS creator_name, cr.username::text AS creator_username,
         (me.user_id IS NOT NULL) AS is_member, me.spot AS my_spot,
         (SELECT count(*) FROM group_members fm
           WHERE fm.group_id = g.id AND fm.status = 'active' AND fm.user_id IN (${FRIENDS_OF("$1::uuid")}))::int AS friends_in,
         (SELECT count(*) FROM group_members fm
            JOIN friendships ff ON ff.status = 'accepted' AND fm.user_id IN (ff.low_id, ff.high_id)
           WHERE fm.group_id = g.id AND fm.status = 'active' AND fm.user_id <> $1::uuid
             AND fm.user_id NOT IN (${FRIENDS_OF("$1::uuid")})
             AND (CASE WHEN ff.low_id = fm.user_id THEN ff.high_id ELSE ff.low_id END) IN (${FRIENDS_OF("$1::uuid")}))::int AS fof,
         EXISTS (SELECT 1 FROM savings_plans sp WHERE sp.user_id = $1::uuid AND sp.status IN ('active', 'paused')
                  AND sp.currency = g.currency AND sp.amount BETWEEN g.contribution / 2 AND g.contribution * 2) AS fits
    FROM groups g
    JOIN users cr ON cr.id = g.creator_id
    LEFT JOIN group_members me ON me.group_id = g.id AND me.user_id = $1::uuid AND me.status = 'active'`;

export const cannotJoin = () =>
  coded(HttpStatus.CONFLICT, "You can't join this circle.", "cannot_join");

/** Making, finding, joining and leaving circles. Anything that changes a circle holds its row for the length of the change. */
@Injectable()
export class Groups {
  constructor(
    private readonly db: DataSource,
    private readonly ledger: LedgerService,
    private readonly context: PaymentContext,
    private readonly pulls: BankPulls,
    private readonly trust: TrustService,
    private readonly lifecycle: GroupLifecycle,
    private readonly notifications: Notifications,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ---- before saying yes -------------------------------------------------------------------------

  /** What a circle would look like: the days of every round, the pot, the deposits. Saves nothing. */
  async preview(userId: string, input: GroupInput) {
    const currency = await this.currencyOf(userId);
    this.check(input, currency);
    const contribution = BigInt(input.contribution);
    return {
      dates: roundDates(input.startDate, input.frequency, input.size),
      pot: money(potOf(contribution, input.size), currency),
      fee: money(
        (potOf(contribution, input.size) * BigInt(this.env.GROUP_FEE_BPS)) / 10_000n,
        currency,
      ),
      deposit: money(contribution * BigInt(this.env.GROUP_DEPOSIT_BASE_X), currency),
      earlyDeposit: money(contribution * BigInt(this.env.GROUP_DEPOSIT_EARLY_X), currency),
      earlySpots: earlySpots(input.size),
      graceDays: this.env.GROUP_GRACE_DAYS,
    };
  }

  // ---- making one -------------------------------------------------------------------------------

  async create(userId: string, input: GroupInput, idempotencyKey: string) {
    const currency = await this.currencyOf(userId);
    this.check(input, currency);
    await this.checkEligible(userId);
    const hash = requestHash(
      "group",
      input.name.trim(),
      input.community?.trim() ?? "",
      input.contribution,
      input.frequency,
      input.size,
      input.startDate,
      input.orderMethod,
      input.visibility,
    );
    const contribution = BigInt(input.contribution);

    const id = await this.db.transaction(async (tx) => {
      await sql(tx, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
      const [existing] = await sql<{ id: string; request_hash: string }>(
        tx,
        `SELECT id, request_hash FROM groups WHERE creator_id = $1 AND idempotency_key = $2`,
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
      await this.checkRoom(tx, userId);
      let created: { id: string } | undefined;
      for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
        [created] = await sql<{ id: string }>(
          tx,
          `INSERT INTO groups (creator_id, name, community, currency, contribution, frequency, size, start_date, time_zone,
                               order_method, visibility, invite_code, deposit_base, deposit_early, fee_bps, late_fee_bps,
                               grace_days, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           ON CONFLICT (invite_code) DO NOTHING RETURNING id`,
          [
            userId,
            input.name.trim(),
            input.community?.trim() || null,
            currency,
            input.contribution,
            input.frequency,
            input.size,
            input.startDate,
            zoneFor(currency),
            input.orderMethod,
            input.visibility,
            newInviteCode(),
            (contribution * BigInt(this.env.GROUP_DEPOSIT_BASE_X)).toString(),
            (contribution * BigInt(this.env.GROUP_DEPOSIT_EARLY_X)).toString(),
            this.env.GROUP_FEE_BPS,
            this.env.GROUP_LATE_FEE_BPS,
            this.env.GROUP_GRACE_DAYS,
            idempotencyKey,
            hash,
          ],
        );
      }
      if (!created) throw new Error("could not make an invite code");
      const group = await this.lockGroup(tx, created.id);
      await this.addMember(tx, group, userId);
      return created.id;
    });
    return this.detail(userId, id);
  }

  // ---- looking ----------------------------------------------------------------------------------

  async mine(userId: string): Promise<Summary[]> {
    const rows = await this.db.query<SummaryRow[]>(
      `${SUMMARY_SELECT} WHERE me.user_id IS NOT NULL
        ORDER BY (g.status IN ('open', 'picking', 'running')) DESC, g.start_date`,
      [userId],
    );
    return rows.map((r) => this.summary(r, userId));
  }

  /** Public circles still open, best fit first: friends in them, then friends of friends, then your own savings habits. */
  async discover(userId: string): Promise<(Summary & { score: number })[]> {
    const currency = await this.currencyOf(userId);
    const rows = await this.db.query<SummaryRow[]>(
      `SELECT * FROM (${SUMMARY_SELECT}
        WHERE g.visibility = 'public' AND g.status = 'open' AND g.currency = $2 AND g.start_date > $3::date
          AND me.user_id IS NULL
          AND (SELECT count(*) FROM group_members m WHERE m.group_id = g.id AND m.status = 'active') < g.size
          AND NOT EXISTS (SELECT 1 FROM group_members gm JOIN blocks b
                              ON (b.blocker_id = $1::uuid AND b.blocked_id = gm.user_id) OR (b.blocker_id = gm.user_id AND b.blocked_id = $1::uuid)
                           WHERE gm.group_id = g.id AND gm.status = 'active')) found
        ORDER BY (10 * friends_in + 2 * fof + CASE WHEN fits THEN 3 ELSE 0 END) DESC, start_date, created_at DESC
        LIMIT 30`,
      [userId, currency, todayIn(currency)],
    );
    return rows.map((r) => ({
      ...this.summary(r, userId),
      score: 10 * r.friends_in + 2 * r.fof + (r.fits ? 3 : 0),
    }));
  }

  /** A circle by its invite code, as someone about to join sees it. */
  async byCode(userId: string, code: string): Promise<Summary> {
    const [row] = await this.db.query<SummaryRow[]>(`${SUMMARY_SELECT} WHERE g.invite_code = $2`, [
      userId,
      code.toUpperCase(),
    ]);
    if (!row)
      throw new NotFoundException({
        message: "That invite isn't valid.",
        code: "invite_not_found",
      });
    return this.summary(row, userId);
  }

  async detail(userId: string, id: string) {
    const [row] = await this.db.query<SummaryRow[]>(`${SUMMARY_SELECT} WHERE g.id = $2`, [
      userId,
      id,
    ]);
    if (!row) throw new NotFoundException();
    // A private circle is not visible to anyone who is not in it (they need the code).
    if (!row.is_member && row.visibility === "private") throw new NotFoundException();
    const base = this.summary(row, userId);
    if (!row.is_member)
      return {
        ...base,
        members: [],
        rounds: [],
        draws: [],
        myDeposit: null,
        pickDeadline: null,
        nextDue: null,
        graceDays: row.grace_days,
        rules: this.rules(row),
      };

    const members = await this.db.query<
      {
        user_id: string;
        username: string | null;
        display_name: string;
        spot: number | null;
        join_seq: number;
      }[]
    >(
      `SELECT m.user_id, u.username::text AS username, u.display_name, m.spot, m.join_seq
         FROM group_members m JOIN users u ON u.id = m.user_id
        WHERE m.group_id = $1 AND m.status = 'active' ORDER BY coalesce(m.spot, 1000), m.join_seq`,
      [id],
    );
    const trust = await this.trust.profiles(members.map((m) => m.user_id));
    const rounds = await this.db.query<
      {
        round_no: number;
        due_on: string;
        recipient_id: string;
        status: string;
        payout_amount: string | null;
        fee_amount: string | null;
      }[]
    >(
      `SELECT round_no, due_on::text, recipient_id, status, payout_amount::text, fee_amount::text FROM group_rounds WHERE group_id = $1 ORDER BY round_no`,
      [id],
    );
    const contributions = await this.db.query<
      { round_no: number; member_id: string; status: string }[]
    >(`SELECT round_no, member_id, status FROM group_contributions WHERE group_id = $1`, [id]);
    const draws = await this.db.query<
      { kind: string; seed: string; result: unknown; created_at: Date }[]
    >(
      `SELECT kind, seed, result, created_at FROM group_draws WHERE group_id = $1 ORDER BY created_at`,
      [id],
    );
    const nameOf = new Map(members.map((m) => [m.user_id, m]));
    const locked = await this.ledger.userAccount(userId, "locked", row.currency, depositRef(id));
    const nextDue = rounds.find((r) => r.status === "scheduled");
    const statusIn = (round: number, memberId: string) =>
      contributions.find((c) => c.round_no === round && c.member_id === memberId)?.status ?? null;

    return {
      ...base,
      members: members.map((m) => ({
        username: m.username,
        displayName: m.display_name,
        spot: m.spot,
        isYou: m.user_id === userId,
        isCreator: m.user_id === row.creator_id,
        trust: publicTrust(trust.get(m.user_id)),
        current: nextDue ? statusIn(nextDue.round_no, m.user_id) : null,
      })),
      rounds: rounds.map((r) => ({
        roundNo: r.round_no,
        dueOn: r.due_on,
        recipient: nameOf.get(r.recipient_id)?.username ?? null,
        recipientName: nameOf.get(r.recipient_id)?.display_name ?? "",
        isYours: r.recipient_id === userId,
        status: r.status,
        payout: r.payout_amount === null ? null : money(r.payout_amount, row.currency),
        fee: r.fee_amount === null ? null : money(r.fee_amount, row.currency),
        paid: contributions.filter(
          (c) => c.round_no === r.round_no && ["paid", "late", "covered"].includes(c.status),
        ).length,
        yours: statusIn(r.round_no, userId),
        board: members.map((m) => ({
          username: m.username,
          displayName: m.display_name,
          status: statusIn(r.round_no, m.user_id),
        })),
      })),
      draws: draws.map((d) => ({
        kind: d.kind,
        seed: d.seed,
        createdAt: d.created_at.toISOString(),
        order: Array.isArray(d.result)
          ? (d.result as (string | { id: string; spot: number })[]).map((x) => {
              const uid = typeof x === "string" ? x : x.id;
              return {
                spot: typeof x === "string" ? null : x.spot,
                username: nameOf.get(uid)?.username ?? null,
                displayName: nameOf.get(uid)?.display_name ?? "",
              };
            })
          : [],
      })),
      myDeposit: money(await this.ledger.balance(locked), row.currency),
      pickDeadline: row.pick_deadline ? row.pick_deadline.toISOString() : null,
      nextDue: nextDue ? { roundNo: nextDue.round_no, dueOn: nextDue.due_on } : null,
      graceDays: row.grace_days,
      rules: this.rules(row),
    };
  }

  // ---- joining and leaving -----------------------------------------------------------------------

  /** Joins by invite code, or (for a public circle) by id. The last place taken starts the circle. */
  async join(userId: string, target: { code?: string; id?: string }) {
    await this.checkEligible(userId);
    const id = await this.db.transaction(async (tx) => {
      const [found] = target.code
        ? await sql<{ id: string; visibility: string }>(
            tx,
            `SELECT id, visibility FROM groups WHERE invite_code = $1`,
            [target.code.toUpperCase()],
          )
        : await sql<{ id: string; visibility: string }>(
            tx,
            `SELECT id, visibility FROM groups WHERE id = $1`,
            [target.id],
          );
      // Private circles can only be reached with their code.
      if (!found || (!target.code && found.visibility !== "public")) {
        throw new NotFoundException({
          message: "That circle isn't there.",
          code: "group_not_found",
        });
      }
      const group = await this.lockGroup(tx, found.id);
      await this.addMember(tx, group, userId);
      return group.id;
    });
    return this.detail(userId, id);
  }

  /** Leaves before the circle fills, and gets the deposit back. The person who made it cancels instead. */
  async leave(userId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const group = await this.lockGroup(tx, id);
      const [member] = await sql<MemberRow>(
        tx,
        `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_id = $1 AND user_id = $2`,
        [id, userId],
      );
      if (!member || member.status === "left") return;
      if (group.status !== "open") {
        throw coded(
          HttpStatus.CONFLICT,
          "You can't leave once the circle is full.",
          "group_locked",
        );
      }
      if (group.creator_id === userId) {
        throw coded(
          HttpStatus.CONFLICT,
          "You made this circle, so call it off instead of leaving.",
          "creator_cannot_leave",
        );
      }
      await this.lifecycle.refundDeposit(tx, group, userId);
      await sql(
        tx,
        `UPDATE group_members SET status = 'left', left_at = now(), spot = NULL WHERE group_id = $1 AND user_id = $2`,
        [id, userId],
      );
      await this.notifications.notify(
        group.creator_id,
        {
          kind: "group.left",
          title: `Someone left ${group.name}`,
          body: "A place is open again.",
          link: `/circles/${id}`,
          dedupeKey: `group:${id}:left:${userId}:${member.join_seq}`,
        },
        tx,
      );
    });
    // No longer a member, so what is shown is what any outsider sees: a private circle only by its code.
    const [after] = await this.db.query<SummaryRow[]>(`${SUMMARY_SELECT} WHERE g.id = $2`, [
      userId,
      id,
    ]);
    return this.summary(after!, userId);
  }

  /** Calls off a circle that has not filled: everyone is told and every deposit is returned. */
  async cancel(userId: string, id: string) {
    await this.db.transaction(async (tx) => {
      const group = await this.lockGroup(tx, id);
      if (group.creator_id !== userId) throw new NotFoundException();
      if (group.status === "cancelled") return;
      if (group.status !== "open") {
        throw coded(
          HttpStatus.CONFLICT,
          "A circle that is full can't be called off.",
          "group_locked",
        );
      }
      await this.lifecycle.refundAll(tx, group, "The person who made it called it off.");
    });
    return this.detail(userId, id);
  }

  /** Tells a friend about a circle, with a way in. Only members, only for a circle still open, only to friends. */
  async inviteFriend(userId: string, id: string, username: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const group = await this.lockGroup(tx, id);
      const [me] = await sql<{ display_name: string }>(
        tx,
        `SELECT u.display_name FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
        [id, userId],
      );
      if (!me) throw new NotFoundException();
      if (group.status !== "open") {
        throw coded(HttpStatus.CONFLICT, "This circle is no longer taking people.", "group_locked");
      }
      const [friend] = await sql<{ id: string }>(
        tx,
        `SELECT u.id FROM users u JOIN friendships f ON f.status = 'accepted'
                AND f.low_id = least(u.id, $1::uuid) AND f.high_id = greatest(u.id, $1::uuid)
          WHERE u.username = $2 AND u.status = 'active'`,
        [userId, username.replace(/^@/, "").toLowerCase()],
      );
      if (!friend)
        throw coded(HttpStatus.NOT_FOUND, "You can only invite your friends.", "not_a_friend");
      await this.notifications.notify(
        friend.id,
        {
          kind: "group.invite",
          title: `${me.display_name} invited you to ${group.name}`,
          body: `${moneyText(group.contribution, group.currency)} ${group.frequency}, ${group.size} people.`,
          link: `/circles/join/${group.invite_code}`,
          dedupeKey: `group:${id}:invite:${friend.id}`,
        },
        tx,
      );
    });
  }

  // ---- helpers ----------------------------------------------------------------------------------

  /** Takes the circle's row for the rest of the transaction. */
  async lockGroup(tx: Tx, id: string): Promise<GroupRow> {
    const [group] = await sql<GroupRow>(
      tx,
      `SELECT ${GROUP_COLUMNS} FROM groups WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!group) throw new NotFoundException();
    return group;
  }

  /** Puts a person in a place, locking their deposit if they are not yet trusted; the last place fills the circle. */
  async addMember(tx: Tx, group: GroupRow, userId: string): Promise<void> {
    if (group.status !== "open")
      throw coded(HttpStatus.CONFLICT, "This circle is no longer taking people.", "group_locked");
    if (group.start_date <= todayIn(group.currency)) {
      throw coded(
        HttpStatus.CONFLICT,
        "The first round is today or past, so this circle is closed.",
        "group_locked",
      );
    }
    // A person cannot be put in with someone who has blocked them, or whom they have blocked.
    const [clash] = await sql<{ n: string }>(
      tx,
      `SELECT count(*)::text AS n FROM group_members gm JOIN blocks b
              ON (b.blocker_id = $2 AND b.blocked_id = gm.user_id) OR (b.blocker_id = gm.user_id AND b.blocked_id = $2)
        WHERE gm.group_id = $1 AND gm.status = 'active'`,
      [group.id, userId],
    );
    if (Number(clash!.n) > 0) throw cannotJoin();
    await this.checkRoom(tx, userId, group.id);

    const [mine] = await sql<MemberRow>(
      tx,
      `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [group.id, userId],
    );
    if (mine?.status === "active") return;
    const [count] = await sql<{ n: string; next: string }>(
      tx,
      `SELECT count(*) FILTER (WHERE status = 'active')::text AS n, (coalesce(max(join_seq), 0) + 1)::text AS next
         FROM group_members WHERE group_id = $1`,
      [group.id],
    );
    if (Number(count!.n) >= group.size)
      throw coded(HttpStatus.CONFLICT, "This circle is full.", "group_full");

    const trusted = (await this.trust.profile(userId, tx)).trusted;
    const deposit = trusted ? 0n : BigInt(group.deposit_base);
    if (deposit > 0n) {
      const wallet = await this.ledger.userAccount(
        userId,
        "available",
        group.currency,
        undefined,
        tx,
      );
      if (BigInt(await this.ledger.balance(wallet, tx)) < deposit) {
        throw coded(
          HttpStatus.CONFLICT,
          `You need ${moneyText(deposit, group.currency)} in your wallet to lock as a deposit until the circle ends.`,
          "deposit_needed",
        );
      }
      const locked = await this.ledger.userAccount(
        userId,
        "locked",
        group.currency,
        depositRef(group.id),
        tx,
      );
      await this.ledger.post(
        {
          type: "group_deposit",
          idempotencyKey: `group-deposit:${group.id}:${userId}:${count!.next}`,
          reference: `group:${group.id}`,
          entries: [
            { accountId: wallet, direction: "debit", amount: deposit.toString() },
            { accountId: locked, direction: "credit", amount: deposit.toString() },
          ],
        },
        {},
        tx,
      );
    }
    if (mine) {
      await sql(
        tx,
        `UPDATE group_members SET status = 'active', join_seq = $3, deposit_required = $4, left_at = NULL, joined_at = now(), spot = NULL
          WHERE group_id = $1 AND user_id = $2`,
        [group.id, userId, count!.next, deposit.toString()],
      );
    } else {
      await sql(
        tx,
        `INSERT INTO group_members (group_id, user_id, join_seq, deposit_required) VALUES ($1, $2, $3, $4)`,
        [group.id, userId, count!.next, deposit.toString()],
      );
    }
    if (userId !== group.creator_id) {
      const [who] = await sql<{ display_name: string }>(
        tx,
        `SELECT display_name FROM users WHERE id = $1`,
        [userId],
      );
      await this.notifications.notify(
        group.creator_id,
        {
          kind: "group.joined",
          title: `${who!.display_name} joined ${group.name}`,
          body: `${Number(count!.n) + 1} of ${group.size} places are taken.`,
          link: `/circles/${group.id}`,
          dedupeKey: `group:${group.id}:joined:${userId}:${count!.next}`,
        },
        tx,
      );
    }
    if (Number(count!.n) + 1 === group.size) await this.lifecycle.fill(tx, group);
  }

  private async checkEligible(userId: string): Promise<void> {
    if (await this.trust.isBlocked(userId)) {
      throw coded(
        HttpStatus.FORBIDDEN,
        "You can't join or start a circle for now, because of a payment that wasn't made.",
        "defaulter_blocked",
      );
    }
    if (this.env.GROUP_REQUIRES_MANDATE && !(await this.pulls.available(userId))) {
      throw coded(
        HttpStatus.CONFLICT,
        "Set up auto-debit first: circles collect each round from your bank.",
        "no_mandate",
      );
    }
  }

  private async checkRoom(tx: Tx, userId: string, except?: string): Promise<void> {
    const [row] = await sql<{ n: string }>(
      tx,
      `SELECT count(*)::text AS n FROM group_members m JOIN groups g ON g.id = m.group_id
        WHERE m.user_id = $1 AND m.status = 'active' AND g.status IN ('open', 'picking', 'running')
          AND ($2::uuid IS NULL OR g.id <> $2::uuid)`,
      [userId, except ?? null],
    );
    if (Number(row!.n) >= MAX_OPEN_GROUPS) {
      throw coded(
        HttpStatus.CONFLICT,
        `You can be in up to ${MAX_OPEN_GROUPS} circles at once.`,
        "too_many_groups",
      );
    }
  }

  private async currencyOf(userId: string): Promise<string> {
    const person = await this.context.person(userId);
    const currency = currencyFor(person.country);
    if (!currency)
      throw coded(HttpStatus.CONFLICT, "Choose your country first.", "country_required");
    return currency;
  }

  private check(input: GroupInput, currency: string): void {
    const problem = groupProblem(input, currency, todayIn(currency));
    if (problem) throw new BadRequestException({ message: problem, code: "group_invalid" });
  }

  private rules(row: GroupRow) {
    return {
      deposit: money(row.deposit_base, row.currency),
      earlyDeposit: money(row.deposit_early, row.currency),
      earlySpots: earlySpots(row.size),
      feeBps: row.fee_bps,
      lateFeeBps: row.late_fee_bps,
      graceDays: row.grace_days,
    };
  }

  private summary(row: SummaryRow, userId: string): Summary {
    return {
      id: row.id,
      name: row.name,
      community: row.community,
      status: row.status,
      currency: row.currency,
      contribution: row.contribution,
      frequency: row.frequency,
      size: row.size,
      memberCount: row.member_count,
      startDate: row.start_date,
      orderMethod: row.order_method,
      visibility: row.visibility,
      pot: potOf(BigInt(row.contribution), row.size).toString(),
      creator: { username: row.creator_username, displayName: row.creator_name },
      isMember: row.is_member,
      isCreator: row.creator_id === userId,
      mySpot: row.my_spot,
      friendsIn: row.friends_in,
      inviteCode: row.is_member ? row.invite_code : null,
    };
  }

  /** Whether this person can take an early turn without the larger deposit (they are trusted). */
  isEarlyFor(spot: number, size: number): boolean {
    return isEarly(spot, size);
  }
}

/** What the rest of the circle may know about someone's trust: the level and score, nothing of the record. */
export function publicTrust(t: Trust | undefined) {
  return { level: t?.level ?? "new", score: t?.score ?? 0 };
}
