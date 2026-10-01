import { DataSource } from "typeorm";
import { loadEnv } from "../config/env.js";
import { buildDataSourceOptions } from "./database-options.js";

/** Used by migration scripts outside the NestJS app. */
export function createDataSource(source: Record<string, string | undefined> = process.env) {
  return new DataSource(buildDataSourceOptions(loadEnv(source)));
}
