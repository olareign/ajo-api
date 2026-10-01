import { PasswordHasher } from "./password-hasher.js";

describe("PasswordHasher", () => {
  const hasher = new PasswordHasher();

  it("hashes with argon2id and a per-hash salt", async () => {
    const a = await hasher.hash("correct horse battery staple");
    const b = await hasher.hash("correct horse battery staple");
    const params = a.split("$")[3]!.split(",").sort();
    expect(a.startsWith("$argon2id$v=19$")).toBe(true);
    expect(params).toEqual(["m=19456", "p=1", "t=2"]);
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct horse");
  });

  it("verifies the right secret and rejects a wrong one", async () => {
    const hash = await hasher.hash("correct horse battery staple");
    expect(await hasher.verify(hash, "correct horse battery staple")).toBe(true);
    expect(await hasher.verify(hash, "correct horse battery stapler")).toBe(false);
  });

  it("treats a malformed stored hash as a failed match, not a crash", async () => {
    expect(await hasher.verify("not-a-hash", "anything")).toBe(false);
  });

  it("can burn the same time as a real check when there is no user, to avoid revealing accounts", async () => {
    await expect(hasher.verifyDummy("anything")).resolves.toBe(false);
  });
});
