import { convertMinor, crossRate } from "./convert.js";

describe("convertMinor", () => {
  it("converts through the shared base exactly", () => {
    // ₦1,500.00 at 1500 NGN and 0.75 GBP to the dollar is £0.75.
    expect(convertMinor(150_000n, 1500, 0.75)).toBe(75n);
    // £100.00 at 0.75 GBP and 0.9 EUR to the dollar is €120.00.
    expect(convertMinor(10_000n, 0.75, 0.9)).toBe(12_000n);
  });

  it("rounds half away from zero, in minor units", () => {
    // ₦10.00 at 1500 → £0.005, which rounds to £0.01.
    expect(convertMinor(1_000n, 1500, 0.75)).toBe(1n);
    expect(convertMinor(-1_000n, 1500, 0.75)).toBe(-1n);
    expect(convertMinor(999n, 1500, 0.75)).toBe(0n);
  });

  it("handles very large balances without losing a kobo", () => {
    // ₦9,000,000,000,000.00 at 1500 → $6,000,000,000.00 exactly.
    expect(convertMinor(900_000_000_000_000n, 1500, 1)).toBe(600_000_000_000n);
  });

  it("refuses a rate that is zero, negative or not a number", () => {
    expect(() => convertMinor(100n, 0, 1)).toThrow();
    expect(() => convertMinor(100n, 1, -1)).toThrow();
    expect(() => convertMinor(100n, Number.NaN, 1)).toThrow();
  });
});

describe("crossRate", () => {
  it("says how much one unit buys, to six significant figures", () => {
    expect(crossRate(1500, 0.75)).toBe("0.0005");
    expect(crossRate(0.75, 1500)).toBe("2000");
    expect(crossRate(1532.4567, 0.78123)).toBe("0.000509789");
  });
});
