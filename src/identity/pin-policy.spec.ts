import { isAcceptablePin } from "./pin-policy.js";

describe("isAcceptablePin", () => {
  it("accepts ordinary six-digit PINs", () => {
    for (const pin of ["493817", "718204", "100234"]) expect(isAcceptablePin(pin)).toBe(true);
  });
  it("rejects wrong shapes", () => {
    for (const pin of ["12345", "1234567", "abcdef", "", "12 456", "४९३८१७"])
      expect(isAcceptablePin(pin)).toBe(false);
  });
  it("rejects repeats, runs and doubled halves", () => {
    for (const pin of ["000000", "111111", "123456", "234567", "654321", "987654", "123123"])
      expect(isAcceptablePin(pin)).toBe(false);
  });
});
