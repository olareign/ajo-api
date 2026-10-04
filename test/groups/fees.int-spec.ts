import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "../support/test-app.js";
import { groupsHarness, type Member } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof groupsHarness>;

beforeAll(async () => {
  app = await createTestApp({
    PAYMENTS_FAKE: "true",
    GROUP_FEE_BPS: "200",
    GROUP_LATE_FEE_BPS: "500",
  });
  h = groupsHarness(app);
});
afterAll(async () => {
  await app?.close();
  for (const k of ["GROUP_FEE_BPS", "GROUP_LATE_FEE_BPS"]) delete process.env[k];
});
afterEach(async () => h.t.expectBooksBalance());

async function circle() {
  const maker = await h.person("10000000", { trust: true });
  const others: Member[] = [
    await h.person("10000000", { trust: true }),
    await h.person("10000000", { trust: true }),
  ];
  const g = await h.filled(maker, others);
  return { g, all: [maker, ...others] };
}

describe("a fee on each payout, and a charge for a missed payment", () => {
  it("keeps the fee out of the pot as the platform's, pays the rest, and shows both on the round", async () => {
    const { g, all } = await circle();
    await h.dueRound(g.id, 1);
    await h.runner.collectDue();
    await h.runner.payOutReady();
    // 1,500,000 collected; 2% is 30,000.
    const round = (await h.rounds(g.id))[0];
    expect(round).toMatchObject({
      status: "paid_out",
      payout_amount: "1470000",
      fee_amount: "30000",
    });
    expect(await h.t.balance(all[0]!.id)).toBe("10970000"); // 10,000,000 - 500,000 + 1,470,000
    const fees = await h.t.ledger.systemAccount("fees", "NGN", "group-payout");
    expect(BigInt(await h.t.ledger.balance(fees))).toBeGreaterThanOrEqual(30000n);
    const detail = await h.detail(all[1]!, g.id);
    expect(detail.rounds[0]!.payout).toEqual({ amount: "1470000", currency: "NGN" });
    expect(detail.rules).toMatchObject({ feeBps: 200, lateFeeBps: 500 });
    expect(
      (await h.notices(all[0]!.id)).find((n: { kind: string }) => n.kind === "group.payout")!.body,
    ).toMatch(/fee/);
  });

  it("takes the late charge out of what is left of the deposit, never more than there is", async () => {
    const maker = await h.person("10000000", { trust: true });
    const broke = await h.person("2000000");
    const third = await h.person("10000000", { trust: true });
    const g = await h.filled(maker, [broke, third]);
    // `broke` is untrusted: it locked the base deposit (500,000), or more for an early turn.
    const before = BigInt(await h.locked(broke.id, g.id));
    const wallet = await h.t.ledger.userAccount(broke.id, "available", "NGN");
    const sink = await h.t.ledger.systemAccount("suspense", "NGN", "test-sink");
    const all = await h.t.balance(broke.id);
    await h.t.ledger.post({
      type: "withdrawal",
      idempotencyKey: `empty-${broke.id}`,
      entries: [
        { accountId: wallet, direction: "debit", amount: all },
        { accountId: sink, direction: "credit", amount: all },
      ],
    });
    await h.t.db.query("UPDATE mandates SET status = 'cancelled' WHERE user_id = $1", [broke.id]);
    await h.dueRound(g.id, 1, 3);
    await h.runner.collectDue();
    // The deposit paid the 500,000, then 5% of that (25,000) came out of what remained, if anything did.
    const after = BigInt(await h.locked(broke.id, g.id));
    const late = (
      await h.t.db.query(
        "SELECT count(*)::int AS n FROM ledger_transactions WHERE type = 'group_late_fee' AND reference LIKE $1",
        [`%${g.id}%`],
      )
    )[0].n as number;
    if (before - 500000n >= 25000n) {
      expect(after).toBe(before - 500000n - 25000n);
      expect(late).toBe(1);
    } else {
      expect(after).toBe(before > 500000n ? before - 500000n : 0n);
    }
    expect(after).toBeGreaterThanOrEqual(0n);
  });
});
