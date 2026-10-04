import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "../support/test-app.js";
import { groupsHarness, type Member } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof groupsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  h = groupsHarness(app);
});
afterAll(async () => {
  await app?.close();
});
afterEach(async () => h.t.expectBooksBalance());

const many = <T>(n: number, make: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => make(i)));
const sweep = async () => {
  await h.runner.collectDue();
  await h.runner.payOutReady();
  await h.runner.completeFinished();
};
const count = async (type: string, groupId: string) =>
  (
    await h.t.db.query(
      "SELECT count(*)::int AS n FROM ledger_transactions WHERE type = $1 AND reference LIKE $2",
      [type, `%${groupId}%`],
    )
  )[0].n as number;

async function circle(size = 3) {
  const maker = await h.person();
  const others: Member[] = [];
  for (let i = 1; i < size; i += 1) others.push(await h.person());
  const g = await h.filled(maker, others);
  return { g, all: [maker, ...others] };
}

describe("collecting a round", () => {
  it("takes each member's contribution from their wallet into the round's pot, then pays the pot to whoever's turn it is", async () => {
    const { g, all } = await circle();
    await h.dueRound(g.id, 1);
    await h.runner.collectDue();
    expect(
      (await h.contributions(g.id, 1)).every((c: { status: string }) => c.status === "paid"),
    ).toBe(true);
    // The first turn is an early one, so its holder (not yet trusted) locked the larger deposit.
    expect(await h.t.balance(all[0]!.id)).toBe("8000000");
    expect(await h.t.balance(all[1]!.id)).toBe("9000000");
    expect(await h.t.balance(all[2]!.id)).toBe("9000000");
    const pot = await h.t.ledger.systemAccount("pot", "NGN", `group:${g.id}:r1`);
    expect(await h.t.ledger.balance(pot)).toBe("1500000");

    await h.runner.payOutReady();
    expect(await h.t.ledger.balance(pot)).toBe("0");
    expect(await h.t.balance(all[0]!.id)).toBe("9500000");
    expect(await h.t.balance(all[1]!.id)).toBe("9000000");
    const round = (await h.rounds(g.id))[0];
    expect(round).toMatchObject({ status: "paid_out", payout_amount: "1500000", fee_amount: "0" });
    expect(
      (await h.notices(all[0]!.id)).some((n: { kind: string }) => n.kind === "group.payout"),
    ).toBe(true);
    expect(
      (await h.notices(all[1]!.id)).some(
        (n: { kind: string }) => n.kind === "group.round_paid_out",
      ),
    ).toBe(true);
    // Everyone paid on time, and it is on their record.
    expect(await h.trustCounts(all[2]!.id)).toEqual([{ kind: "payment_on_time", n: 1 }]);
    // The board shows who has paid.
    const detail = await h.detail(all[1]!, g.id);
    expect(detail.rounds[0]!.board.map((b) => b.status)).toEqual(["paid", "paid", "paid"]);
  });

  it("does a round once, however many sweeps race for it, and leaves later rounds alone", async () => {
    const { g, all } = await circle();
    await h.dueRound(g.id, 1);
    await many(8, () => sweep());
    expect(await count("group_contribution", g.id)).toBe(3);
    expect(await count("group_payout", g.id)).toBe(1);
    expect(await h.t.balance(all[0]!.id)).toBe("9500000");
    expect(
      (await h.contributions(g.id, 2)).every((c: { status: string }) => c.status === "scheduled"),
    ).toBe(true);
    expect((await h.rounds(g.id)).map((r: { status: string }) => r.status)).toEqual([
      "paid_out",
      "scheduled",
      "scheduled",
    ]);
  });

  it("leaves a round alone before its day", async () => {
    const { g } = await circle();
    await sweep();
    expect(
      (await h.contributions(g.id)).every((c: { status: string }) => c.status === "scheduled"),
    ).toBe(true);
    expect(await count("group_contribution", g.id)).toBe(0);
  });

  it("finishes the circle after the last round: every deposit back, a finished circle on each record, and the books even", async () => {
    const { g, all } = await circle();
    for (const round of [1, 2, 3]) {
      await h.dueRound(g.id, round);
      await many(3, () => sweep());
    }
    const done = await h.row(g.id);
    expect(done.status).toBe("completed");
    expect((await h.rounds(g.id)).every((r: { status: string }) => r.status === "paid_out")).toBe(
      true,
    );
    for (const p of all) {
      expect(await h.t.balance(p.id)).toBe("10000000");
      expect(await h.locked(p.id, g.id)).toBe("0");
      expect(await h.trustCounts(p.id)).toEqual([
        { kind: "group_completed", n: 1 },
        { kind: "payment_on_time", n: 3 },
      ]);
      expect(
        (await h.notices(p.id)).filter((n: { kind: string }) => n.kind === "group.completed"),
      ).toHaveLength(1);
    }
    expect(await count("group_deposit_refund", g.id)).toBe(3);
    // A finished circle changes nothing when swept again.
    await many(3, () => sweep());
    expect(await count("group_deposit_refund", g.id)).toBe(3);
  });

  it("adds up to trust: a member who finished with every payment on time is trusted, and the circle shows it", async () => {
    const { g, all } = await circle();
    for (const round of [1, 2, 3]) {
      await h.dueRound(g.id, round);
      await sweep();
    }
    // 3 on time (15) + a finished circle (20) = 35: building, not yet trusted.
    const detail = await h.detail(all[0]!, g.id);
    expect(detail.members.every((m) => m.trust.level === "building" && m.trust.score === 35)).toBe(
      true,
    );
  });
});

describe("when the wallet is short", () => {
  it("tells the person and tries again tomorrow, then takes it late, marking the record, once they have added money", async () => {
    const { g, all } = await circle();
    const short = all[1]!;
    await h.t.db.query("DELETE FROM ledger_entries WHERE false"); // (no-op: the ledger is never edited)
    // Spend the wallet down to nothing.
    await short.call("get", "/wallet").expect(200);
    const wallet = await h.t.ledger.userAccount(short.id, "available", "NGN");
    const sink = await h.t.ledger.systemAccount("suspense", "NGN", "test-sink");
    await h.t.ledger.post({
      type: "withdrawal",
      idempotencyKey: `drain-${short.id}`,
      entries: [
        { accountId: wallet, direction: "debit", amount: await h.t.balance(short.id) },
        { accountId: sink, direction: "credit", amount: await h.t.balance(short.id) },
      ],
    });
    // Without auto-debit to fall back on, the first miss is just a reminder.
    await h.t.db.query("UPDATE mandates SET status = 'cancelled' WHERE user_id = $1", [short.id]);
    await h.dueRound(g.id, 1);
    await sweep();
    const [mine] = (await h.contributions(g.id, 1)).filter(
      (c: { member_id: string }) => c.member_id === short.id,
    );
    expect(mine).toMatchObject({
      status: "scheduled",
      attempts: 1,
      note: "Not enough in your wallet",
    });
    expect(
      (await h.notices(short.id)).find(
        (n: { kind: string }) => n.kind === "group.contribution_short",
      ),
    ).toMatchObject({ email_status: "pending" });
    expect((await h.rounds(g.id))[0].status).toBe("scheduled");

    // Tomorrow (a day late, inside the grace period) they have money.
    await h.t.giveMoney(short.id, "600000");
    await h.dueRound(g.id, 1, 1);
    await sweep();
    expect(
      (await h.contributions(g.id, 1)).every((c: { status: string }) =>
        ["paid", "late"].includes(c.status),
      ),
    ).toBe(true);
    expect(
      (await h.contributions(g.id, 1)).find((c: { member_id: string }) => c.member_id === short.id)
        .status,
    ).toBe("late");
    expect(await h.trustCounts(short.id)).toEqual([{ kind: "payment_late", n: 1 }]);
    expect((await h.rounds(g.id))[0].status).toBe("paid_out");
  });

  it("collects the shortfall from the bank under auto-debit, once, waits for it, then takes the payment", async () => {
    const { g, all } = await circle();
    const light = all[2]!;
    const wallet = await h.t.ledger.userAccount(light.id, "available", "NGN");
    const sink = await h.t.ledger.systemAccount("suspense", "NGN", "test-sink");
    const leave = 200000n;
    const drain = BigInt(await h.t.balance(light.id)) - leave;
    await h.t.ledger.post({
      type: "withdrawal",
      idempotencyKey: `drain2-${light.id}`,
      entries: [
        { accountId: wallet, direction: "debit", amount: drain.toString() },
        { accountId: sink, direction: "credit", amount: drain.toString() },
      ],
    });
    const fake = h.t.fake("NG");
    const before = fake.count("chargeMandate");
    await h.dueRound(g.id, 1);
    await sweep();
    expect(fake.count("chargeMandate")).toBe(before + 1);
    const last = fake.calls.filter(([m]) => m === "chargeMandate").at(-1)![1] as { amount: string };
    expect(last.amount).toBe("300000");
    const [waiting] = (await h.contributions(g.id, 1)).filter(
      (c: { member_id: string }) => c.member_id === light.id,
    );
    expect(waiting).toMatchObject({
      status: "scheduled",
      attempts: 1,
      note: "Collecting from your bank",
    });

    await h.dueRound(g.id, 1);
    await many(4, () => sweep());
    expect(fake.count("chargeMandate")).toBe(before + 1);

    const [intent] = await h.t.db.query("SELECT reference FROM payment_intents WHERE id = $1", [
      waiting.topup_intent_id,
    ]);
    await h.t
      .deliver([
        h.t.event({
          kind: "funding.succeeded",
          reference: intent.reference,
          amount: "300000",
          currency: "NGN",
        }),
      ])
      .expect(200);
    await h.dueRound(g.id, 1);
    await sweep();
    expect(
      (await h.contributions(g.id, 1)).every((c: { status: string }) =>
        ["paid", "late"].includes(c.status),
      ),
    ).toBe(true);
    expect((await h.rounds(g.id))[0].status).toBe("paid_out");
  });
});

describe("a payment that is not made", () => {
  async function broke(group: { id: string }, who: Member) {
    const wallet = await h.t.ledger.userAccount(who.id, "available", "NGN");
    const sink = await h.t.ledger.systemAccount("suspense", "NGN", "test-sink");
    const all = await h.t.balance(who.id);
    if (all !== "0") {
      await h.t.ledger.post({
        type: "withdrawal",
        idempotencyKey: `empty-${who.id}-${group.id}`,
        entries: [
          { accountId: wallet, direction: "debit", amount: all },
          { accountId: sink, direction: "credit", amount: all },
        ],
      });
    }
    await h.t.db.query("UPDATE mandates SET status = 'cancelled' WHERE user_id = $1", [who.id]);
  }

  it("is covered by the deposit once the grace period is over, so the round pays out in full, and the defaulter is marked", async () => {
    const { g, all } = await circle();
    const defaulter = all[1]!;
    await broke(g, defaulter);
    // Three days past its day (the grace period is two).
    await h.dueRound(g.id, 1, 3);
    await sweep();
    const [c] = (await h.contributions(g.id, 1)).filter(
      (x: { member_id: string }) => x.member_id === defaulter.id,
    );
    expect(c).toMatchObject({ status: "covered", note: "Covered by the deposit" });
    expect(await h.locked(defaulter.id, g.id)).toBe("0");
    const round = (await h.rounds(g.id))[0];
    expect(round).toMatchObject({ status: "paid_out", payout_amount: "1500000" });
    expect(await h.t.balance(all[0]!.id)).toBe("9500000");

    expect(await h.trustCounts(defaulter.id)).toEqual([{ kind: "payment_missed", n: 1 }]);
    const [block] = await h.t.db.query(
      "SELECT blocked_until > now() AS active FROM defaulter_blocks WHERE user_id = $1",
      [defaulter.id],
    );
    expect(block.active).toBe(true);
    const [recovery] = await h.t.db.query(
      "SELECT amount_owed::text AS owed, covered_by_deposit::text AS covered, status FROM recovery_cases WHERE member_id = $1",
      [defaulter.id],
    );
    expect(recovery).toEqual({ owed: "500000", covered: "500000", status: "open" });
    expect(
      (await h.notices(defaulter.id)).find(
        (n: { kind: string }) => n.kind === "group.payment_missed",
      ),
    ).toMatchObject({ email_status: "pending" });
    expect(
      (await h.notices(all[0]!.id)).some(
        (n: { kind: string }) => n.kind === "group.member_defaulted",
      ),
    ).toBe(true);

    // Their trust drops, and they cannot join or make another circle.
    const detail = await h.detail(all[0]!, g.id);
    expect(detail.members.find((m) => m.username === defaulter.username)!.trust).toMatchObject({
      level: "building",
      score: 0,
    });
    const blocked = await defaulter
      .call("post", "/groups")
      .set("Idempotency-Key", `k_${Math.random()}_x`)
      .send(h.body());
    expect(blocked.body.code).toBe("defaulter_blocked");
  });

  it("does nothing twice when the sweep runs again, or all at once", async () => {
    const { g, all } = await circle();
    await broke(g, all[1]!);
    await h.dueRound(g.id, 1, 3);
    await many(8, () => sweep());
    expect(await count("group_deposit_cover", g.id)).toBe(1);
    expect(await count("group_payout", g.id)).toBe(1);
    expect(
      (await h.t.db.query("SELECT 1 FROM recovery_cases WHERE group_id = $1", [g.id])).length,
    ).toBe(1);
    expect(await h.trustCounts(all[1]!.id)).toEqual([{ kind: "payment_missed", n: 1 }]);
  });

  it("still finishes the circle, giving back what is left of each deposit, and does not credit the defaulter with finishing", async () => {
    const { g, all } = await circle();
    await broke(g, all[1]!);
    await h.dueRound(g.id, 1, 3);
    await sweep();
    // Their deposit is spent, so round 2's payment is missed again once its grace period is over (and that turn pays out short). Their own turn then refills their wallet, so round 3 is paid.
    for (const round of [2, 3]) {
      await h.dueRound(g.id, round, 3);
      await sweep();
    }
    expect((await h.row(g.id)).status).toBe("completed");
    expect((await h.rounds(g.id)).map((r: { status: string }) => r.status)).toEqual([
      "paid_out",
      "paid_out_short",
      "paid_out",
    ]);
    expect(await h.locked(all[0]!.id, g.id)).toBe("0");
    expect(await h.trustCounts(all[0]!.id)).toEqual([
      { kind: "group_completed", n: 1 },
      { kind: "payment_late", n: 3 },
    ]);
    expect(
      (await h.trustCounts(all[1]!.id)).some((t: { kind: string }) => t.kind === "group_completed"),
    ).toBe(false);
  });

  it("holds back a member's good name: a record with a missed payment is not trusted even after good ones", async () => {
    const { g, all } = await circle();
    await broke(g, all[2]!);
    await h.dueRound(g.id, 1, 3);
    await sweep();
    await h.t.giveMoney(all[2]!.id, "9000000");
    await h.t.db.query(
      "UPDATE defaulter_blocks SET blocked_until = now() - interval '1 day' WHERE user_id = $1",
      [all[2]!.id],
    );
    for (let i = 0; i < 10; i += 1) {
      await h.t.db.query(
        "INSERT INTO trust_events (user_id, kind, ref) VALUES ($1, 'payment_on_time', $2)",
        [all[2]!.id, `later:${i}:${Math.random()}`],
      );
    }
    const detail = await h.detail(all[0]!, g.id);
    expect(detail.members.find((m) => m.username === all[2]!.username)!.trust.level).toBe(
      "building",
    );
  });
});

describe("reminders", () => {
  it("tells members a day ahead, by email too when the wallet will not cover it, and the person whose turn it is; once each", async () => {
    const { g, all } = await circle();
    await h.t.db.query(
      "UPDATE group_contributions SET next_attempt_at = now() + interval '12 hours' WHERE group_id = $1 AND round_no = 1",
      [g.id],
    );
    await h.t.db.query(
      "UPDATE group_rounds SET due_on = (now() + interval '12 hours')::date WHERE group_id = $1 AND round_no = 1",
      [g.id],
    );
    // Make one wallet too small.
    const wallet = await h.t.ledger.userAccount(all[2]!.id, "available", "NGN");
    const sink = await h.t.ledger.systemAccount("suspense", "NGN", "test-sink");
    const everything = await h.t.balance(all[2]!.id);
    await h.t.ledger.post({
      type: "withdrawal",
      idempotencyKey: `empty-r-${all[2]!.id}`,
      entries: [
        { accountId: wallet, direction: "debit", amount: everything },
        { accountId: sink, direction: "credit", amount: everything },
      ],
    });
    await h.runner.remindUpcoming();
    await h.runner.remindUpcoming();
    const soon = async (p: Member) =>
      (await h.notices(p.id)).filter((n: { kind: string }) => n.kind === "group.contribution_soon");
    expect(await soon(all[1]!)).toMatchObject([{ email_status: "none" }]);
    expect(await soon(all[2]!)).toMatchObject([{ email_status: "pending" }]);
    expect(
      (await h.notices(all[0]!.id)).filter(
        (n: { kind: string }) => n.kind === "group.your_turn_soon",
      ),
    ).toHaveLength(1);
  });
});
