import { SignJWT, UnsecuredJWT } from "jose";
import { AccessTokens, ACCESS_TOKEN_TTL_SECONDS } from "./access-tokens.js";

const secret = "a".repeat(48);
const other = "b".repeat(48);

describe("AccessTokens", () => {
  const tokens = new AccessTokens(secret);

  it("issues a short-lived token naming the user and the session", async () => {
    const { token, expiresIn } = await tokens.issue({ userId: "u1", sessionId: "s1" });
    expect(expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
    expect(await tokens.verify(token)).toEqual({ userId: "u1", sessionId: "s1" });
  });

  it("rejects a token signed with another key", async () => {
    const { token } = await new AccessTokens(other).issue({ userId: "u1", sessionId: "s1" });
    expect(await tokens.verify(token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ sid: "s1" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setIssuer("ajo-api")
      .setAudience("ajo")
      .setIssuedAt(now - 3600)
      .setExpirationTime(now - 60)
      .sign(new TextEncoder().encode(secret));
    expect(await tokens.verify(expired)).toBeNull();
  });

  it("rejects unsigned tokens (alg: none)", async () => {
    const unsigned = new UnsecuredJWT({ sid: "s1" })
      .setSubject("u1")
      .setIssuer("ajo-api")
      .setAudience("ajo")
      .encode();
    expect(await tokens.verify(unsigned)).toBeNull();
  });

  it("rejects tokens meant for another audience or issuer", async () => {
    const wrongAudience = await new SignJWT({ sid: "s1" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setIssuer("ajo-api")
      .setAudience("something-else")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(secret));
    expect(await tokens.verify(wrongAudience)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await tokens.verify("not.a.token")).toBeNull();
    expect(await tokens.verify("")).toBeNull();
  });

  it("refuses a signing key shorter than 32 bytes", () => {
    expect(() => new AccessTokens("short")).toThrow(/32/);
  });
});
