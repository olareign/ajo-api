import type { DataSourceOptions } from "typeorm";
import type { Env } from "../config/env.js";
import { migrations } from "./migrations/index.js";

type PostgresOptions = Extract<DataSourceOptions, { type: "postgres" }>;

export function buildDataSourceOptions(env: Env): PostgresOptions {
  return {
    type: "postgres",
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : false,
    // The schema changes only through reviewed migrations, never automatically.
    synchronize: false,
    migrationsRun: false,
    dropSchema: false,
    migrations,
    migrationsTransactionMode: "each",
    logging: ["error", "warn", "migration"],
    extra: {
      max: 10,
      // Milliseconds: a stuck query or abandoned transaction cannot hold locks on money tables.
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: "ajo-api",
    },
  };
}
