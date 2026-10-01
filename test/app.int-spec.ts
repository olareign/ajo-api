import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";
import request from "supertest";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/app/configure-app.js";
import type { Env } from "../src/config/env.js";
import { ENV } from "../src/config/env.module.js";
import { createDataSource } from "../src/database/data-source.js";
import { RedisThrottlerStorage } from "../src/security/redis-throttler.storage.js";

let postgres: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;
let env: Record<string, string>;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([
    new PostgreSqlContainer("postgis/postgis:17-3.5-alpine").start(),
    new RedisContainer("redis:7.4-alpine").start(),
  ]);
  env = {
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    DATABASE_URL: postgres.getConnectionUri(),
    REDIS_URL: redis.getConnectionUrl(),
  };
});

afterAll(async () => {
  await Promise.all([postgres?.stop(), redis?.stop()]);
});

describe("migrations", () => {
  it("apply cleanly, are idempotent, and can be reverted", async () => {
    const dataSource = await createDataSource(env).initialize();
    try {
      const applied = await dataSource.runMigrations({ transaction: "each" });
      expect(applied.map((m) => m.name)).toContain("EnableExtensions1790900000000");

      const extensions: { extname: string }[] = await dataSource.query(
        "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'citext') ORDER BY extname",
      );
      expect(extensions.map((e) => e.extname)).toEqual(["citext", "pgcrypto"]);

      expect(await dataSource.runMigrations()).toHaveLength(0);

      await dataSource.undoLastMigration();
      await dataSource.runMigrations();
    } finally {
      await dataSource.destroy();
    }
  });
});

describe("application", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    Object.assign(process.env, env);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app, app.get<Env>(ENV));
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("is ready when connected to real Postgres and Redis", async () => {
    const res = await request(app.getHttpServer()).get("/api/v1/health/ready").expect(200);
    expect(res.body).toMatchObject({
      status: "ok",
      info: { database: { status: "up" }, redis: { status: "up" } },
    });
  });
});

describe("RedisThrottlerStorage", () => {
  let client: Redis;
  let storage: RedisThrottlerStorage;

  beforeAll(() => {
    client = new Redis(env.REDIS_URL!);
    storage = new RedisThrottlerStorage(client);
  });

  afterAll(async () => {
    await client.quit();
  });

  it("counts hits and blocks once the limit is passed", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await storage.increment("login:1.2.3.4", 60_000, 3, 120_000, "login"));
    }
    expect(results.map((r) => r.isBlocked)).toEqual([false, false, false, true]);
    expect(results[0]!.timeToExpire).toBeGreaterThan(55);
    expect(results[3]!.timeToBlockExpire).toBeGreaterThan(115);

    const stillBlocked = await storage.increment("login:1.2.3.4", 60_000, 3, 120_000, "login");
    expect(stillBlocked.isBlocked).toBe(true);
  });

  it("never lets concurrent requests slip past the limit", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => storage.increment("otp:5.6.7.8", 60_000, 10, 60_000, "otp")),
    );
    expect(results.filter((r) => !r.isBlocked)).toHaveLength(10);
  });

  it("keeps separate counts per key and per throttler", async () => {
    await storage.increment("a", 60_000, 1, 60_000, "default");
    expect((await storage.increment("b", 60_000, 1, 60_000, "default")).isBlocked).toBe(false);
    expect((await storage.increment("a", 60_000, 1, 60_000, "other")).isBlocked).toBe(false);
  });
});
