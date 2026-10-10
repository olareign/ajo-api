import type { FxRatesSource, RatesSnapshot } from "./fx-rates.port.js";

/** Made-up rates for development and tests, always marked "sample". Never used in production. */
export class SampleRates implements FxRatesSource {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async latest(): Promise<RatesSnapshot> {
    return {
      asOf: this.now(),
      rates: { USD: 1, NGN: 1500, GBP: 0.75, EUR: 0.9 },
      source: "sample",
    };
  }
}
