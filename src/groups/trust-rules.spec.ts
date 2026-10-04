import { summarise, TRUSTED_AT, type TrustCounts } from "./trust-rules.js";

const base: TrustCounts = {
  onTime: 0,
  late: 0,
  missed: 0,
  completed: 0,
  missedRecently: 0,
  blocked: false,
};

describe("what a record adds up to", () => {
  it("calls someone with nothing on record new, and not trusted", () => {
    expect(summarise(base)).toMatchObject({ score: 0, level: "new", trusted: false });
  });

  it("builds trust payment by payment, and finishing a circle counts for a lot", () => {
    expect(summarise({ ...base, onTime: 3 })).toMatchObject({
      score: 15,
      level: "building",
      trusted: false,
    });
    expect(summarise({ ...base, onTime: 8 })).toMatchObject({
      score: 40,
      level: "trusted",
      trusted: true,
    });
    expect(summarise({ ...base, onTime: 4, completed: 1 }).trusted).toBe(true);
    expect(TRUSTED_AT).toBe(40);
  });

  it("takes points off for late and missed payments, and never goes below nothing or above a hundred", () => {
    expect(summarise({ ...base, onTime: 10, late: 2 }).score).toBe(30);
    expect(summarise({ ...base, onTime: 2, missed: 3 }).score).toBe(0);
    expect(summarise({ ...base, completed: 20 }).score).toBe(100);
  });

  it("does not trust anyone who missed a payment lately or is blocked, however high their score", () => {
    const strong = { ...base, onTime: 20, completed: 2 };
    expect(summarise(strong).trusted).toBe(true);
    expect(summarise({ ...strong, missed: 1, missedRecently: 1 })).toMatchObject({
      trusted: false,
      level: "building",
    });
    expect(summarise({ ...strong, blocked: true })).toMatchObject({
      trusted: false,
      level: "building",
    });
  });
});
