import { INVITE_CODE } from "./referrals.js";

/** How many times a person can change their code in CHANGE_WINDOW_DAYS. */
export const MAX_CHANGES = 3;
export const CHANGE_WINDOW_DAYS = 30;
/** A code someone gave up stays theirs this long, so old links never lead to someone else. */
export const RELEASE_HOLD_DAYS = 90;

/** Codes that would pass as the app's own, or as staff. Refused whole or as part of a code. */
const IMPERSONATION = [
  "AJO",
  "ADMIN",
  "SUPPORT",
  "OFFICIAL",
  "STAFF",
  "HELPDESK",
  "SECURITY",
  "PAYSTACK",
  "MODERATOR",
  "VERIFIED",
];
/** Words for routes and system names, refused as the whole code. */
const RESERVED = new Set([
  "ROOT",
  "SYSTEM",
  "API",
  "WWW",
  "JOIN",
  "INVITE",
  "NULL",
  "UNDEFINED",
  "TEST",
  "HELP",
  "TEAM",
  "BANK",
]);
/**
 * A short list of slurs and obscenities refused anywhere in a code. Kept deliberately small and
 * plain; extend it rather than loosen it.
 */
const OFFENSIVE = [
  "FUCK",
  "SHIT",
  "CUNT",
  "BITCH",
  "NIGGA",
  "NIGGER",
  "FAGGOT",
  "RAPE",
  "PORN",
  "WHORE",
  "ASHAWO",
  "OLOSHO",
  "MUMU",
  "OLODO",
];

export type CodeProblem = "invalid" | "unavailable";

/** Tidies what the person typed: no spaces, capitals, as stored. */
export const normalizeCode = (raw: string) => raw.trim().toUpperCase();

/**
 * Why a code can't be used, or null when it can. "unavailable" is one answer for reserved,
 * impersonating and offensive words alike, so the lists can't be probed one word at a time.
 */
export function codeProblem(code: string): CodeProblem | null {
  if (!INVITE_CODE.test(code)) return "invalid";
  const bare = code.replace(/[-_]/g, "");
  if (RESERVED.has(bare)) return "unavailable";
  if (IMPERSONATION.some((word) => bare.includes(word))) return "unavailable";
  if (OFFENSIVE.some((word) => bare.includes(word))) return "unavailable";
  return null;
}
