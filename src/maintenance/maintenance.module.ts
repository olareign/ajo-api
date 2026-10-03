import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { MAINTENANCE_QUEUE, MaintenanceProcessor } from "./maintenance.processor.js";
import { MaintenanceScheduler } from "./maintenance.scheduler.js";
import { RetentionService } from "./retention.service.js";

/** Housekeeping that runs in the worker process, not in the API. */
@Module({
  imports: [BullModule.registerQueue({ name: MAINTENANCE_QUEUE })],
  providers: [RetentionService, MaintenanceProcessor, MaintenanceScheduler],
  exports: [RetentionService],
})
export class MaintenanceModule {}
