import type { Env } from "../../config/env.js";
import { PaystackProvider } from "./paystack.provider.js";
import { StripeProvider } from "./stripe.provider.js";
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
  if (country === "GB" && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
    return new StripeProvider({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      fetchFn,
    });
  }
  return null;
}
