import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { inject } from "vitest";
import { AppModule } from "../../src/app.module.js";
import { configureApp } from "../../src/app/configure-app.js";
import type { Env } from "../../src/config/env.js";
import { ENV } from "../../src/config/env.module.js";
import { createDataSource } from "../../src/database/data-source.js";

export function testEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    WEB_APP_URL: "https://app.ajo.test",
    MAIL_PROVIDER: "fake",
    BREACHED_PASSWORD_CHECK: "fake",
  };
}

/** Migrates the shared database and boots the real AppModule with production hardening. */
export async function createTestApp(): Promise<NestExpressApplication> {
  const env = testEnv();
  const dataSource = await createDataSource(env).initialize();
  await dataSource.runMigrations({ transaction: "each" });
  await dataSource.destroy();

  Object.assign(process.env, env);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, app.get<Env>(ENV));
  await app.init();
  return app;
}
