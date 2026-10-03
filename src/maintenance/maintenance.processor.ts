import { Processor, WorkerHost } from "@nestjs/bullmq";
import { RetentionService, type PurgeReport } from "./retention.service.js";

export const MAINTENANCE_QUEUE = "maintenance";
export const PURGE_JOB = "purge-expired";

/** Runs the scheduled housekeeping jobs. */
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  constructor(private readonly retention: RetentionService) {
    super();
  }

  async process(job: { name: string }): Promise<PurgeReport | undefined> {
    if (job.name === PURGE_JOB) return this.retention.purge();
    return undefined;
  }
}
