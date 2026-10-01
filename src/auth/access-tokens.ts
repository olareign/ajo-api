import { jwtVerify, SignJWT } from "jose";

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ISSUER = "ajo-api";
const AUDIENCE = "ajo";

export type AccessClaims = Readonly<{ userId: string; sessionId: string }>;

/**
 * Short-lived HS256 access tokens. They only identify the user and session; every request
 * also checks that the session is still active, so revocation is immediate.
 */
export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    if (Buffer.byteLength(secret, "utf8") < 32) {
      throw new Error("Access token signing key must be at least 32 bytes");
    }
    this.key = new TextEncoder().encode(secret);
  }

  async issue(claims: AccessClaims): Promise<{ token: string; expiresIn: number }> {
    const token = await new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
    return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  async verify(token: string): Promise<AccessClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
      return { userId: payload.sub, sessionId: payload.sid };
    } catch {
      return null;
    }
  }
}
