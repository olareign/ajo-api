import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { MoneyActionGuard } from "../../src/auth/money-action.guard.js";
import { recipientFor } from "../../src/payments/providers/fake.provider.js";
import { WITHDRAWAL_RECONCILE_AFTER_SECONDS } from "../../src/payments/withdrawals.service.js";
import { createTestApp } from "../support/test-app.js";
import { paymentsHarness, PIN } from "./support.js";

let app: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;

// A fresh authenticator code cannot be made fifty times a second, so these tests let the money gate
// through (it has its own tests, in withdraw-gates). Everything else here is real.
beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" }, [], (builder) =>
    builder.overrideGuard(MoneyActionGuard).useValue({ canActivate: () => true }),
  );
  t = paymentsHarness(app);
});
afterAll(async () => {
  await app?.close();
});
afterEach(async () => {
  t.fake("NG").behaviour.transfer = "pending";
  t.fake("NG").behaviour.transfers.clear();
  await t.expectBooksBalance();
});

type Who = Awaited<ReturnType<typeof t.ready>>;
const key = () => `k_${randomUUID()}`;
const withdraw = (who: Who, body: object, idempotencyKey: string | null = key()) => {
  const req = who.call("post", "/payments/withdraw");
  return (idempotencyKey ? req.set("Idempotency-Key", idempotencyKey) : req).send(body);
};
const many = <T>(n: number, make: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => make(i)));
const transfers = () =>
  t
    .fake("NG")
    .calls.filter(([m]) => m === "transfer")
    .map(([, input]) => input as Record<string, string>);

/** Someone with money, a PIN, and a bank account the bank says is theirs. */
async function withMoney(balance = "100000") {
  const who = await t.ready();
  await t.giveMoney(who.id, balance);
  const accountNumber = await t.payoutAccount(who);
  return { who, accountNumber };
}
const stale = (id: string) =>
  t.db.query(
    "UPDATE payment_intents SET updated_at = now() - make_interval(secs => $2) WHERE id = $1",
    [id, WITHDRAWAL_RECONCILE_AFTER_SECONDS * 3],
  );

describe("the account withdrawals go to", () => {
  it("is set once the bank says it is in the person's own name, and keeps no account number", async () => {
    const who = await t.ready();
    const number = `0${Math.floor(Math.random() * 1e9)}`.padEnd(10, "1").slice(0, 10);
    t.fake("NG").behaviour.accountNames.set(number, "TEST USER");
    const res = await who
      .call("put", "/payments/payout-account")
      .send({ bankCode: "058", accountNumber: number })
      .expect(200);
    expect(res.body).toEqual({
      bankCode: "058",
      bankName: "GTBank",
      last4: number.slice(-4),
      accountName: "TEST USER",
    });
    expect((await who.call("get", "/payments/payout-account").expect(200)).body).toEqual(res.body);
    const rows = await t.db.query("SELECT * FROM payout_accounts WHERE user_id = $1", [who.id]);
    expect(JSON.stringify(rows)).not.toContain(number);
  });

  it("refuses an account in someone else's name, and one the bank cannot find", async () => {
    const who = await t.ready();
    t.fake("NG").behaviour.accountNames.set("0000000001", "CHIDI OKAFOR");
    const other = await who
      .call("put", "/payments/payout-account")
      .send({ bankCode: "058", accountNumber: "0000000001" })
      .expect(422);
    expect(other.body.code).toBe("name_mismatch");
    const missing = await who
      .call("put", "/payments/payout-account")
      .send({ bankCode: "058", accountNumber: "0000000002" })
      .expect(422);
    expect(missing.body.code).toBe("account_not_found");
    expect((await who.call("get", "/payments/payout-account").expect(200)).body).toEqual({});
  });

  it("refuses a malformed bank or account number, and fields it does not know", async () => {
    const who = await t.ready();
    for (const body of [
      { bankCode: "x", accountNumber: "0123456789" },
      { bankCode: "058", accountNumber: "123" },
      { bankCode: "058", accountNumber: "0123456789", name: "Me" },
    ]) {
      await who.call("put", "/payments/payout-account").send(body).expect(400);
    }
  });

  it("can be changed, and the new one is used from then on", async () => {
    const { who } = await withMoney();
    const second = await t.payoutAccount(who);
    await withdraw(who, { amount: "1000", pin: PIN }).expect(200);
    expect(transfers().at(-1)!.recipientCode).toBe(recipientFor(second));
  });

  it("is not offered in the UK, where no payout partner serves", async () => {
    const who = await t.ready("GB");
    const res = await who
      .call("put", "/payments/payout-account")
      .send({ bankCode: "058", accountNumber: "0123456789" })
      .expect(503);
    expect(res.body.code).toBe("payouts_not_available");
    const w = await withdraw(who, { amount: "1000", pin: PIN }).expect(503);
    expect(w.body.code).toBe("payouts_not_available");
  });
});

describe("withdrawing", () => {
  it("holds the money at once, asks the bank once, and settles when the bank says it has paid", async () => {
    const { who, accountNumber } = await withMoney();
    const before = transfers().length;
    const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(200);

    expect(res.body).toMatchObject({
      kind: "withdrawal",
      status: "pending",
      amount: { amount: "40000", currency: "NGN" },
      method: "bank_account",
    });
    expect(await t.balance(who.id)).toBe("60000");
    expect(transfers()).toHaveLength(before + 1);
    expect(transfers().at(-1)).toMatchObject({
      amount: "40000",
      recipientCode: recipientFor(accountNumber),
    });

    const [{ reference }] = await t.db.query(
      "SELECT reference FROM payment_intents WHERE id = $1",
      [res.body.id],
    );
    expect(transfers().at(-1)!.reference).toBe(reference);
    await t.deliver([t.event({ kind: "payout.succeeded", reference })]).expect(200);
    expect((await who.call("get", `/payments/${res.body.id}`).expect(200)).body.status).toBe(
      "succeeded",
    );
    expect(await t.balance(who.id)).toBe("60000");
  });

  it("settles straight away when the partner says it has already sent it", async () => {
    const { who } = await withMoney();
    t.fake("NG").behaviour.transfer = "success";
    const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(200);
    expect(res.body.status).toBe("succeeded");
    expect(await t.balance(who.id)).toBe("60000");
  });

  it.each([["failed"], ["otp"], ["reject"]] as const)(
    "gives the money straight back when the partner says %s",
    async (behaviour) => {
      const { who } = await withMoney();
      t.fake("NG").behaviour.transfer = behaviour;
      const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(200);
      expect(res.body.status).toBe("failed");
      expect(res.body.failureReason).toBeTruthy();
      expect(await t.balance(who.id)).toBe("100000");
    },
  );

  it("keeps the money held, and does not guess, when the partner cannot be reached", async () => {
    const { who } = await withMoney();
    t.fake("NG").behaviour.transfer = "unavailable";
    const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(200);
    expect(res.body.status).toBe("pending");
    expect(await t.balance(who.id)).toBe("60000");
  });

  it("refuses more than is available, holds nothing, and never asks the bank", async () => {
    const { who } = await withMoney("30000");
    const before = transfers().length;
    const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(422);
    expect(res.body.code).toBe("insufficient_funds");
    expect(await t.balance(who.id)).toBe("30000");
    expect(
      await t.db.query("SELECT 1 FROM payment_intents WHERE user_id = $1", [who.id]),
    ).toHaveLength(0);
    expect(transfers()).toHaveLength(before);
  });

  it("will not spend money that is already held for another withdrawal", async () => {
    const { who } = await withMoney("100000");
    await withdraw(who, { amount: "70000", pin: PIN }).expect(200);
    const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(422);
    expect(res.body.code).toBe("insufficient_funds");
  });

  it("needs the right PIN, and counts a wrong one", async () => {
    const { who } = await withMoney();
    const res = await withdraw(who, { amount: "1000", pin: "000000" }).expect(422);
    expect(res.body.message).toMatch(/PIN/);
    expect(await t.balance(who.id)).toBe("100000");
  });

  it("locks after five wrong PINs, and then refuses even the right one", async () => {
    const { who } = await withMoney();
    for (let i = 0; i < 5; i++) await withdraw(who, { amount: "1000", pin: "000000" }).expect(422);
    await withdraw(who, { amount: "1000", pin: PIN }).expect(429);
    expect(await t.balance(who.id)).toBe("100000");
  });

  it("needs a bank account to be chosen first", async () => {
    const who = await t.ready();
    await t.giveMoney(who.id, "100000");
    const res = await withdraw(who, { amount: "1000", pin: PIN }).expect(409);
    expect(res.body.code).toBe("payout_account_required");
  });

  it.each([["0"], ["-5"], ["1.5"], ["abc"], [""]])(
    "refuses the amount %j, and a PIN that is not six digits",
    async (amount) => {
      const { who } = await withMoney();
      await withdraw(who, { amount, pin: PIN }).expect(400);
      await withdraw(who, { amount: "1000", pin: "12" }).expect(400);
      await withdraw(who, { amount: "1000", pin: PIN }, null).expect(400);
    },
  );

  it("is told apart in the wallet's history, as money out", async () => {
    const { who } = await withMoney();
    await withdraw(who, { amount: "40000", pin: PIN }).expect(200);
    const history = (await who.call("get", "/wallet/transactions").expect(200)).body.items;
    expect(history[0]).toMatchObject({
      type: "withdrawal",
      direction: "out",
      amount: { amount: "40000", currency: "NGN" },
    });
  });
});

describe("the same withdrawal twice", () => {
  it("returns the same one, holds the money once, and asks the bank once", async () => {
    const { who } = await withMoney();
    const k = key();
    const first = await withdraw(who, { amount: "40000", pin: PIN }, k).expect(200);
    const asked = transfers().length;
    const again = await withdraw(who, { amount: "40000", pin: PIN }, k).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(transfers()).toHaveLength(asked);
    expect(await t.balance(who.id)).toBe("60000");
  });

  it("refuses the same key for a different amount", async () => {
    const { who } = await withMoney();
    const k = key();
    await withdraw(who, { amount: "40000", pin: PIN }, k).expect(200);
    const res = await withdraw(who, { amount: "50000", pin: PIN }, k).expect(409);
    expect(res.body.code).toBe("idempotency_key_reused");
  });
});

describe("a withdrawal that is never answered", () => {
  it("is settled by asking the bank, and paid out when the bank says it was paid", async () => {
    const { who } = await withMoney();
    t.fake("NG").behaviour.transfer = "unavailable";
    const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(200);
    const [{ reference }] = await t.db.query(
      "SELECT reference FROM payment_intents WHERE id = $1",
      [res.body.id],
    );
    t.fake("NG").behaviour.transfers.set(reference, "success");
    await stale(res.body.id);

    const looks = await many(10, () => who.call("get", `/payments/${res.body.id}`));
    expect(looks.every((l: { status: number }) => l.status === 200)).toBe(true);
    expect((await who.call("get", `/payments/${res.body.id}`).expect(200)).body.status).toBe(
      "succeeded",
    );
    expect(await t.balance(who.id)).toBe("60000");
    expect(await t.postings(`withdrawal-settled:${res.body.id}`)).toHaveLength(1);
  });

  it("gives the money back, once, when the bank says it failed", async () => {
    const { who } = await withMoney();
    t.fake("NG").behaviour.transfer = "unavailable";
    const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(200);
    const [{ reference }] = await t.db.query(
      "SELECT reference FROM payment_intents WHERE id = $1",
      [res.body.id],
    );
    t.fake("NG").behaviour.transfers.set(reference, "failed");
    await stale(res.body.id);
    await many(8, () => who.call("get", `/payments/${res.body.id}`));
    expect(await t.balance(who.id)).toBe("100000");
    expect(await t.postings(`withdrawal-reversal:${res.body.id}`)).toHaveLength(1);
  });

  it("asks the bank to send it again, to the account it was made for, when the bank never heard of it", async () => {
    const { who, accountNumber } = await withMoney();
    t.fake("NG").behaviour.transfer = "unavailable";
    const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(200);
    const [{ reference }] = await t.db.query(
      "SELECT reference FROM payment_intents WHERE id = $1",
      [res.body.id],
    );
    // Meanwhile the person changes their account: the retry must still go to the original one.
    await t.payoutAccount(who);
    t.fake("NG").behaviour.transfer = "pending";
    t.fake("NG").behaviour.transfers.set(reference, "not_found");
    await stale(res.body.id);
    const asked = transfers().length;
    await who.call("get", `/payments/${res.body.id}`).expect(200);

    expect(transfers()).toHaveLength(asked + 1);
    expect(transfers().at(-1)).toMatchObject({
      reference,
      recipientCode: recipientFor(accountNumber),
      amount: "40000",
    });
  });

  it("is left alone while the bank still says it is pending, and not asked about on every look", async () => {
    const { who } = await withMoney();
    const res = await withdraw(who, { amount: "40000", pin: PIN }).expect(200);
    const before = t.fake("NG").count("verifyTransfer");
    await who.call("get", `/payments/${res.body.id}`).expect(200);
    await who.call("get", `/payments/${res.body.id}`).expect(200);
    expect(t.fake("NG").count("verifyTransfer")).toBe(before);
    await stale(res.body.id);
    expect((await who.call("get", `/payments/${res.body.id}`).expect(200)).body.status).toBe(
      "pending",
    );
    expect(await t.balance(who.id)).toBe("60000");
  });
});
