import type { KycOverride } from "./kyc-status.js";

export type OverrideCommand =
  | Readonly<{ kind: "set"; email: string; value: KycOverride | null }>
  | Readonly<{ kind: "list" }>
  | Readonly<{ kind: "usage" }>;

const WORDS: Readonly<Record<string, KycOverride | null>> = {
  approve: "approved",
  deny: "denied",
  clear: null,
};

/** Reads `<email> approve|deny|clear` or `list`. Anything else is a request to show the usage. */
export function parseOverrideArgs(args: readonly string[]): OverrideCommand {
  if (args.length === 1 && args[0]?.trim().toLowerCase() === "list") return { kind: "list" };
  if (args.length !== 2) return { kind: "usage" };
  const email = args[0]!.trim();
  const word = args[1]!.trim().toLowerCase();
  if (!email.includes("@") || !(word in WORDS)) return { kind: "usage" };
  return { kind: "set", email, value: WORDS[word]! };
}
