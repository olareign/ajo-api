import type { Type } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { inject } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { AuthModule } from "../../src/auth/auth.module.js";
import { KycModule } from "../../src/kyc/kyc.module.js";
import { configureApp } from "../../src/app/configure-app.js";
import type { Env } from "../../src/config/env.js";
import { ENV } from "../../src/config/env.module.js";
import { createDataSource } from "../../src/database/data-source.js";

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    WEB_APP_URL: "https://app.ajo.test",
    MAIL_PROVIDER: "fake",
    BREACHED_PASSWORD_CHECK: "fake",
    ...overrides,
  };
}

/**
 * Migrates the shared database and boots the real AppModule with production hardening.
 * `probes` are throwaway controllers for routes that do not exist yet (e.g. a money action).
 */
export async function createTestApp(
  overrides: Record<string, string> = {},
  probes: readonly Type<unknown>[] = [],
): Promise<NestExpressApplication> {
  const env = testEnv(overrides);
  const dataSource = await createDataSource(env).initialize();
  await dataSource.runMigrations({ transaction: "each" });
  await dataSource.destroy();

  Object.assign(process.env, env);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, AuthModule, KycModule],
    controllers: [...probes],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, app.get<Env>(ENV));
  await app.init();
  return app;
}
