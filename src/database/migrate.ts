import { createDataSource } from "./data-source.js";

/** Applies pending migrations; run as Render's pre-deploy command before new code starts. */
const dataSource = await createDataSource().initialize();
try {
  const applied = await dataSource.runMigrations({ transaction: "each" });
  process.stdout.write(
    `${JSON.stringify({ msg: "migrations applied", count: applied.length, names: applied.map((m) => m.name) })}\n`,
  );
} finally {
  await dataSource.destroy();
}
