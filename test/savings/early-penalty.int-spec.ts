import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "../support/test-app.js";
import { key, PIN, savingsHarness } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof savingsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true", EARLY_WITHDRAWAL_PENALTY_BPS: "500" });
  h = savingsHarness(app);
});
afterAll(async () => {
  await app?.close();
  delete process.env.EARLY_WITHDRAWAL_PENALTY_BPS;
});
afterEach(async () => h.t.expectBooksBalance());

describe("when ending early costs something", () => {
  it("keeps the charge as the platform's fee, tells the person, and balances the books", async () => {
    const who = await h.saver("1000000");
    const plan = await h.plan(who);
    await who
      .call("post", `/savings/${plan.id}/topup`)
      .set("Idempotency-Key", key())
      .send({ amount: "1000000" })
      .expect(200);
    const ended = (
      await who.call("post", `/savings/${plan.id}/withdraw`).send({ pin: PIN }).expect(200)
    ).body;
    expect(ended).toMatchObject({
      payout: { amount: "950000" },
      penalty: { amount: "50000" },
    });
    expect(await h.t.balance(who.id)).toBe("950000");
    const fees = await h.t.ledger.systemAccount("fees", "NGN", "early-withdrawal");
    expect(BigInt(await h.t.ledger.balance(fees))).toBeGreaterThanOrEqual(50000n);
    expect(
      (await h.notices(who.id)).find((n: { kind: string }) => n.kind === "plan.ended_early")!.body,
    ).toMatch(/charge/);
  });

  it("rounds the charge down, and never charges on nothing", async () => {
    const who = await h.saver("100000");
    const empty = await h.plan(who);
    const none = (
      await who.call("post", `/savings/${empty.id}/withdraw`).send({ pin: PIN }).expect(200)
    ).body;
    expect(none.penalty.amount).toBe("0");
    const small = await h.plan(who);
    await who
      .call("post", `/savings/${small.id}/topup`)
      .set("Idempotency-Key", key())
      .send({ amount: "10001" })
      .expect(200);
    const ended = (
      await who.call("post", `/savings/${small.id}/withdraw`).send({ pin: PIN }).expect(200)
    ).body;
    expect(ended.penalty.amount).toBe("500"); // 5% of 10001 is 500.05
    expect(ended.payout.amount).toBe("9501");
  });
});
