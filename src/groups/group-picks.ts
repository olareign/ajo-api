import { HttpStatus, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { Notifications } from "../notifications/notifications.service.js";
import { coded } from "../payments/payment-intents.js";
import { GroupLifecycle } from "./group-lifecycle.js";
import { MEMBER_COLUMNS, type GroupRow, type MemberRow, type Tx } from "./group-model.js";
import { isEarly } from "./group-rules.js";
import { Groups } from "./groups.service.js";
import { TrustService } from "./trust.service.js";

/** Choosing a turn, and trading turns, before the first round is collected. */
@Injectable()
export class GroupPicks {
  constructor(
    private readonly db: DataSource,
    private readonly groups: Groups,
    private readonly lifecycle: GroupLifecycle,
    private readonly trust: TrustService,
    private readonly notifications: Notifications,
  ) {}

  /**
   * Takes a turn, if it is free. The circle's row is held for the whole change, so when several people
   * reach for the same turn exactly one gets it. An untrusted member taking an early turn locks the larger
   * deposit first; if their wallet cannot cover it the turn stays free. Everyone having picked starts the rounds.
   */
  async pick(userId: string, groupId: string, spot: number) {
    await this.db.transaction(async (tx) => {
      const group = await this.groups.lockGroup(tx, groupId);
      if (
        group.status !== "picking" ||
        !group.pick_deadline ||
        group.pick_deadline.getTime() <= Date.now()
      ) {
        throw coded(HttpStatus.CONFLICT, "Picking isn't open for this circle.", "picking_closed");
      }
      const [member] = await sql<MemberRow>(
        tx,
        `SELECT ${MEMBER_COLUMNS} FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
        [groupId, userId],
      );
      if (!member) throw coded(HttpStatus.NOT_FOUND, "You're not in this circle.", "not_a_member");
      if (member.spot !== null)
        throw coded(HttpStatus.CONFLICT, "You've already picked your turn.", "already_picked");
      if (!Number.isInteger(spot) || spot < 1 || spot > group.size) {
        throw coded(HttpStatus.BAD_REQUEST, "That isn't a turn in this circle.", "spot_invalid");
      }
      const [taken] = await sql<{ n: string }>(
        tx,
        `SELECT count(*)::text AS n FROM group_members WHERE group_id = $1 AND spot = $2`,
        [groupId, spot],
      );
      if (Number(taken!.n) > 0)
        throw coded(HttpStatus.CONFLICT, "Someone just took that turn.", "spot_taken");
      if (isEarly(spot, group.size) && !(await this.lifecycle.coverEarly(tx, group, userId))) {
        throw coded(
          HttpStatus.CONFLICT,
          "An early turn needs a larger deposit than your wallet holds. Add money, or pick a later turn.",
          "deposit_needed",
        );
      }
      await sql(tx, `UPDATE group_members SET spot = $3 WHERE group_id = $1 AND user_id = $2`, [
        groupId,
        userId,
        spot,
      ]);
      const [waiting] = await sql<{ n: string }>(
        tx,
        `SELECT count(*)::text AS n FROM group_members WHERE group_id = $1 AND status = 'active' AND spot IS NULL`,
        [groupId],
      );
      if (Number(waiting!.n) === 0) await this.lifecycle.start(tx, group);
    });
    return this.groups.detail(userId, groupId);
  }

  // ---- swapping --------------------------------------------------------------------------------

  /** Asks another member to trade turns. Only before anyone has been asked for the first round. */
  async proposeSwap(userId: string, groupId: string, username: string) {
    await this.db.transaction(async (tx) => {
      const group = await this.groups.lockGroup(tx, groupId);

      const [pair] = await sql<{ me: string | null; other: string | null }>(
        tx,
        `SELECT (SELECT user_id FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active') AS me,
                (SELECT m.user_id FROM group_members m JOIN users u ON u.id = m.user_id
                  WHERE m.group_id = $1 AND m.status = 'active' AND u.username = $3) AS other`,
        [groupId, userId, username.replace(/^@/, "").toLowerCase()],
      );
      if (!pair?.me)
        throw coded(HttpStatus.NOT_FOUND, "You're not in this circle.", "not_a_member");
      if (!pair.other || pair.other === userId)
        throw coded(HttpStatus.NOT_FOUND, "That person isn't in this circle.", "not_a_member");
      await this.assertSwappable(tx, group);
      await sql(
        tx,
        `INSERT INTO group_swaps (group_id, from_user, to_user) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [groupId, userId, pair.other],
      );
      const [who] = await sql<{ display_name: string }>(
        tx,
        `SELECT display_name FROM users WHERE id = $1`,
        [userId],
      );
      await this.notifications.notify(
        pair.other,
        {
          kind: "group.swap_request",
          title: `${who!.display_name} would like to swap turns`,
          body: `In ${group.name}. You can say yes or no in the circle.`,
          link: `/circles/${groupId}`,
          dedupeKey: `group:${groupId}:swap:${userId}:${pair.other}:${Date.now()}`,
        },
        tx,
      );
    });
    return this.groups.detail(userId, groupId);
  }

  async pendingSwaps(userId: string, groupId: string) {
    return this.db.query<
      {
        id: string;
        from_username: string;
        from_name: string;
        to_username: string;
        to_name: string;
        incoming: boolean;
      }[]
    >(
      `SELECT s.id, fu.username::text AS from_username, fu.display_name AS from_name,
              tu.username::text AS to_username, tu.display_name AS to_name, (s.to_user = $1) AS incoming
         FROM group_swaps s JOIN users fu ON fu.id = s.from_user JOIN users tu ON tu.id = s.to_user
        WHERE s.group_id = $2 AND s.status = 'pending' AND $1 IN (s.from_user, s.to_user) ORDER BY s.created_at`,
      [userId, groupId],
    );
  }

  /** The asked member answers. Yes trades the two turns, and the round each one is paid out in. */
  async answerSwap(userId: string, groupId: string, swapId: string, accept: boolean) {
    await this.db.transaction(async (tx) => {
      const group = await this.groups.lockGroup(tx, groupId);
      const [swap] = await sql<{ id: string; from_user: string; to_user: string; status: string }>(
        tx,
        `SELECT id, from_user, to_user, status FROM group_swaps WHERE id = $1 AND group_id = $2 FOR UPDATE`,
        [swapId, groupId],
      );
      if (!swap || swap.to_user !== userId)
        throw coded(HttpStatus.NOT_FOUND, "There's no such request.", "no_swap");
      if (swap.status !== "pending") return;
      if (!accept) {
        await sql(
          tx,
          `UPDATE group_swaps SET status = 'declined', responded_at = now() WHERE id = $1`,
          [swapId],
        );
        return;
      }
      await this.assertSwappable(tx, group);
      const spots = await sql<{ user_id: string; spot: number }>(
        tx,
        `SELECT user_id, spot FROM group_members WHERE group_id = $1 AND user_id IN ($2, $3) AND status = 'active'`,
        [groupId, swap.from_user, swap.to_user],
      );
      if (spots.length !== 2)
        throw coded(HttpStatus.CONFLICT, "That swap can't happen now.", "swap_unavailable");
      const a = spots.find((s) => s.user_id === swap.from_user)!;
      const b = spots.find((s) => s.user_id === swap.to_user)!;
      // Whoever moves into an early turn must hold the larger deposit, or the swap does not happen.
      for (const [who, spot] of [
        [a.user_id, b.spot],
        [b.user_id, a.spot],
      ] as const) {
        if (isEarly(spot, group.size) && !(await this.lifecycle.coverEarly(tx, group, who))) {
          throw coded(
            HttpStatus.CONFLICT,
            "An early turn needs a larger deposit, and a wallet can't cover it.",
            "deposit_needed",
          );
        }
      }
      await sql(tx, `UPDATE group_members SET spot = NULL WHERE group_id = $1 AND user_id = $2`, [
        groupId,
        a.user_id,
      ]);
      await sql(tx, `UPDATE group_members SET spot = $3 WHERE group_id = $1 AND user_id = $2`, [
        groupId,
        b.user_id,
        a.spot,
      ]);
      await sql(tx, `UPDATE group_members SET spot = $3 WHERE group_id = $1 AND user_id = $2`, [
        groupId,
        a.user_id,
        b.spot,
      ]);
      await sql(
        tx,
        `UPDATE group_rounds SET recipient_id = $3 WHERE group_id = $1 AND round_no = $2`,
        [groupId, a.spot, b.user_id],
      );
      await sql(
        tx,
        `UPDATE group_rounds SET recipient_id = $3 WHERE group_id = $1 AND round_no = $2`,
        [groupId, b.spot, a.user_id],
      );
      await sql(
        tx,
        `UPDATE group_swaps SET status = 'accepted', responded_at = now() WHERE id = $1`,
        [swapId],
      );
      // Anything else waiting on either of them is now out of date.
      await sql(
        tx,
        `UPDATE group_swaps SET status = 'cancelled', responded_at = now()
          WHERE group_id = $1 AND status = 'pending' AND (from_user IN ($2, $3) OR to_user IN ($2, $3))`,
        [groupId, a.user_id, b.user_id],
      );
      await this.notifications.notify(
        swap.from_user,
        {
          kind: "group.swapped",
          title: "Your swap went through",
          body: `You now take turn ${b.spot} in ${group.name}.`,
          link: `/circles/${groupId}`,
          dedupeKey: `group:${groupId}:swapped:${swapId}`,
        },
        tx,
      );
    });
    return this.groups.detail(userId, groupId);
  }

  /** Turns can only be traded while the circle is running and nobody has yet been asked for round 1. */
  private async assertSwappable(tx: Tx, group: GroupRow): Promise<void> {
    if (group.status !== "running") {
      throw coded(
        HttpStatus.CONFLICT,
        "Turns can only be swapped once they are set and before the first round.",
        "swap_unavailable",
      );
    }
    const [started] = await sql<{ n: string }>(
      tx,
      `SELECT count(*)::text AS n FROM group_contributions
        WHERE group_id = $1 AND round_no = 1 AND (status <> 'scheduled' OR attempts > 0 OR next_attempt_at <= now())`,
      [group.id],
    );
    if (Number(started!.n) > 0) {
      throw coded(
        HttpStatus.CONFLICT,
        "The first round has started, so turns can't be swapped now.",
        "swap_unavailable",
      );
    }
  }
}
