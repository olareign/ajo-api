import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Redis } from "ioredis";
import { FX_RATES, type FxRatesSource } from "../../src/adapters/fx/fx-rates.port.js";
import { REDIS_CLIENT } from "../../src/redis/redis.module.js";
import { paymentsHarness } from "../payments/support.js";
import { createTestApp } from "../support/test-app.js";

/** A rate source the test controls: what it answers, whether it is down, and how often it was asked. */
const source: FxRatesSource & { calls: number; down: boolean; rates: Record<string, number> } = {
  calls: 0,
  down: false,
  rates: { USD: 1, NGN: 1500, GBP: 0.75, EUR: 0.9 } as Record<string, number>,
  async latest() {
    source.calls += 1;
    if (source.down) throw new Error("down");
    return {
      asOf: new Date("2026-10-10T12:00:00Z"),
      rates: source.rates,
      source: "openexchangerates" as const,
    };
  },
};

let app: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;
let redis: Redis;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" }, [], (b) =>
    b.overrideProvider(FX_RATES).useValue(source),
  );
  t = paymentsHarness(app);
  redis = app.get(REDIS_CLIENT);
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await redis.del("fx:usd:fresh", "fx:usd:last");
  source.calls = 0;
  source.down = false;
});

describe("a wallet shown in other currencies", () => {
  it("adds up everything held and gives it in pounds, dollars and euros, exactly, with the rate", async () => {
    const who = await t.ready("NG", { mfa: false });
    await t.giveMoney(who.id, "150000"); // ₦1,500.00
    const res = await who.call("get", "/fx/wallet").expect(200);
    expect(res.body).toMatchObject({
      available: true,
      stale: false,
      sample: false,
      asOf: "2026-10-10T12:00:00.000Z",
    });
    expect(res.body.wallets).toEqual([
      {
        currency: "NGN",
        total: "150000",
        equivalents: [
          { currency: "GBP", amount: "75", rate: "0.0005" },
          { currency: "USD", amount: "100", rate: "0.000666667" },
          { currency: "EUR", amount: "90", rate: "0.0006" },
        ],
      },
    ]);
  });

  it("asks the rate source once an hour at most, however many people look", async () => {
    const people = [await t.ready("NG", { mfa: false }), await t.ready("GB", { mfa: false })];
    for (const who of people) await who.call("get", "/fx/wallet").expect(200);
    await Promise.all(people.map((who) => who.call("get", "/fx/wallet").expect(200)));
    expect(source.calls).toBe(1);
    expect(await redis.ttl("fx:usd:fresh")).toBeGreaterThan(3500);
  });

  it("uses the last good rates, marked stale, when the source is down, and shows none once there are none", async () => {
    const who = await t.ready("NG", { mfa: false });
    await t.giveMoney(who.id, "300000");
    await who.call("get", "/fx/wallet").expect(200);
    await redis.del("fx:usd:fresh");
    source.down = true;
    const stale = await who.call("get", "/fx/wallet").expect(200);
    expect(stale.body.stale).toBe(true);
    expect(stale.body.wallets[0].equivalents[0]).toEqual({
      currency: "GBP",
      amount: "150",
      rate: "0.0005",
    });
    await redis.del("fx:usd:last");
    const none = await who.call("get", "/fx/wallet").expect(200);
    expect(none.body).toEqual({
      available: false,
      asOf: null,
      stale: false,
      sample: false,
      wallets: [],
    });
  });

  it("shows only the caller's own money, and needs a signed-in person", async () => {
    const [mine, theirs] = [
      await t.ready("NG", { mfa: false }),
      await t.ready("NG", { mfa: false }),
    ];
    await t.giveMoney(theirs.id, "999999");
    const res = await mine.call("get", "/fx/wallet").expect(200);
    expect(res.body.wallets).toEqual([]);
    await mine.call("get", "/fx/wallet").set("Authorization", "Bearer nope").expect(401);
  });

  it("moves no money: looking leaves the books exactly as they were", async () => {
    const who = await t.ready("NG", { mfa: false });
    await t.giveMoney(who.id, "150000");
    const [before] = await t.db.query("SELECT count(*)::int AS n FROM ledger_entries");
    await who.call("get", "/fx/wallet").expect(200);
    const [after] = await t.db.query("SELECT count(*)::int AS n FROM ledger_entries");
    expect(after.n).toBe(before.n);
    expect(await t.balance(who.id)).toBe("150000");
  });
});
