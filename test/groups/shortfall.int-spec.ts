import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "../support/test-app.js";
import { groupsHarness, type Member } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof groupsHarness>;

beforeAll(async () => {
  app = await createTestApp({
    PAYMENTS_FAKE: "true",
    GROUP_DEPOSIT_BASE_X: "0",
    GROUP_DEPOSIT_EARLY_X: "0",
  });
  h = groupsHarness(app);
});
afterAll(async () => {
  await app?.close();
  for (const k of ["GROUP_DEPOSIT_BASE_X", "GROUP_DEPOSIT_EARLY_X"]) delete process.env[k];
});
afterEach(async () => h.t.expectBooksBalance());

describe("when the deposit cannot cover a missed payment", () => {
  it("pays out what was collected, marks the round short, and leaves the shortfall for a person to recover", async () => {
    const maker = await h.person();
    const missing = await h.person();
    const third = await h.person();
    const g = await h.filled(maker, [missing, third]);
    const wallet = await h.t.ledger.userAccount(missing.id, "available", "NGN");
    const sink = await h.t.ledger.systemAccount("suspense", "NGN", "test-sink");
    const all = await h.t.balance(missing.id);
    await h.t.ledger.post({
      type: "withdrawal",
      idempotencyKey: `empty-${missing.id}`,
      entries: [
        { accountId: wallet, direction: "debit", amount: all },
        { accountId: sink, direction: "credit", amount: all },
      ],
    });
    await h.t.db.query("UPDATE mandates SET status = 'cancelled' WHERE user_id = $1", [missing.id]);
    await h.dueRound(g.id, 1, 3);
    await h.runner.collectDue();
    await h.runner.payOutReady();
    const [c] = (await h.contributions(g.id, 1)).filter(
      (x: { member_id: string }) => x.member_id === missing.id,
    );
    expect(c).toMatchObject({ status: "missed", note: "Not covered in full" });
    const round = (await h.rounds(g.id))[0];
    expect(round).toMatchObject({ status: "paid_out_short", payout_amount: "1000000" });
    expect(await h.t.balance(maker.id)).toBe("10500000"); // paid 500,000 in, took 1,000,000 out
    const [recovery] = await h.t.db.query(
      "SELECT amount_owed::text AS owed, covered_by_deposit::text AS covered FROM recovery_cases WHERE member_id = $1",
      [missing.id],
    );
    expect(recovery).toEqual({ owed: "500000", covered: "0" });
    expect(await h.trustCounts(missing.id)).toEqual([{ kind: "payment_missed", n: 1 }]);
  });

  it("asks nobody for a deposit when the circle's rules say none", async () => {
    const maker = await h.person();
    const joiner = await h.person();
    const g = await h.create(maker, { size: 4 });
    expect(g.myDeposit).toEqual({ amount: "0", currency: "NGN" });
    await h.join(joiner, g.inviteCode!).expect(200);
    expect(await h.t.balance(joiner.id)).toBe("10000000");
  });
});
export type { Member };
