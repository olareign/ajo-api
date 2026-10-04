import type { Env } from "../../config/env.js";
import { PaystackProvider } from "./paystack.provider.js";
import type { Country, PaymentProvider } from "./provider.port.js";

/** The real partner for a country, built from the settings; null when its keys are not set. */
export function buildRealProvider(
  country: Country,
  env: Env,
  fetchFn: typeof fetch,
): PaymentProvider | null {
  if (country === "NG" && env.PAYSTACK_SECRET_KEY) {
    return new PaystackProvider({
      secretKey: env.PAYSTACK_SECRET_KEY,
      baseUrl: env.PAYSTACK_BASE_URL,
      fetchFn,
    });
  }
  return null;
}
