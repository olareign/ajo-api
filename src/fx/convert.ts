/** Currencies a balance can be shown in. All four have two decimal places (kobo, pence, cents). */
export const DISPLAY_CURRENCIES = ["NGN", "GBP", "USD", "EUR"] as const;
export type DisplayCurrency = (typeof DISPLAY_CURRENCIES)[number];

const SCALE = 1_000_000_000_000n; // rates are held to 12 decimal places

/** A positive rate as an exact scaled integer (rates are at most ~15 significant digits anyway). */
function scaled(rate: number): bigint {
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("A rate must be a positive number");
  const [whole, fraction = ""] = rate.toFixed(12).split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, "0").slice(0, 12));
}

/**
 * An amount in minor units of `from`, worth this much in minor units of `to`, given each currency's
 * rate against the same base. Exact integer arithmetic, rounded half away from zero: no floating
 * point ever touches the money itself.
 */
export function convertMinor(amount: bigint, fromRate: number, toRate: number): bigint {
  const numerator = amount * scaled(toRate);
  const denominator = scaled(fromRate);
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const rounded = (magnitude * 2n + denominator) / (denominator * 2n);
  return negative ? -rounded : rounded;
}

/** How many units of `to` one unit of `from` buys, to six significant figures, for showing only. */
export function crossRate(fromRate: number, toRate: number): string {
  return Number((toRate / fromRate).toPrecision(6)).toString();
}
