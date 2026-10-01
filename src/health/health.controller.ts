import { Controller, Get, Inject } from "@nestjs/common";
import { HealthCheck, HealthCheckService, HealthIndicatorService } from "@nestjs/terminus";
import { SkipThrottle } from "@nestjs/throttler";
import type { Redis } from "ioredis";
import { DataSource } from "typeorm";
import { REDIS_CLIENT } from "../redis/redis.module.js";

export const PROBE_TIMEOUT_MS = 1500;

/**
 * Liveness says the process is running; readiness says it can serve traffic. Failures are
 * reported as "unreachable" only, so hostnames and driver errors never leave the server.
 */
@SkipThrottle()
@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Pick<Redis, "ping">,
  ) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.probe("database", () => this.dataSource.query("SELECT 1")),
      () => this.probe("redis", () => this.redis.ping()),
    ]);
  }

  private async probe<const K extends string>(key: K, check: () => Promise<unknown>) {
    const indicator = this.indicators.check(key);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        check(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS);
        }),
      ]);
      return indicator.up();
    } catch {
      return indicator.down({ message: "unreachable" });
    } finally {
      clearTimeout(timer);
    }
  }
}
