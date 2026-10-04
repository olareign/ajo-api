import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { REDIS_CLIENT } from "../redis/redis.module.js";
import { PaymentsService } from "./payments.service.js";
import { WebhookInbox } from "./webhook-inbox.service.js";

const LOCK_KEY = "payments:sweep";

/**
 * The safety net under the webhooks: retries partner messages that could not be acted on yet and
 * settles payments that sat pending. It runs inside the API, so it works without a separate worker;
 * a short Redis lock keeps several copies of the API from doing the same pass at once (they would
 * still be safe if they did: every step is claimed in the database).
 */
@Injectable()
export class PaymentSweep implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(PaymentSweep.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly inbox: WebhookInbox,
    private readonly payments: PaymentsService,
  ) {}

  onApplicationBootstrap(): void {
    const seconds = this.env.PAYMENT_SWEEP_SECONDS;
    if (!seconds) return;
    this.timer = setInterval(() => void this.run(), seconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** One pass. Returns false when another copy holds the lock. */
  async run(): Promise<boolean> {
    const seconds = Math.max(this.env.PAYMENT_SWEEP_SECONDS || 60, 10);
    const got = await this.redis.set(LOCK_KEY, "1", "EX", Math.ceil(seconds * 0.8), "NX");
    if (got !== "OK") return false;
    try {
      await this.inbox.drain();
      await this.payments.reconcileStale();
    } catch (error) {
      this.logger.error(
        `Payment sweep failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    return true;
  }
}
