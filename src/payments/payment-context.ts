import { Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { DataSource } from "typeorm";
import type { PaymentProvider } from "./providers/provider.port.js";
import { PaymentProviders } from "./providers/providers.service.js";

/** What every payment action needs first: who the person is, and which partner serves their country. */
@Injectable()
export class PaymentContext {
  constructor(
    private readonly db: DataSource,
    private readonly providers: PaymentProviders,
  ) {}

  async person(userId: string): Promise<{ email: string; country: string | null; name: string }> {
    const [user] = await this.db.query<{ email: string; country: string | null; name: string }[]>(
      `SELECT email, country, display_name AS name FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw new NotFoundException();
    return user;
  }

  /** The partner that serves this country, or a clear 503: nothing is started without one. */
  providerFor(country: string | null): PaymentProvider {
    const provider = this.providers.forCountry(country);
    if (!provider) {
      throw new ServiceUnavailableException({
        message: "Payments aren't switched on yet.",
        code: "payments_not_connected",
      });
    }
    return provider;
  }
}
