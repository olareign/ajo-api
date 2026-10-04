import type { Env } from "../../config/env.js";
import type { Country, PaymentProvider } from "./provider.port.js";

/** The real partner for a country, built from the settings; null when its keys are not set. */
export function buildRealProvider(
  _country: Country,
  _env: Env,
  _fetchFn: typeof fetch,
): PaymentProvider | null {
  return null;
}
