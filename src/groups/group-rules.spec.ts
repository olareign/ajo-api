import {
  earlySpots,
  groupProblem,
  isEarly,
  potOf,
  roundDates,
  type GroupInput,
} from "./group-rules.js";

describe("the turns of a circle", () => {
  it("counts the first third, rounded up, as early", () => {
    expect([3, 6, 9, 10, 12, 30].map(earlySpots)).toEqual([1, 2, 3, 4, 4, 10]);
    expect(isEarly(1, 9)).toBe(true);
    expect(isEarly(3, 9)).toBe(true);
    expect(isEarly(4, 9)).toBe(false);
    expect(isEarly(0, 9)).toBe(false);
  });

  it("collects every week, fortnight or month from the start, with a short month not dragging the rest", () => {
    expect(roundDates("2026-11-02", "weekly", 3)).toEqual([
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
    ]);
    expect(roundDates("2026-11-02", "biweekly", 3)).toEqual([
      "2026-11-02",
      "2026-11-16",
      "2026-11-30",
    ]);
    expect(roundDates("2026-01-31", "monthly", 3)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
  });

  it("works out a pot as everyone's contribution", () => {
    expect(potOf(500_000n, 10)).toBe(5_000_000n);
  });
});

describe("what a circle may be", () => {
  const good: GroupInput = {
    name: "Cousins",
    contribution: "1000000",
    frequency: "monthly",
    size: 6,
    startDate: "2026-11-15",
    orderMethod: "random",
    visibility: "private",
  };
  const today = "2026-10-04";

  it("accepts a sensible circle", () => {
    expect(groupProblem(good, "NGN", today)).toBeNull();
    expect(groupProblem({ ...good, community: "Lekki book club" }, "NGN", today)).toBeNull();
  });

  it.each([
    ["no name", { name: "  " }],
    ["a long name", { name: "x".repeat(61) }],
    ["an empty community", { community: "  " }],
    ["too small a contribution", { contribution: "99999" }],
    ["too large a contribution", { contribution: "100000001" }],
    ["a fractional contribution", { contribution: "1.5" }],
    ["two people", { size: 2 }],
    ["thirty-one people", { size: 31 }],
    ["a fractional size", { size: 5.5 }],
    ["a start today", { startDate: "2026-10-04" }],
    ["a start in the past", { startDate: "2026-09-01" }],
    ["a start too far ahead", { startDate: "2027-03-01" }],
    ["a date that is not one", { startDate: "2026-02-30" }],
  ])("refuses %s", (_name, over) => {
    expect(groupProblem({ ...good, ...over } as GroupInput, "NGN", today)).toEqual(
      expect.any(String),
    );
  });

  it("knows each currency, and refuses one it has no limits for", () => {
    expect(groupProblem({ ...good, contribution: "1000" }, "GBP", today)).toBeNull();
    expect(groupProblem({ ...good, contribution: "999" }, "GBP", today)).toEqual(
      expect.any(String),
    );
    expect(groupProblem(good, "USD", today)).toMatch(/currency/);
  });
});
