import { createHash, randomInt } from "node:crypto";

export const RECOVERY_CODE_COUNT = 10;
// No 0/1/i/l/o, so codes are easy to read and type.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function group(): string {
  return Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
}

/** Ten single-use codes (about 49 bits each), shown to the user once. */
export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) codes.add(`${group()}-${group()}`);
  return [...codes];
}

/** High-entropy random codes, so a fast hash is enough; only the hash is stored. */
export function hashRecoveryCode(code: string): string {
  const normalised = code.toLowerCase().replace(/[\s-]/g, "");
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}
