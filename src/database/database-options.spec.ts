import { loadEnv } from "../config/env.js";
import { buildDataSourceOptions } from "./database-options.js";

const base = {
  DATABASE_URL: "postgres://ajo:pw@db:5432/ajo",
  REDIS_URL: "redis://cache:6379",
};

describe("buildDataSourceOptions", () => {
  it("never lets TypeORM change the schema on its own; migrations only", () => {
    for (const NODE_ENV of ["development", "test", "production"]) {
      const options = buildDataSourceOptions(loadEnv({ ...base, NODE_ENV }));
      expect(options.synchronize).toBe(false);
      expect(options.migrationsRun).toBe(false);
      expect(options.dropSchema).toBe(false);
    }
  });

  it("verifies the database's TLS certificate when TLS is on", () => {
    const options = buildDataSourceOptions(loadEnv({ ...base, NODE_ENV: "production" }));
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("can turn TLS off for private networks and local development", () => {
    const options = buildDataSourceOptions(loadEnv({ ...base, NODE_ENV: "development" }));
    expect(options.ssl).toBe(false);
  });

  it("stops runaway queries and abandoned transactions from holding locks", () => {
    const { extra } = buildDataSourceOptions(loadEnv(base));
    expect(extra).toMatchObject({
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
    });
  });

  it("runs each migration in its own transaction", () => {
    const options = buildDataSourceOptions(loadEnv(base));
    expect(options.migrationsTransactionMode).toBe("each");
    expect(options.migrations).not.toHaveLength(0);
  });
});
