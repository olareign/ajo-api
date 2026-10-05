/** Kinds of optional email a person can turn off. Money and security emails are never optional. */
export type EmailCategory = "reminders" | "savings" | "circles" | "friends";

/** Anything about money not moving, money arriving, or the account itself always emails. */
const ALWAYS = /missed|short|failed|reversed|payout|paid|funding|default|security|mandate/;

/** Which optional category a message belongs to, or null when it always emails. */
export function emailCategory(kind: string): EmailCategory | null {
  if (ALWAYS.test(kind)) return null;
  if (kind.endsWith("soon")) return "reminders";
  if (kind.startsWith("plan.")) return "savings";
  if (kind.startsWith("group.")) return "circles";
  if (kind.startsWith("friend.")) return "friends";
  return null;
}
