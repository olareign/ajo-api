import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { LedgerService } from "../../src/ledger/ledger.service.js";
import { PostingError } from "../../src/ledger/posting.js";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
let ledger: LedgerService;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
  ledger = app.get(LedgerService);
});
afterAll(async () => {
  await app?.close();
});

async function newUser() {
  const { email } = await createVerifiedUser(app);
  const [{ id }] = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  return id as string;
}
async function fund(userId: string, amount: string, currency = "NGN") {
  const settlement = await ledger.systemAccount("settlement", currency);
  const wallet = await ledger.userAccount(userId, "available", currency);
  return ledger.post({
    type: "funding",
    idempotencyKey: `fund-${randomUUID()}`,
    entries: [
      { accountId: settlement, direction: "debit", amount },
      { accountId: wallet, direction: "credit", amount },
    ],
  });
}

describe("accounts", () => {
  it("creates an account once per owner, currency and kind, and returns the same one again", async () => {
    const user = await newUser();
    const a = await ledger.userAccount(user, "available", "NGN");
    const b = await ledger.userAccount(user, "available", "NGN");
    const other = await ledger.userAccount(user, "available", "GBP");
    expect(b).toBe(a);
    expect(other).not.toBe(a);
  });

  it("makes concurrent first requests agree on one account", async () => {
    const user = await newUser();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => ledger.userAccount(user, "locked", "NGN")),
    );
    expect(new Set(ids).size).toBe(1);
  });

  it("refuses a malformed currency", async () => {
    const user = await newUser();
    await expect(ledger.userAccount(user, "available", "naira")).rejects.toThrow();
  });
});

describe("posting", () => {
  it("moves money and derives balances from entries", async () => {
    const user = await newUser();
    await fund(user, "250000");
    expect(await ledger.balance(await ledger.userAccount(user, "available", "NGN"))).toBe("250000");
    expect(await ledger.balance(await ledger.systemAccount("settlement", "NGN"))).toMatch(
      /^-?\d+$/,
    );
  });

  it("returns the original posting when the same idempotency key is sent again, without posting twice", async () => {
    const user = await newUser();
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const settlement = await ledger.systemAccount("settlement", "NGN");
    const request = {
      type: "funding",
      idempotencyKey: `once-${randomUUID()}`,
      entries: [
        { accountId: settlement, direction: "debit" as const, amount: "1000" },
        { accountId: wallet, direction: "credit" as const, amount: "1000" },
      ],
    };
    const first = await ledger.post(request);
    const second = await ledger.post(request);
    expect(second.id).toBe(first.id);
    expect(second.replayed).toBe(true);
    expect(await ledger.balance(wallet)).toBe("1000");
  });

  it("refuses the same key with a different request, since that is a bug on the caller's side", async () => {
    const user = await newUser();
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const settlement = await ledger.systemAccount("settlement", "NGN");
    const key = `clash-${randomUUID()}`;
    const entries = (amount: string) => [
      { accountId: settlement, direction: "debit" as const, amount },
      { accountId: wallet, direction: "credit" as const, amount },
    ];
    await ledger.post({ type: "funding", idempotencyKey: key, entries: entries("100") });
    await expect(
      ledger.post({ type: "funding", idempotencyKey: key, entries: entries("200") }),
    ).rejects.toThrow(/idempotency/i);
  });

  it("makes concurrent identical requests post exactly once", async () => {
    const user = await newUser();
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const settlement = await ledger.systemAccount("settlement", "NGN");
    const request = {
      type: "funding",
      idempotencyKey: `race-${randomUUID()}`,
      entries: [
        { accountId: settlement, direction: "debit" as const, amount: "700" },
        { accountId: wallet, direction: "credit" as const, amount: "700" },
      ],
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => ledger.post(request)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await ledger.balance(wallet)).toBe("700");
  });

  it("never lets a person's account go below zero, and posts nothing when it would", async () => {
    const user = await newUser();
    await fund(user, "1000");
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const locked = await ledger.userAccount(user, "locked", "NGN");
    await expect(
      ledger.post({
        type: "lock",
        idempotencyKey: `over-${randomUUID()}`,
        entries: [
          { accountId: wallet, direction: "debit", amount: "1001" },
          { accountId: locked, direction: "credit", amount: "1001" },
        ],
      }),
    ).rejects.toThrow(/insufficient/i);
    expect(await ledger.balance(wallet)).toBe("1000");
    expect(await ledger.balance(locked)).toBe("0");
  });

  it("keeps two simultaneous spends from overdrawing one wallet", async () => {
    const user = await newUser();
    await fund(user, "1000");
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const locked = await ledger.userAccount(user, "locked", "NGN");
    const spend = () =>
      ledger.post({
        type: "lock",
        idempotencyKey: `spend-${randomUUID()}`,
        entries: [
          { accountId: wallet, direction: "debit", amount: "600" },
          { accountId: locked, direction: "credit", amount: "600" },
        ],
      });
    const results = await Promise.allSettled([spend(), spend(), spend()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await ledger.balance(wallet)).toBe("400");
    expect(await ledger.balance(locked)).toBe("600");
  });

  it("refuses an unbalanced posting before touching the database", async () => {
    const user = await newUser();
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const settlement = await ledger.systemAccount("settlement", "NGN");
    await expect(
      ledger.post({
        type: "funding",
        idempotencyKey: `bad-${randomUUID()}`,
        entries: [
          { accountId: settlement, direction: "debit", amount: "100" },
          { accountId: wallet, direction: "credit", amount: "90" },
        ],
      }),
    ).rejects.toThrow(PostingError);
  });

  it("keeps each currency separate", async () => {
    const user = await newUser();
    await fund(user, "5000", "NGN");
    await fund(user, "300", "GBP");
    expect(await ledger.balance(await ledger.userAccount(user, "available", "NGN"))).toBe("5000");
    expect(await ledger.balance(await ledger.userAccount(user, "available", "GBP"))).toBe("300");
  });
});

describe("the database refuses what the application should never do", () => {
  async function aPosting() {
    const user = await newUser();
    const tx = await fund(user, "1000");
    return { user, tx };
  }

  it("rejects editing a posted entry", async () => {
    const { tx } = await aPosting();
    await expect(
      db.query("UPDATE ledger_entries SET amount = 1 WHERE transaction_id = $1", [tx.id]),
    ).rejects.toThrow(/immutable|not allowed/i);
  });

  it("rejects deleting a posted entry or a transaction", async () => {
    const { tx } = await aPosting();
    await expect(
      db.query("DELETE FROM ledger_entries WHERE transaction_id = $1", [tx.id]),
    ).rejects.toThrow(/immutable|not allowed/i);
    await expect(
      db.query("DELETE FROM ledger_transactions WHERE id = $1", [tx.id]),
    ).rejects.toThrow();
  });

  it("rejects an unbalanced transaction at commit, whatever wrote it", async () => {
    const user = await newUser();
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const settlement = await ledger.systemAccount("settlement", "NGN");
    await expect(
      db.transaction(async (m) => {
        const [t] = await m.query(
          "INSERT INTO ledger_transactions (type, idempotency_key) VALUES ('funding', $1) RETURNING id",
          [`raw-${randomUUID()}`],
        );
        await m.query(
          "INSERT INTO ledger_entries (transaction_id, account_id, currency, amount, direction) VALUES ($1,$2,'NGN',100,'debit'), ($1,$3,'NGN',99,'credit')",
          [t.id, settlement, wallet],
        );
      }),
    ).rejects.toThrow(/balance/i);
  });

  it("rejects an entry whose currency differs from its account's", async () => {
    const user = await newUser();
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const settlement = await ledger.systemAccount("settlement", "NGN");
    await expect(
      db.transaction(async (m) => {
        const [t] = await m.query(
          "INSERT INTO ledger_transactions (type, idempotency_key) VALUES ('funding', $1) RETURNING id",
          [`cur-${randomUUID()}`],
        );
        await m.query(
          "INSERT INTO ledger_entries (transaction_id, account_id, currency, amount, direction) VALUES ($1,$2,'GBP',100,'debit'), ($1,$3,'GBP',100,'credit')",
          [t.id, settlement, wallet],
        );
      }),
    ).rejects.toThrow(/currency/i);
  });

  it("rejects zero, negative and non-integer amounts", async () => {
    const user = await newUser();
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const settlement = await ledger.systemAccount("settlement", "NGN");
    for (const amount of ["0", "-5"]) {
      await expect(
        db.transaction(async (m) => {
          const [t] = await m.query(
            "INSERT INTO ledger_transactions (type, idempotency_key) VALUES ('funding', $1) RETURNING id",
            [`amt-${randomUUID()}`],
          );
          await m.query(
            `INSERT INTO ledger_entries (transaction_id, account_id, currency, amount, direction) VALUES ($1,$2,'NGN',${amount},'debit'), ($1,$3,'NGN',${amount},'credit')`,
            [t.id, settlement, wallet],
          );
        }),
      ).rejects.toThrow();
    }
  });

  it("rejects adding entries to a transaction after it was posted, even balanced ones", async () => {
    const { user, tx } = await aPosting();
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const settlement = await ledger.systemAccount("settlement", "NGN");
    await expect(
      db.query(
        "INSERT INTO ledger_entries (transaction_id, account_id, currency, amount, direction) VALUES ($1,$2,'NGN',5,'debit'), ($1,$3,'NGN',5,'credit')",
        [tx.id, settlement, wallet],
      ),
    ).rejects.toThrow();
  });

  it("rejects changing an account's currency or owner", async () => {
    const user = await newUser();
    const wallet = await ledger.userAccount(user, "available", "NGN");
    await expect(
      db.query("UPDATE ledger_accounts SET currency = 'GBP' WHERE id = $1", [wallet]),
    ).rejects.toThrow();
  });
});

describe("reversals", () => {
  it("corrects a posting with new opposite entries and leaves the original untouched", async () => {
    const user = await newUser();
    const original = await fund(user, "900");
    const wallet = await ledger.userAccount(user, "available", "NGN");
    const reversal = await ledger.reverse(original.id, {
      idempotencyKey: `rev-${randomUUID()}`,
      reason: "provider reversed the charge",
    });
    expect(reversal.id).not.toBe(original.id);
    expect(await ledger.balance(wallet)).toBe("0");
    const rows = await db.query(
      "SELECT count(*)::int AS n FROM ledger_entries WHERE transaction_id = $1",
      [original.id],
    );
    expect(rows[0].n).toBe(2);
    await expect(
      ledger.reverse(original.id, { idempotencyKey: `rev-${randomUUID()}`, reason: "again" }),
    ).rejects.toThrow(/already reversed/i);
  });
});
