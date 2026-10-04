/**
 * Whether an identity partner is connected. Not yet, so every step shows its locked state. It flips
 * when its adapter is registered with real keys (the owner has not chosen the identity tools yet).
 * Payment partners are different: they are connected by their settings, in PaymentProviders.
 */
export const CONNECTED = { identity: false } as const;

export type Country = "NG" | "GB";

const CURRENCIES: Readonly<Record<Country, string>> = { NG: "NGN", GB: "GBP" };

/** The currency a country's wallet is held in, or null before a country has been chosen. */
export function currencyFor(country: string | null): string | null {
  return country === "NG" || country === "GB" ? CURRENCIES[country] : null;
}
