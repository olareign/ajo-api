import { normalizePhone } from "./phone.js";

describe("phone numbers", () => {
  it("reads local numbers by the account's country", () => {
    expect(normalizePhone("0803 123 4567", "NG")).toBe("+2348031234567");
    expect(normalizePhone("07700 900123", "GB")).toBe("+447700900123");
  });

  it("keeps international numbers, with + or 00, ignoring spacing", () => {
    expect(normalizePhone("+234 (803) 123-4567", "GB")).toBe("+2348031234567");
    expect(normalizePhone("0044 7700 900123", "NG")).toBe("+447700900123");
  });

  it("refuses what can't be a phone number", () => {
    for (const raw of [
      "",
      "12345",
      "0803123",
      "+0123456789",
      "phone",
      "+1234567890123456",
      "0803 123 4567",
    ]) {
      expect(normalizePhone(raw, raw === "0803 123 4567" ? null : "NG")).toBeNull();
    }
  });
});
