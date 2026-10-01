import { checkPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password-policy.js";

const neverBreached = { isBreached: async () => false };
const alwaysBreached = { isBreached: async () => true };

describe("checkPassword", () => {
  it("accepts a long passphrase", async () => {
    expect(
      await checkPassword("correct horse battery staple", "ada@example.com", neverBreached),
    ).toEqual([]);
  });

  it(`needs at least ${MIN_PASSWORD_LENGTH} characters`, async () => {
    expect(await checkPassword("Short1!aaaa", "ada@example.com", neverBreached)).toEqual([
      "too_short",
    ]);
  });

  it(`caps length at ${MAX_PASSWORD_LENGTH} characters so hashing cannot be abused`, async () => {
    expect(await checkPassword("x".repeat(129), "ada@example.com", neverBreached)).toEqual([
      "too_long",
    ]);
  });

  it("counts characters, not bytes, so non-Latin passphrases are fair", async () => {
    expect(await checkPassword("ẹ".repeat(12), "ada@example.com", neverBreached)).toEqual([]);
  });

  it("counts an emoji or a decomposed accented letter as one character", async () => {
    expect(await checkPassword("👍🏽".repeat(11), "ada@example.com", neverBreached)).toEqual([
      "too_short",
    ]);
    expect(await checkPassword("e\u0323".repeat(12), "ada@example.com", neverBreached)).toEqual([]);
  });

  it("rejects passwords known from data breaches", async () => {
    expect(await checkPassword("password123456", "ada@example.com", alwaysBreached)).toEqual([
      "breached",
    ]);
  });

  it("rejects passwords that contain the email's name part", async () => {
    expect(await checkPassword("my-adaobi-is-great", "Adaobi@example.com", neverBreached)).toEqual([
      "contains_email",
    ]);
  });

  it("does not call the breach service for a password that already fails locally", async () => {
    const checker = { isBreached: vi.fn(async () => false) };
    await checkPassword("short", "a@b.co", checker);
    expect(checker.isBreached).not.toHaveBeenCalled();
  });
});
