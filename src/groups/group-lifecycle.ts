import { Inject, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { LedgerService } from "../ledger/ledger.service.js";
import { Notifications } from "../notifications/notifications.service.js";
import { newSeed, placeLeftovers, placeMembers, type DrawMember } from "./draw.js";
import {
  depositRef,
  GROUP_COLUMNS,
  MEMBER_COLUMNS,
  money,
  potRef,
  type GroupRow,
  type MemberRow,
  type Tx,
} from "./group-model.js";
import { COLLECT_HOUR, earlySpots, PICK_WINDOW_HOURS, roundDates } from "./group-rules.js";
import { moneyText } from "../savings/money-text.js";
import { TrustService } from "./trust.service.js";

export { money };

type Placed = { id: string; spot: number };

/**
 * What happens when a circle fills: who takes which turn (by the order of joining, a draw anyone can
 * check, or each member picking), the larger deposit an untrusted member must lock to take an early
 * turn, and the start of the rounds. Everything here runs inside the transaction that holds the
 * group's row, so two people filling the last place at once cannot both start it.
 */
@Injectable()
export class GroupLifecycle {
  constructor(
    private readonly ledger: LedgerService,
    private readonly trust: TrustService,
    private readonly notifications: Notifications,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Called when the last place is taken. */
  async fill(tx: Tx, group: GroupRow): Promise<void> {
    await sql(tx, `UPDATE groups SET locked_at = now(), updated_at = now() WHERE id = $1`, [
      group.id,
    ]);
    const members = await this.activeMembers(tx, group.id);
    const profiles = await this.trust.profiles(
      members.map((m) => m.user_id),
      tx,
    );
    const people: DrawMember[] = members.map((m) => ({
      id: m.user_id,
      trusted: profiles.get(m.user_id)?.trusted === true,
    }));

    if (group.order_method === "pick") {
      await sql(
        tx,
        `UPDATE groups SET status = 'picking', pick_deadline = now() + make_interval(hours => $2::int), updated_at = now() WHERE id = $1`,
        [group.id, PICK_WINDOW_HOURS],
      );
      await this.tell(tx, members, group, {
        kind: "group.picking",
        title: `${group.name} is full: pick your turn`,
        body: `Everyone can pick a turn for the next ${PICK_WINDOW_HOURS} hours. Anyone who hasn't picked is given one that's left.`,
        key: "picking",
      });
      return;
    }

    let order: string[];
    if (group.order_method === "join_order") {
      order = members.map((m) => m.user_id);
    } else {
      const seed = newSeed();
      order = placeMembers(people, earlySpots(group.size), seed);
      await sql(
        tx,
        `INSERT INTO group_draws (group_id, kind, seed, input, result) VALUES ($1, 'random', $2, $3, $4)`,
        [
          group.id,
          seed,
          JSON.stringify({ early: earlySpots(group.size), members: people }),
          JSON.stringify(order),
        ],
      );
    }
    const placed = await this.settleDeposits(
      tx,
      group,
      order.map((id, i) => ({ id, spot: i + 1 })),
      new Map(people.map((p) => [p.id, p.trusted])),
    );
    for (const { id, spot } of placed) {
      await sql(tx, `UPDATE group_members SET spot = $3 WHERE group_id = $1 AND user_id = $2`, [
        group.id,
        id,
        spot,
      ]);
    }
    await this.start(tx, group);
  }

  /** The members nobody picked for are given the turns that are left, then the rounds begin. */
  async closePicking(tx: Tx, group: GroupRow): Promise<void> {
    const members = await this.activeMembers(tx, group.id);
    const taken = new Set(members.filter((m) => m.spot !== null).map((m) => m.spot!));
    const open = Array.from({ length: group.size }, (_, i) => i + 1).filter((s) => !taken.has(s));
    const waiting = members.filter((m) => m.spot === null);
    if (waiting.length > 0) {
      const profiles = await this.trust.profiles(
        waiting.map((m) => m.user_id),
        tx,
      );
      const people = waiting.map((m) => ({
        id: m.user_id,
        trusted: profiles.get(m.user_id)?.trusted === true,
      }));
      const seed = newSeed();
      const placed = placeLeftovers(open, people, earlySpots(group.size), seed);
      await sql(
        tx,
        `INSERT INTO group_draws (group_id, kind, seed, input, result) VALUES ($1, 'pick_leftover', $2, $3, $4)`,
        [
          group.id,
          seed,
          JSON.stringify({ early: earlySpots(group.size), open, waiting: people }),
          JSON.stringify(placed),
        ],
      );
      const all = [
        ...members.filter((m) => m.spot !== null).map((m) => ({ id: m.user_id, spot: m.spot! })),
        ...placed,
      ];
      const trustedMap = new Map(people.map((p) => [p.id, p.trusted]));
      for (const m of members)
        if (m.spot !== null)
          trustedMap.set(m.user_id, (await this.trust.profile(m.user_id, tx)).trusted);
      const settled = await this.settleDeposits(
        tx,
        group,
        all,
        trustedMap,
        new Set(placed.map((p) => p.id)),
      );
      for (const { id, spot } of settled) {
        await sql(tx, `UPDATE group_members SET spot = $3 WHERE group_id = $1 AND user_id = $2`, [
          group.id,
          id,
          spot,
        ]);
      }
    }
    await this.start(tx, group);
  }

  /**
   * An untrusted member in an early turn must hold the larger deposit. The difference is taken from their
   * wallet now; if the wallet cannot cover it they swap turns with someone in a later place (the first who
   * can take an early turn), so a circle never starts with an early turn held on the small deposit when
   * anyone could hold it. Only the ids in `movable` may be swapped out of the way (default: all).
   */
  private async settleDeposits(
    tx: Tx,
    group: GroupRow,
    placed: Placed[],
    trusted: ReadonlyMap<string, boolean>,
    movable?: ReadonlySet<string>,
  ): Promise<Placed[]> {
    const early = earlySpots(group.size);
    const spots = new Map(placed.map((p) => [p.id, p.spot]));
    const required = new Map<string, bigint>();
    for (const m of await this.activeMembers(tx, group.id))
      required.set(m.user_id, BigInt(m.deposit_required));

    const tryCover = async (id: string): Promise<boolean> => {
      if (trusted.get(id) === true) return true;
      const covered = await this.coverEarly(tx, group, id, false);
      if (covered) required.set(id, BigInt(group.deposit_early));
      return covered;
    };

    const byId = (spot: number) => [...spots].find(([, s]) => s === spot)?.[0];
    for (let spot = 1; spot <= early; spot += 1) {
      const holder = byId(spot);
      if (!holder || !(movable === undefined || movable.has(holder))) continue;
      if (await tryCover(holder)) continue;
      // Cannot cover it: trade places with the first later holder who can.
      for (let later = early + 1; later <= group.size; later += 1) {
        const other = byId(later);
        if (!other || !(movable === undefined || movable.has(other))) continue;
        if (await tryCover(other)) {
          spots.set(holder, later);
          spots.set(other, spot);
          break;
        }
      }
    }
    return [...spots].map(([id, spot]) => ({ id, spot })).sort((a, b) => a.spot - b.spot);
  }

  /**
   * Makes sure a member holds the larger deposit needed for an early turn, taking the difference from
   * their wallet. True when they now hold it (or are trusted, so need none); false when their wallet
   * cannot cover it, and nothing is taken.
   */
  async coverEarly(
    tx: Tx,
    group: GroupRow,
    userId: string,
    trustedKnown?: boolean,
  ): Promise<boolean> {
    const trusted = trustedKnown ?? (await this.trust.profile(userId, tx)).trusted;
    if (trusted) return true;
    const need = BigInt(group.deposit_early);
    const [row] = await sql<{ deposit_required: string }>(
      tx,
      `SELECT deposit_required::text FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [group.id, userId],
    );
    const have = BigInt(row?.deposit_required ?? "0");
    if (have >= need) return true;
    const diff = need - have;
    const wallet = await this.ledger.userAccount(
      userId,
      "available",
      group.currency,
      undefined,
      tx,
    );
    if (BigInt(await this.ledger.balance(wallet, tx)) < diff) return false;
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
        idempotencyKey: `group-deposit-top:${group.id}:${userId}:${need}`,
        reference: `group:${group.id}`,
        entries: [
          { accountId: wallet, direction: "debit", amount: diff.toString() },
          { accountId: locked, direction: "credit", amount: diff.toString() },
        ],
      },
      {},
      tx,
    );
    await sql(
      tx,
      `UPDATE group_members SET deposit_required = $3 WHERE group_id = $1 AND user_id = $2`,
      [group.id, userId, need.toString()],
    );
    return true;
  }

  /** The rounds begin: one per turn, every member's contribution scheduled, and everyone told their turn. */
  async start(tx: Tx, group: GroupRow): Promise<void> {
    await sql(
      tx,
      `UPDATE groups SET status = 'running', pick_deadline = NULL, updated_at = now() WHERE id = $1`,
      [group.id],
    );
    const members = await this.activeMembers(tx, group.id);
    const byUser = new Map(members.map((m) => [m.user_id, m]));
    const bySpot = new Map(members.map((m) => [m.spot!, m]));
    const dates = roundDates(group.start_date, group.frequency, group.size);
    for (let round = 1; round <= group.size; round += 1) {
      const recipient = bySpot.get(round)!;
      await sql(
        tx,
        `INSERT INTO group_rounds (group_id, round_no, due_on, recipient_id) VALUES ($1, $2, $3, $4)`,
        [group.id, round, dates[round - 1], recipient.user_id],
      );
      await sql(
        tx,
        `INSERT INTO group_contributions (group_id, round_no, member_id, amount, next_attempt_at)
         SELECT $1, $2, m.user_id, $3, (($4::date + make_interval(hours => ${COLLECT_HOUR})) AT TIME ZONE $5)
           FROM group_members m WHERE m.group_id = $1 AND m.status = 'active'`,
        [group.id, round, group.contribution, dates[round - 1], group.time_zone],
      );
    }
    for (const m of members) {
      await this.notifications.notify(
        m.user_id,
        {
          kind: "group.started",
          title: `${group.name} has begun`,
          body: `You take turn ${byUser.get(m.user_id)!.spot} of ${group.size}, when ${moneyText(BigInt(group.contribution) * BigInt(group.size), group.currency)} is paid out to you. The first round is collected on ${dates[0]}.`,
          link: `/circles/${group.id}`,
          dedupeKey: `group:${group.id}:started`,
          email: true,
        },
        tx,
      );
    }
  }

  async activeMembers(tx: Tx, groupId: string): Promise<MemberRow[]> {
    return sql<MemberRow>(
      tx,
      `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_id = $1 AND status = 'active' ORDER BY join_seq`,
      [groupId],
    );
  }

  private async tell(
    tx: Tx,
    members: readonly MemberRow[],
    group: GroupRow,
    n: { kind: string; title: string; body: string; key: string },
  ): Promise<void> {
    for (const m of members) {
      await this.notifications.notify(
        m.user_id,
        {
          kind: n.kind,
          title: n.title,
          body: n.body,
          link: `/circles/${group.id}`,
          dedupeKey: `group:${group.id}:${n.key}`,
          email: true,
        },
        tx,
      );
    }
  }

  /** Gives every member's deposit back, and says the circle is over (a circle that never filled, or was called off). */
  async refundAll(tx: Tx, group: GroupRow, reason: string): Promise<void> {
    const members = await this.activeMembers(tx, group.id);
    for (const m of members) await this.refundDeposit(tx, group, m.user_id);
    await sql(
      tx,
      `UPDATE groups SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now() WHERE id = $1`,
      [group.id, reason.slice(0, 200)],
    );
    for (const m of members) {
      await this.notifications.notify(
        m.user_id,
        {
          kind: "group.cancelled",
          title: `${group.name} was called off`,
          body: `${reason} Anything you had put in as a deposit is back in your wallet.`,
          link: `/circles/${group.id}`,
          dedupeKey: `group:${group.id}:cancelled`,
          email: true,
        },
        tx,
      );
    }
  }

  /** Returns what a member has locked for this circle to their wallet. Safe to repeat: it posts once. */
  async refundDeposit(tx: Tx, group: GroupRow, userId: string): Promise<bigint> {
    const locked = await this.ledger.userAccount(
      userId,
      "locked",
      group.currency,
      depositRef(group.id),
      tx,
    );
    const held = BigInt(await this.ledger.balance(locked, tx));
    if (held === 0n) return 0n;
    const wallet = await this.ledger.userAccount(
      userId,
      "available",
      group.currency,
      undefined,
      tx,
    );
    const stamp = createHash("sha256")
      .update(`${group.id}:${userId}:${held}`)
      .digest("hex")
      .slice(0, 16);
    await this.ledger.post(
      {
        type: "group_deposit_refund",
        idempotencyKey: `group-deposit-refund:${group.id}:${userId}:${stamp}`,
        reference: `group:${group.id}`,
        entries: [
          { accountId: locked, direction: "debit", amount: held.toString() },
          { accountId: wallet, direction: "credit", amount: held.toString() },
        ],
      },
      {},
      tx,
    );
    return held;
  }

  /** The pot account for a round. */
  pot(tx: Tx, group: GroupRow, round: number): Promise<string> {
    return this.ledger.systemAccount("pot", group.currency, potRef(group.id, round), tx);
  }
}

export { GROUP_COLUMNS };
