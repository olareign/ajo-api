/* oxlint-disable no-console -- a command-line tool whose output is the console */
/**
 * Runs the housekeeping purge once, outside the worker (e.g. from a Render cron job, or by hand
 * after a long gap):  pnpm build && pnpm retention:run
 */
import { createDataSource } from "./database/data-source.js";
import { RetentionService } from "./maintenance/retention.service.js";

const dataSource = await createDataSource().initialize();
try {
  const removed = await new RetentionService(dataSource).purge();
  console.log(JSON.stringify({ msg: "purged", removed }));
} finally {
  await dataSource.destroy();
}
