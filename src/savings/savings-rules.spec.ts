import {
  addDays,
  daysBetween,
  isDate,
  planProblem,
  scheduleDates,
  todayIn,
  zoneFor,
  type PlanInput,
} from "./savings-rules.js";

describe("working out the days", () => {
  it("counts daily and weekly debits from the start", () => {
    expect(scheduleDates("2026-10-30", "daily", 4)).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
    expect(scheduleDates("2026-12-28", "weekly", 3)).toEqual([
      "2026-12-28",
      "2027-01-04",
      "2027-01-11",
    ]);
  });

  it("keeps the same day each month, and a short month does not drag the later ones", () => {
    expect(scheduleDates("2026-01-31", "monthly", 4)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
    expect(scheduleDates("2028-01-31", "monthly", 2)).toEqual(["2028-01-31", "2028-02-29"]);
    expect(scheduleDates("2026-11-15", "monthly", 3)).toEqual([
      "2026-11-15",
      "2026-12-15",
      "2027-01-15",
    ]);
  });

  it("knows real dates from impossible ones", () => {
    expect(isDate("2026-02-29")).toBe(false);
    expect(isDate("2028-02-29")).toBe(true);
    expect(isDate("2026-13-01")).toBe(false);
    expect(isDate("26-1-1")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
  });

  it("says what day it is where the person lives, not in UTC", () => {
    const lateInTheUk = new Date("2026-06-30T23:30:00Z"); // already 1 July in London (BST) and in Lagos
    expect(todayIn("GBP", lateInTheUk)).toBe("2026-07-01");
    expect(todayIn("NGN", lateInTheUk)).toBe("2026-07-01");
    expect(todayIn("NGN", new Date("2026-06-30T22:59:00Z"))).toBe("2026-06-30");
    expect(zoneFor("NGN")).toBe("Africa/Lagos");
  });
});

describe("what a plan may be", () => {
  const good: PlanInput = {
    name: "Rent",
    amount: "500000",
    frequency: "weekly",
    totalDebits: 12,
    startDate: "2026-10-10",
  };
  const today = "2026-10-04";

  it("accepts a sensible plan, starting today or soon", () => {
    expect(planProblem(good, "NGN", today)).toBeNull();
    expect(planProblem({ ...good, startDate: today }, "NGN", today)).toBeNull();
  });

  it.each([
    ["no name", { name: "   " }],
    ["a long name", { name: "x".repeat(61) }],
    ["an amount that is not whole minor units", { amount: "12.5" }],
    ["an amount of nothing", { amount: "0" }],
    ["too little each time", { amount: "9999" }],
    ["too much each time", { amount: "500000001" }],
    ["one debit", { totalDebits: 1 }],
    ["a fractional count", { totalDebits: 2.5 }],
    ["too many weekly debits", { totalDebits: 105 }],
    ["a date that is not one", { startDate: "2026-02-30" }],
    ["yesterday", { startDate: "2026-10-03" }],
    ["too far ahead", { startDate: "2027-01-10" }],
  ])("refuses %s", (_name, over) => {
    expect(planProblem({ ...good, ...over } as PlanInput, "NGN", today)).toEqual(
      expect.any(String),
    );
  });

  it("knows each currency's own limits, and refuses one it has none for", () => {
    expect(planProblem({ ...good, amount: "100" }, "GBP", today)).toBeNull();
    expect(planProblem({ ...good, amount: "99" }, "GBP", today)).toEqual(expect.any(String));
    expect(planProblem(good, "USD", today)).toMatch(/currency/);
  });
});
