import { createHash, randomBytes } from "node:crypto";

/** A random single-use token for links (email verification, password reset). */
export function createOneTimeToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

/** Only this hash is stored; the token itself exists only in the email sent to the user. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
