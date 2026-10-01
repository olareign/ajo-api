export type Direction = "debit" | "credit";

export type PostingEntry = Readonly<{
  accountId: string;
  direction: Direction;
  /** Integer in the currency's smallest unit (kobo, pence, cents), as a string; never a decimal. */
  amount: string;
}>;

export type Posting = Readonly<{
  type: string;
  /** Repeating a request with the same key returns the original posting instead of posting again. */
  idempotencyKey: string;
  reference?: string;
  entries: readonly PostingEntry[];
}>;

export type ValidEntry = Readonly<{
  accountId: string;
  direction: Direction;
  amount: bigint;
  currency: string;
}>;

export class PostingError extends Error {
  override name = "PostingError";
}

/** Largest value a Postgres bigint column holds. */
export const MAX_AMOUNT = 9_223_372_036_854_775_807n;
const AMOUNT = /^[1-9]\d{0,18}$/;

/**
 * The rules every posting must meet before it reaches the database (which enforces them again):
 * at least two entries, whole positive amounts, known accounts, and debits equal to credits in
 * each currency separately, so currencies are never mixed.
 */
export function validatePosting(
  posting: Posting,
  currencies: ReadonlyMap<string, string>,
): { entries: ValidEntry[] } {
  const key = posting.idempotencyKey;
  if (key.length < 1 || key.length > 200)
    throw new PostingError("idempotencyKey must be 1 to 200 characters");
  if (posting.entries.length < 2) throw new PostingError("a posting needs at least two entries");

  const totals = new Map<string, { debit: bigint; credit: bigint }>();
  const entries: ValidEntry[] = posting.entries.map((entry) => {
    if (!AMOUNT.test(entry.amount)) throw new PostingError("amounts are whole numbers above zero");
    const amount = BigInt(entry.amount);
    if (amount > MAX_AMOUNT) throw new PostingError("amount is too large");
    const currency = currencies.get(entry.accountId);
    if (!currency) throw new PostingError(`unknown account ${entry.accountId}`);
    const total = totals.get(currency) ?? { debit: 0n, credit: 0n };
    total[entry.direction] += amount;
    totals.set(currency, total);
    return { accountId: entry.accountId, direction: entry.direction, amount, currency };
  });

  for (const [currency, total] of totals) {
    if (total.debit !== total.credit) {
      throw new PostingError(`debits and credits differ in currency ${currency}`);
    }
  }
  return { entries };
}
