import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { DataSource } from "typeorm";
import { LedgerService } from "../../src/ledger/ledger.service.js";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
let ledger: LedgerService;
const http = () => app.getHttpServer();

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
  ledger = app.get(LedgerService);
});
afterAll(async () => {
  await app?.close();
});

async function signedIn() {
  const user = await createVerifiedUser(app);
  const { accessToken } = (
    await request(http())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .send({ email: user.email, password: user.password })
      .expect(200)
  ).body;
  const [{ id }] = await db.query("SELECT id FROM users WHERE email = $1", [user.email]);
  return { token: accessToken as string, id: id as string };
}
const get = (path: string, token?: string) => {
  const r = request(http()).get(path).set("X-Forwarded-For", newIp());
  return token ? r.set("Authorization", `Bearer ${token}`) : r;
};
async function fund(userId: string, amount: string, currency = "NGN") {
  return ledger.post({
    type: "funding",
    idempotencyKey: `f-${randomUUID()}`,
    entries: [
      { accountId: await ledger.systemAccount("settlement", currency), direction: "debit", amount },
      {
        accountId: await ledger.userAccount(userId, "available", currency),
        direction: "credit",
        amount,
      },
    ],
  });
}
async function lock(userId: string, amount: string, currency = "NGN") {
  return ledger.post({
    type: "deposit_lock",
    idempotencyKey: `l-${randomUUID()}`,
    entries: [
      {
        accountId: await ledger.userAccount(userId, "available", currency),
        direction: "debit",
        amount,
      },
      {
        accountId: await ledger.userAccount(userId, "locked", currency),
        direction: "credit",
        amount,
      },
    ],
  });
}

describe("GET /wallet", () => {
  it("needs a signed-in user", async () => {
    await get("/api/v1/wallet").expect(401);
  });

  it("is empty for someone with no money yet", async () => {
    const { token } = await signedIn();
    const res = await get("/api/v1/wallet", token).expect(200);
    expect(res.body).toEqual({ wallets: [] });
  });

  it("shows available, locked and savings per currency, as whole numbers in the smallest unit", async () => {
    const { token, id } = await signedIn();
    await fund(id, "500000");
    await lock(id, "120000");
    await fund(id, "2500", "GBP");
    const res = await get("/api/v1/wallet", token).expect(200);
    const ngn = res.body.wallets.find((w: { currency: string }) => w.currency === "NGN");
    expect(ngn).toEqual({
      currency: "NGN",
      available: { amount: "380000", currency: "NGN" },
      locked: { amount: "120000", currency: "NGN" },
      savings: { amount: "0", currency: "NGN" },
    });
    const gbp = res.body.wallets.find((w: { currency: string }) => w.currency === "GBP");
    expect(gbp.available).toEqual({ amount: "2500", currency: "GBP" });
  });

  it("adds up every savings plan under one savings figure", async () => {
    const { token, id } = await signedIn();
    await fund(id, "10000");
    for (const [plan, amount] of [
      ["plan-a", "3000"],
      ["plan-b", "2000"],
    ] as const) {
      await ledger.post({
        type: "savings_deposit",
        idempotencyKey: `s-${randomUUID()}`,
        entries: [
          {
            accountId: await ledger.userAccount(id, "available", "NGN"),
            direction: "debit",
            amount,
          },
          {
            accountId: await ledger.userAccount(id, "savings", "NGN", plan),
            direction: "credit",
            amount,
          },
        ],
      });
    }
    const res = await get("/api/v1/wallet", token).expect(200);
    expect(res.body.wallets[0].savings.amount).toBe("5000");
    expect(res.body.wallets[0].available.amount).toBe("5000");
  });

  it("never shows another person's money", async () => {
    const a = await signedIn();
    const b = await signedIn();
    await fund(a.id, "777");
    const res = await get("/api/v1/wallet", b.token).expect(200);
    expect(res.body.wallets).toEqual([]);
  });
});

describe("GET /wallet/transactions", () => {
  it("lists the person's movements, newest first, with direction and amount", async () => {
    const { token, id } = await signedIn();
    await fund(id, "1000");
    await lock(id, "400");
    const res = await get("/api/v1/wallet/transactions", token).expect(200);
    expect(
      res.body.items.map(
        (i: { type: string; account: string; direction: string; amount: { amount: string } }) => [
          i.type,
          i.account,
          i.direction,
          i.amount.amount,
        ],
      ),
    ).toEqual([
      ["deposit_lock", "locked", "in", "400"],
      ["deposit_lock", "available", "out", "400"],
      ["funding", "available", "in", "1000"],
    ]);
    expect(res.body.next).toBeNull();
    expect(res.body.items[0]).toMatchObject({
      currency: "NGN",
      createdAt: expect.any(String),
      id: expect.any(String),
    });
  });

  it("pages with a cursor and does not repeat or skip rows", async () => {
    const { token, id } = await signedIn();
    for (let i = 0; i < 5; i++) await fund(id, String(100 + i));
    const first = await get("/api/v1/wallet/transactions?limit=2", token).expect(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.next).toEqual(expect.any(String));
    const second = await get(
      `/api/v1/wallet/transactions?limit=2&before=${first.body.next}`,
      token,
    ).expect(200);
    const third = await get(
      `/api/v1/wallet/transactions?limit=2&before=${second.body.next}`,
      token,
    ).expect(200);
    const all = [...first.body.items, ...second.body.items, ...third.body.items].map(
      (i: { id: string }) => i.id,
    );
    expect(new Set(all).size).toBe(5);
    expect(third.body.next).toBeNull();
  });

  it("refuses an out-of-range limit or a bad cursor", async () => {
    const { token } = await signedIn();
    await get("/api/v1/wallet/transactions?limit=0", token).expect(400);
    await get("/api/v1/wallet/transactions?limit=500", token).expect(400);
    await get("/api/v1/wallet/transactions?before=abc", token).expect(400);
  });

  it("only shows the caller's own entries", async () => {
    const a = await signedIn();
    const b = await signedIn();
    await fund(a.id, "10");
    const res = await get("/api/v1/wallet/transactions", b.token).expect(200);
    expect(res.body.items).toEqual([]);
  });
});
