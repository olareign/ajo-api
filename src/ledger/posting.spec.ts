import { PostingError, validatePosting, type Posting } from "./posting.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const ngn = new Map([
  [A, "NGN"],
  [B, "NGN"],
]);
const base: Posting = {
  type: "funding",
  idempotencyKey: "fund-1",
  entries: [
    { accountId: A, direction: "debit", amount: "500000" },
    { accountId: B, direction: "credit", amount: "500000" },
  ],
};

describe("validatePosting", () => {
  it("accepts two balanced entries and returns each in its currency, as bigint", () => {
    const out = validatePosting(base, ngn);
    expect(out.entries.map((e) => [e.currency, e.amount])).toEqual([
      ["NGN", 500000n],
      ["NGN", 500000n],
    ]);
  });

  it("accepts splits, so long as debits equal credits", () => {
    const split: Posting = {
      ...base,
      entries: [
        { accountId: A, direction: "debit", amount: "1000" },
        { accountId: B, direction: "credit", amount: "950" },
        { accountId: B, direction: "credit", amount: "50" },
      ],
    };
    expect(() => validatePosting(split, ngn)).not.toThrow();
  });

  it.each([
    [
      "an unbalanced posting",
      [
        { accountId: A, direction: "debit", amount: "100" },
        { accountId: B, direction: "credit", amount: "99" },
      ],
    ],
    ["a single entry", [{ accountId: A, direction: "debit", amount: "100" }]],
    [
      "a zero amount",
      [
        { accountId: A, direction: "debit", amount: "0" },
        { accountId: B, direction: "credit", amount: "0" },
      ],
    ],
    [
      "a negative amount",
      [
        { accountId: A, direction: "debit", amount: "-5" },
        { accountId: B, direction: "credit", amount: "-5" },
      ],
    ],
    [
      "a decimal amount",
      [
        { accountId: A, direction: "debit", amount: "10.5" },
        { accountId: B, direction: "credit", amount: "10.5" },
      ],
    ],
    [
      "an amount with letters",
      [
        { accountId: A, direction: "debit", amount: "1e3" },
        { accountId: B, direction: "credit", amount: "1e3" },
      ],
    ],
    [
      "an amount that does not fit a bigint column",
      [
        { accountId: A, direction: "debit", amount: "9223372036854775808" },
        { accountId: B, direction: "credit", amount: "9223372036854775808" },
      ],
    ],
    [
      "an unknown account",
      [
        { accountId: A, direction: "debit", amount: "1" },
        { accountId: "33333333-3333-4333-8333-333333333333", direction: "credit", amount: "1" },
      ],
    ],
    [
      "only debits",
      [
        { accountId: A, direction: "debit", amount: "1" },
        { accountId: B, direction: "debit", amount: "1" },
      ],
    ],
  ] as const)("refuses %s", (_name, entries) => {
    expect(() => validatePosting({ ...base, entries: [...entries] }, ngn)).toThrow(PostingError);
  });

  it("balances each currency on its own, so currencies are never mixed", () => {
    const mixed = new Map([
      [A, "NGN"],
      [B, "GBP"],
    ]);
    expect(() => validatePosting(base, mixed)).toThrow(/currency/i);
  });

  it("allows a conversion that is balanced in each currency", () => {
    const accounts = new Map([
      [A, "NGN"],
      [B, "NGN"],
      ["c", "GBP"],
      ["d", "GBP"],
    ]);
    const conversion: Posting = {
      type: "conversion",
      idempotencyKey: "fx-1",
      entries: [
        { accountId: A, direction: "debit", amount: "190000" },
        { accountId: B, direction: "credit", amount: "190000" },
        { accountId: "c", direction: "debit", amount: "100" },
        { accountId: "d", direction: "credit", amount: "100" },
      ],
    };
    expect(() => validatePosting(conversion, accounts)).not.toThrow();
  });

  it("needs an idempotency key, so a retried request can never post twice", () => {
    expect(() => validatePosting({ ...base, idempotencyKey: "" }, ngn)).toThrow(PostingError);
    expect(() => validatePosting({ ...base, idempotencyKey: "x".repeat(201) }, ngn)).toThrow(
      PostingError,
    );
  });
});
