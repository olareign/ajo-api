import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { FX_RATES, type FxRatesSource, type RatesSnapshot } from "../adapters/fx/fx-rates.port.js";
import { REDIS_CLIENT } from "../redis/redis.module.js";

const FRESH_KEY = "fx:usd:fresh";
const LAST_KEY = "fx:usd:last";
/** The source updates hourly; asking more often than that buys nothing. */
const FRESH_SECONDS = 60 * 60;
/** A copy older than a day is not shown at all: a stale rate is worse than none. */
const USABLE_SECONDS = 24 * 60 * 60;

export type Rates = RatesSnapshot & Readonly<{ stale: boolean }>;

type Stored = { asOf: string; rates: Record<string, number>; source: RatesSnapshot["source"] };

/**
 * Exchange rates for showing a balance in other currencies. One request an hour at most, shared by
 * every server through Redis; when the source is down the last good copy is used (marked stale) for
 * up to a day, then nothing. These rates never move money.
 */
@Injectable()
export class FxService {
  private readonly logger = new Logger(FxService.name);

  constructor(
    @Inject(FX_RATES) private readonly source: FxRatesSource | null,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  get enabled(): boolean {
    return this.source !== null;
  }

  async rates(): Promise<Rates | null> {
    if (!this.source) return null;
    const fresh = await this.read(FRESH_KEY);
    if (fresh) return { ...fresh, stale: false };
    try {
      const latest = await this.source.latest();
      const stored: Stored = {
        asOf: latest.asOf.toISOString(),
        rates: { ...latest.rates },
        source: latest.source,
      };
      const json = JSON.stringify(stored);
      await this.redis
        .multi()
        .set(FRESH_KEY, json, "EX", FRESH_SECONDS)
        .set(LAST_KEY, json, "EX", USABLE_SECONDS)
        .exec();
      return { ...latest, stale: false };
    } catch (error) {
      this.logger.warn(
        `Exchange rates unavailable: ${error instanceof Error ? error.message : "unknown"}`,
      );
      const last = await this.read(LAST_KEY);
      return last ? { ...last, stale: true } : null;
    }
  }

  private async read(key: string): Promise<RatesSnapshot | null> {
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      const stored = JSON.parse(raw) as Stored;
      return { asOf: new Date(stored.asOf), rates: stored.rates, source: stored.source };
    } catch {
      return null;
    }
  }
}
