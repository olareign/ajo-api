import { ConflictException, Injectable, UnprocessableEntityException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { PostingError, validatePosting, type Posting } from "./posting.js";

export type AccountKind =
  "available" | "locked" | "savings" | "pot" | "fees" | "exchange" | "settlement" | "suspense";

export type PostResult = Readonly<{ id: string; replayed: boolean }>;
type Tx = Parameters<typeof sql>[0];

const CURRENCY = /^[A-Z]{3}$/;

function requestHash(posting: Posting): string {
  const entries = posting.entries.map((e) => `${e.accountId}|${e.direction}|${e.amount}`).sort();
  return createHash("sha256")
    .update(JSON.stringify([posting.type, posting.reference ?? "", entries]))
    .digest("hex");
}

@Injectable()
export class LedgerService {
  constructor(private readonly db: DataSource) {}

  /** The one account for this owner, currency and kind; created on first use. */
  userAccount(userId: string, kind: AccountKind, currency: string, ref?: string): Promise<string> {
    return this.account("user", userId, kind, currency, ref);
  }

  /** Accounts the platform itself holds: partner settlement, fees, group pots, suspense. */
  systemAccount(kind: AccountKind, currency: string, ref?: string): Promise<string> {
    return this.account("system", null, kind, currency, ref);
  }

  private async account(
    ownerType: "user" | "system",
    ownerId: string | null,
    kind: AccountKind,
    currency: string,
    ref?: string,
  ): Promise<string> {
    if (!CURRENCY.test(currency))
      throw new PostingError("currency must be a 3-letter code such as NGN");
    return this.db.transaction(async (tx) => {
      await sql(
        tx,
        `INSERT INTO ledger_accounts (owner_type, owner_id, currency, kind, ref)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [ownerType, ownerId, currency, kind, ref ?? null],
      );
      const [row] = await sql<{ id: string }>(
        tx,
        `SELECT id FROM ledger_accounts
          WHERE owner_type = $1 AND owner_id IS NOT DISTINCT FROM $2 AND currency = $3
            AND kind = $4 AND coalesce(ref, '') = $5`,
        [ownerType, ownerId, currency, kind, ref ?? ""],
      );
      return row!.id;
    });
  }

  /** Credits minus debits, as a whole number in the currency's smallest unit. */
  async balance(accountId: string): Promise<string> {
    const [row] = await this.db.query<{ balance: string }[]>(
      `SELECT coalesce(sum(CASE direction WHEN 'credit' THEN amount ELSE -amount END), 0)::text AS balance
         FROM ledger_entries WHERE account_id = $1`,
      [accountId],
    );
    return row!.balance;
  }

  /**
   * Posts a balanced set of entries once. The same idempotency key with the same request returns the
   * original posting; with a different request it is refused. A person's account can never go below
   * zero: the accounts involved are locked in a fixed order, so simultaneous spends cannot overdraw.
   */
  async post(
    posting: Posting,
    extra: { reverses?: string; reason?: string } = {},
  ): Promise<PostResult> {
    const ids = [...new Set(posting.entries.map((e) => e.accountId))];
    const accounts = await this.db.query<{ id: string; currency: string; owner_type: string }[]>(
      `SELECT id, currency, owner_type FROM ledger_accounts WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const { entries } = validatePosting(posting, new Map(accounts.map((a) => [a.id, a.currency])));
    const hash = requestHash(posting);
    const personal = new Set(accounts.filter((a) => a.owner_type === "user").map((a) => a.id));

    return this.db.transaction(async (tx) => {
      const inserted = await sql<{ id: string }>(
        tx,
        `INSERT INTO ledger_transactions (type, idempotency_key, request_hash, reference, reverses, reason)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [
          posting.type,
          posting.idempotencyKey,
          hash,
          posting.reference ?? null,
          extra.reverses ?? null,
          extra.reason ?? null,
        ],
      );
      if (inserted.length === 0) return this.replay(tx, posting.idempotencyKey, hash);
      const transactionId = inserted[0]!.id;

      // Lock in a fixed order, then check that no person's account would go negative.
      const locked = await sql<{ id: string }>(
        tx,
        `SELECT id FROM ledger_accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
        [[...ids].sort()],
      );
      if (locked.length !== ids.length) throw new PostingError("unknown account");
      for (const id of personal) {
        const net = entries
          .filter((e) => e.accountId === id)
          .reduce((n, e) => (e.direction === "credit" ? n + e.amount : n - e.amount), 0n);
        if (net >= 0n) continue;
        const [row] = await sql<{ balance: string }>(
          tx,
          `SELECT coalesce(sum(CASE direction WHEN 'credit' THEN amount ELSE -amount END), 0)::text AS balance
             FROM ledger_entries WHERE account_id = $1`,
          [id],
        );
        if (BigInt(row!.balance) + net < 0n) {
          throw new UnprocessableEntityException("Insufficient funds.");
        }
      }
      for (const entry of entries) {
        await sql(
          tx,
          `INSERT INTO ledger_entries (transaction_id, account_id, currency, amount, direction)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            transactionId,
            entry.accountId,
            entry.currency,
            entry.amount.toString(),
            entry.direction,
          ],
        );
      }
      return { id: transactionId, replayed: false };
    });
  }

  private async replay(tx: Tx, key: string, hash: string): Promise<PostResult> {
    const [existing] = await sql<{ id: string; request_hash: string }>(
      tx,
      `SELECT id, request_hash FROM ledger_transactions WHERE idempotency_key = $1`,
      [key],
    );
    if (!existing || existing.request_hash !== hash) {
      throw new ConflictException("That idempotency key was already used for a different request.");
    }
    return { id: existing.id, replayed: true };
  }

  /** Undoes a posting with new opposite entries; the original stays as it was. Only once. */
  async reverse(
    transactionId: string,
    options: { idempotencyKey: string; reason: string },
  ): Promise<PostResult> {
    const [original] = await this.db.query<{ id: string; type: string; reverses: string | null }[]>(
      `SELECT id, type, reverses FROM ledger_transactions WHERE id = $1`,
      [transactionId],
    );
    if (!original) throw new PostingError("no such transaction");
    const [done] = await this.db.query<{ id: string }[]>(
      `SELECT id FROM ledger_transactions WHERE reverses = $1`,
      [transactionId],
    );
    if (done) throw new ConflictException("That transaction was already reversed.");
    const rows = await this.db.query<
      { account_id: string; direction: "debit" | "credit"; amount: string }[]
    >(
      `SELECT account_id, direction, amount::text FROM ledger_entries WHERE transaction_id = $1 ORDER BY id`,
      [transactionId],
    );
    return this.post(
      {
        type: `reversal:${original.type}`.slice(0, 64),
        idempotencyKey: options.idempotencyKey,
        reference: transactionId,
        entries: rows.map((r) => ({
          accountId: r.account_id,
          direction: r.direction === "debit" ? "credit" : "debit",
          amount: r.amount,
        })),
      },
      { reverses: transactionId, reason: options.reason },
    );
  }
}
