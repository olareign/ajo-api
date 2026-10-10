import type { FxRatesSource, RatesSnapshot } from "./fx-rates.port.js";

type Fetch = typeof fetch;

/**
 * Open Exchange Rates (the free plan: latest rates against the US dollar, refreshed hourly). The App ID
 * travels in the address, so it is never put in an error message or a log line.
 */
export class OpenExchangeRates implements FxRatesSource {
  readonly #appId: string;

  constructor(
    appId: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly timeoutMs = 8_000,
  ) {
    this.#appId = appId;
  }

  async latest(): Promise<RatesSnapshot> {
    let res: Response;
    try {
      res = await this.fetchFn(
        `https://openexchangerates.org/api/latest.json?app_id=${encodeURIComponent(this.#appId)}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch {
      throw new Error("Exchange rates could not be reached");
    }
    if (!res.ok) throw new Error(`Exchange rates refused the request (${res.status})`);
    const body = (await res.json().catch(() => null)) as {
      timestamp?: unknown;
      base?: unknown;
      rates?: unknown;
    } | null;
    if (
      !body ||
      body.base !== "USD" ||
      typeof body.timestamp !== "number" ||
      !body.rates ||
      typeof body.rates !== "object"
    ) {
      throw new Error("Exchange rates sent an answer we cannot read");
    }
    const rates: Record<string, number> = {};
    for (const [code, value] of Object.entries(body.rates as Record<string, unknown>)) {
      if (
        /^[A-Z]{3}$/.test(code) &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value > 0
      ) {
        rates[code] = value;
      }
    }
    return { asOf: new Date(body.timestamp * 1000), rates, source: "openexchangerates" };
  }
}
