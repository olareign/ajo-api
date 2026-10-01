import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import type { TestProject } from "vitest/node";

/** Starts one Postgres and one Redis for the whole integration run. */
export default async function setup(project: TestProject) {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer("postgis/postgis:17-3.5-alpine").start(),
    new RedisContainer("redis:7.4-alpine").start(),
  ]);
  project.provide("databaseUrl", postgres.getConnectionUri());
  project.provide("redisUrl", redis.getConnectionUrl());
  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}
