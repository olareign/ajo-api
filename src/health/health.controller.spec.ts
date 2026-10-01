import { Global, Module } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { DataSource } from "typeorm";
import { configureApp } from "../app/configure-app.js";
import { loadEnv } from "../config/env.js";
import { HealthModule } from "./health.module.js";
import { REDIS_CLIENT } from "../redis/redis.module.js";

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://a:b@db:5432/ajo",
  REDIS_URL: "redis://cache:6379",
});

async function appWith({ dbUp, redisUp }: { dbUp: boolean; redisUp: boolean }) {
  const fakeRedis = {
    ping: async () => {
      if (!redisUp) throw new Error("redis down at cache.internal");
      return "PONG";
    },
  };
  @Global()
  @Module({ providers: [{ provide: REDIS_CLIENT, useValue: fakeRedis }], exports: [REDIS_CLIENT] })
  class FakeRedisModule {}

  // The real DataSource throws when Postgres is unreachable; the fake does the same.
  const fakeDataSource = {
    query: async () => {
      if (!dbUp) throw new Error("connect ECONNREFUSED db.internal:5432");
      return [{ "?column?": 1 }];
    },
  };
  @Global()
  @Module({ providers: [{ provide: DataSource, useValue: fakeDataSource }], exports: [DataSource] })
  class FakeDatabaseModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [FakeRedisModule, FakeDatabaseModule, HealthModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  configureApp(app, env);
  await app.init();
  return app;
}

describe("health", () => {
  it("treats a dependency that never answers as not ready", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { HealthController, PROBE_TIMEOUT_MS } = await import("./health.controller.js");
    const indicators = {
      check: (key: string) => ({
        up: () => ({ [key]: { status: "up" } }),
        down: (d: object) => ({ [key]: { status: "down", ...d } }),
      }),
    };
    const controller = new HealthController(
      {
        check: async (fns: (() => Promise<unknown>)[]) => Promise.all(fns.map((f) => f())),
      } as never,
      indicators as never,
      { query: () => new Promise(() => {}) } as never,
      { ping: async () => "PONG" } as never,
    );
    const result = controller.ready() as unknown as Promise<unknown>;
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
    expect(await result).toEqual([
      { database: { status: "down", message: "unreachable" } },
      { redis: { status: "up" } },
    ]);
    vi.useRealTimers();
  });

  it("reports live while the process runs, without touching dependencies", async () => {
    const app = await appWith({ dbUp: false, redisUp: false });
    await request(app.getHttpServer()).get("/api/v1/health/live").expect(200, { status: "ok" });
    await app.close();
  });

  it("is ready when the database and Redis answer", async () => {
    const app = await appWith({ dbUp: true, redisUp: true });
    const res = await request(app.getHttpServer()).get("/api/v1/health/ready").expect(200);
    expect(res.body).toMatchObject({
      status: "ok",
      info: { database: { status: "up" }, redis: { status: "up" } },
    });
    await app.close();
  });

  it("is not ready when a dependency is down, and does not reveal hostnames", async () => {
    const app = await appWith({ dbUp: true, redisUp: false });
    const res = await request(app.getHttpServer()).get("/api/v1/health/ready").expect(503);
    expect(JSON.stringify(res.body)).not.toContain("cache.internal");
    expect(res.body.error ?? res.body.message).toBeDefined();
    await app.close();

    const app2 = await appWith({ dbUp: false, redisUp: true });
    const res2 = await request(app2.getHttpServer()).get("/api/v1/health/ready").expect(503);
    expect(JSON.stringify(res2.body)).not.toContain("db.internal");
    await app2.close();
  });
});
