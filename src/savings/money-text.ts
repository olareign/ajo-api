const LOCALE: Readonly<Record<string, string>> = { NGN: "en-NG", GBP: "en-GB" };

/** "₦5,000" or "£12.50": for messages to people, from whole minor units. */
export function moneyText(minor: string | bigint, currency: string): string {
  const value = Number(BigInt(minor)) / 100;
  const whole = Number.isInteger(value);
  return new Intl.NumberFormat(LOCALE[currency] ?? "en", {
    style: "currency",
    currency,
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}
