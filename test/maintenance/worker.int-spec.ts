import { getQueueToken } from "@nestjs/bullmq";
import { Test, type TestingModule } from "@nestjs/testing";
import type { Queue } from "bullmq";
import { MAINTENANCE_QUEUE, PURGE_JOB } from "../../src/maintenance/maintenance.processor.js";
import { PURGE_EVERY_MS } from "../../src/maintenance/maintenance.scheduler.js";
import { WorkerModule } from "../../src/worker.module.js";
import { testEnv } from "../support/test-app.js";
import { createTestApp } from "../support/test-app.js";

let moduleRef: TestingModule;

afterAll(async () => {
  await moduleRef?.close();
});

describe("worker housekeeping", () => {
  it("schedules the purge once, however many times the worker restarts", async () => {
    const app = await createTestApp(); // migrates the shared database
    await app.close();
    Object.assign(process.env, testEnv());

    for (let restart = 0; restart < 2; restart++) {
      const boot = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
      await boot.init();
      if (restart === 0) moduleRef = boot;
      else await boot.close();
    }

    const queue = moduleRef.get<Queue>(getQueueToken(MAINTENANCE_QUEUE));
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers.filter((s) => s.name === PURGE_JOB)).toHaveLength(1);
    expect(schedulers.find((s) => s.name === PURGE_JOB)?.every).toBe(PURGE_EVERY_MS);
  });
});
