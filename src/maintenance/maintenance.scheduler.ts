import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { Queue } from "bullmq";
import { MAINTENANCE_QUEUE, PURGE_JOB } from "./maintenance.processor.js";

export const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Registers the repeating housekeeping job. The scheduler has a fixed id, so every worker
 * restart updates the one schedule instead of adding another.
 */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      PURGE_JOB,
      { every: PURGE_EVERY_MS },
      {
        name: PURGE_JOB,
        opts: {
          removeOnComplete: 20,
          removeOnFail: 100,
          attempts: 3,
          backoff: { type: "exponential", delay: 60_000 },
        },
      },
    );
  }
}
