/** Three to twenty characters: a letter first, then lowercase letters, digits or underscores. */
export const USERNAME_PATTERN = /^[a-z][a-z0-9_]{2,19}$/;

/**
 * Names the company keeps for itself, so nobody can pose as it. Whole names only: an ordinary name
 * that merely starts with one ("ajoke", a common name) is left to the person it belongs to.
 */
const RESERVED = new Set([
  "admin",
  "administrator",
  "ajo",
  "api",
  "billing",
  "contact",
  "help",
  "info",
  "mail",
  "moderator",
  "noreply",
  "null",
  "official",
  "payments",
  "root",
  "security",
  "staff",
  "support",
  "system",
  "team",
  "undefined",
  "wallet",
  "www",
]);

/** What is stored: trimmed, lowercase, without a leading @. */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

export const isValidUsername = (name: string): boolean => USERNAME_PATTERN.test(name);

export const isReservedUsername = (name: string): boolean => RESERVED.has(name.toLowerCase());
