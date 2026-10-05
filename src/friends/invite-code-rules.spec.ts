import { codeProblem, normalizeCode } from "./invite-code-rules.js";

describe("invite code rules", () => {
  it("takes 4 to 20 letters, numbers, - and _, in capitals, starting and ending with a letter or number", () => {
    for (const code of ["ADA1", "ADA-SAVES", "LAGOS_2026", "K7M2QH9R", "A".repeat(20)]) {
      expect(codeProblem(code)).toBeNull();
    }
    for (const code of [
      "ADA",
      "A".repeat(21),
      "-ADA",
      "ADA_",
      "ADA SAVES",
      "ADA!",
      "ada1",
      "ÀJỌ1",
    ]) {
      expect(codeProblem(code)).toBe("invalid");
    }
  });

  it("tidies what was typed to how it is stored", () => {
    expect(normalizeCode("  ada-saves ")).toBe("ADA-SAVES");
  });

  it("refuses codes that would pass for the app or its staff, reserved words, and offensive words, with one answer", () => {
    for (const code of [
      "AJO-SUPPORT",
      "ADMIN",
      "OFFICIALADA",
      "PAYSTACK1",
      "API",
      "JOIN",
      "HELP",
      "FUCK-YOU",
      "A_S_H_A_W_O",
    ]) {
      expect(codeProblem(code)).toBe(code === "API" ? "invalid" : "unavailable");
    }
  });
});
