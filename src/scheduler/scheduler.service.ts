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

const LOCK_KEY = "scheduler:sweep";

export type SweepTask = Readonly<{
  name: string;
  /** Must be safe to run twice at once and twice in a row: every step claims its work in the database. */
  run: () => Promise<unknown>;
}>;

/**
 * The one clock for everything that must happen on time without anyone using the app: settling
 * payments, taking each saving plan's debit, collecting circle rounds, sending queued emails. Each
 * feature registers a task; one pass runs them in turn. It lives in the API today, which works while
 * the API is awake. On an always-on server nothing changes; a separate worker could call `run()` instead.
 * A short Redis lock stops copies of the API from running a pass together (they would still be safe if
 * they did).
 */
@Injectable()
export class Scheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(Scheduler.name);
  private readonly tasks: SweepTask[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  register(task: SweepTask): void {
    if (this.tasks.some((t) => t.name === task.name)) return;
    this.tasks.push(task);
  }

  onApplicationBootstrap(): void {
    const seconds = this.env.SWEEP_SECONDS;
    if (!seconds) return;
    this.timer = setInterval(() => void this.run(), seconds * 1000);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  /** One pass over every task. Returns false when another copy holds the lock. */
  async run(only?: readonly string[]): Promise<boolean> {
    const seconds = Math.max(this.env.SWEEP_SECONDS || 60, 10);
    const got = await this.redis.set(LOCK_KEY, "1", "EX", Math.ceil(seconds * 0.8), "NX");
    if (got !== "OK") return false;
    for (const task of this.tasks) {
      if (only && !only.includes(task.name)) continue;
      try {
        await task.run();
      } catch (error) {
        // One task failing must not stop the others.
        this.logger.error(
          `Sweep task "${task.name}" failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    }
    return true;
  }

  /** For tests and tools: clear the lock so the next pass is not turned away. */
  async release(): Promise<void> {
    await this.redis.del(LOCK_KEY);
  }
}
