import type { BreachedPasswords } from "../adapters/breached-passwords/breached-passwords.port.js";

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export type PasswordProblem = "too_short" | "too_long" | "contains_email" | "breached";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Counts characters as people see them, so emoji and accented letters count once. */
function graphemeCount(value: string): number {
  let count = 0;
  for (const _ of segmenter.segment(value)) count++;
  return count;
}

/** NIST SP 800-63B style: length over composition rules, plus a breached-password check. */
export async function checkPassword(
  password: string,
  email: string,
  breached: BreachedPasswords,
): Promise<PasswordProblem[]> {
  const length = graphemeCount(password);
  if (length < MIN_PASSWORD_LENGTH) return ["too_short"];
  if (length > MAX_PASSWORD_LENGTH) return ["too_long"];

  const localPart = email.split("@")[0]?.toLowerCase() ?? "";
  if (localPart.length >= 4 && password.toLowerCase().includes(localPart)) {
    return ["contains_email"];
  }
  return (await breached.isBreached(password)) ? ["breached"] : [];
}
