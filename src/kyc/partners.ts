/**
 * Which partner capabilities have a live adapter behind them. Nothing is connected yet, so every
 * answer is no, and the screens show their locked state. Each flips when its adapter is registered
 * with real keys (E2 and E3 integration); the rest of the app reads these answers, so it needs no
 * change when that happens.
 */
export const CONNECTED = {
  identity: false,
  fund: false,
  mandate: false,
  withdraw: false,
} as const;

export type Country = "NG" | "GB";

const CURRENCIES: Readonly<Record<Country, string>> = { NG: "NGN", GB: "GBP" };

/** The currency a country's wallet is held in, or null before a country has been chosen. */
export function currencyFor(country: string | null): string | null {
  return country === "NG" || country === "GB" ? CURRENCIES[country] : null;
}
