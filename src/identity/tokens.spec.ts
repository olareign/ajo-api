import { createOneTimeToken, hashToken } from "./tokens.js";

describe("one-time tokens", () => {
  it("are 256-bit URL-safe random strings", () => {
    const { token } = createOneTimeToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createOneTimeToken().token).not.toBe(token);
  });

  it("are stored only as a SHA-256 hash, so a database leak reveals no usable token", () => {
    const { token, hash } = createOneTimeToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
  });
});
