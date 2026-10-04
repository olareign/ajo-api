import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Env } from "../../config/env.js";
import { ENV } from "../../config/env.module.js";
import { FakeProvider } from "./fake.provider.js";
import { buildRealProvider } from "./real-providers.js";
import type { Country, PaymentProvider, ProviderName } from "./provider.port.js";

export const HTTP_FETCH = Symbol("HTTP_FETCH");
export type HttpFetch = typeof fetch;

export type Capabilities = Readonly<{ fund: boolean; mandate: boolean; withdraw: boolean }>;

/**
 * Which payment partner serves which country. A partner is connected only when its keys are set (or
 * the stand-in is switched on, outside production); with none, money screens say "not switched on" and
 * nothing can move. Adapters are created once and shared.
 */
@Injectable()
export class PaymentProviders {
  private readonly logger = new Logger(PaymentProviders.name);
  private readonly byCountry = new Map<Country, PaymentProvider>();

  constructor(@Inject(ENV) env: Env, @Inject(HTTP_FETCH) fetchFn: HttpFetch) {
    for (const country of ["NG", "GB"] as const) {
      const real = buildRealProvider(country, env, fetchFn);
      if (real) {
        this.byCountry.set(country, real);
      } else if (env.PAYMENTS_FAKE) {
        this.byCountry.set(country, new FakeProvider(country));
      }
    }
    for (const [country, provider] of this.byCountry) {
      this.logger.log(`${country}: payments through ${provider.name}`);
    }
  }

  forCountry(country: string | null): PaymentProvider | null {
    return country === "NG" || country === "GB" ? (this.byCountry.get(country) ?? null) : null;
  }

  /** The connected partner with this name (a webhook says which one it is from). */
  byName(name: ProviderName): PaymentProvider | null {
    for (const provider of this.byCountry.values()) if (provider.name === name) return provider;
    return null;
  }

  capabilities(country: string | null): Capabilities {
    const provider = this.forCountry(country);
    return {
      fund: (provider?.supports.fund.length ?? 0) > 0,
      mandate: provider?.supports.mandate ?? false,
      withdraw: provider?.supports.payout ?? false,
    };
  }
}
