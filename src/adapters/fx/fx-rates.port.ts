/** Units of each currency per one US dollar, as the source gave them, and when they were true. */
export type RatesSnapshot = Readonly<{
  asOf: Date;
  rates: Readonly<Record<string, number>>;
  /** "sample" rates are made up for development and are always labelled as such. */
  source: "openexchangerates" | "sample";
}>;

export interface FxRatesSource {
  latest(): Promise<RatesSnapshot>;
}

/** Null where no rate source is set (production without an App ID): balances then show no other currency. */
export const FX_RATES = Symbol("FX_RATES");
