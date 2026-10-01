import { Body, Controller, Get, Post } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { IsInt, IsString, Min } from "class-validator";
import request from "supertest";
import type { App } from "supertest/types.js";
import { loadEnv } from "../config/env.js";
import { configureApp } from "./configure-app.js";

class CreateThingDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  amount!: number;
}

@Controller("things")
class ThingsController {
  @Post()
  create(@Body() body: CreateThingDto) {
    return { received: body };
  }

  @Get("boom")
  boom(): never {
    throw new Error("connection to db.internal:5432 failed for user ajo");
  }
}

const env = loadEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgres://ajo:ajo@localhost:5432/ajo",
  REDIS_URL: "redis://localhost:6379",
});

describe("configureApp", () => {
  let app: NestExpressApplication;
  let http: App;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app, env);
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
  });

  it("serves everything under the versioned prefix", async () => {
    await request(http).post("/api/v1/things").send({ name: "a", amount: 1 }).expect(201);
    await request(http).post("/things").send({ name: "a", amount: 1 }).expect(404);
  });

  it("sends security headers and hides the framework", async () => {
    const res = await request(http).post("/api/v1/things").send({ name: "a", amount: 1 });
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["strict-transport-security"]).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none';frame-ancestors 'none'",
    );
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
  });

  it("never lets responses with financial data be cached", async () => {
    const res = await request(http).post("/api/v1/things").send({ name: "a", amount: 1 });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("does not answer cross-origin browser requests (only the BFF calls the API)", async () => {
    const res = await request(http)
      .options("/api/v1/things")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects fields the endpoint does not expect (no mass assignment)", async () => {
    const res = await request(http)
      .post("/api/v1/things")
      .send({ name: "a", amount: 1, isAdmin: true })
      .expect(400);
    expect(JSON.stringify(res.body)).toContain("isAdmin");
  });

  it("validates and converts input before the handler sees it", async () => {
    await request(http).post("/api/v1/things").send({ name: "a", amount: 0 }).expect(400);
    await request(http).post("/api/v1/things").send({ amount: 1 }).expect(400);
  });

  it("rejects oversized bodies", async () => {
    await request(http)
      .post("/api/v1/things")
      .send({ name: "x".repeat(150 * 1024), amount: 1 })
      .expect(413);
  });

  it("hides internal error details and returns a request id to quote to support", async () => {
    const res = await request(http).get("/api/v1/things/boom").expect(500);
    expect(res.body).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Something went wrong",
      requestId: res.headers["x-request-id"],
    });
    expect(JSON.stringify(res.body)).not.toContain("db.internal");
  });

  it("answers unknown routes with a plain JSON 404", async () => {
    const res = await request(http).get("/api/v1/nope").expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, error: "Not Found" });
    expect(res.body).not.toHaveProperty("stack");
  });

  it("keeps a caller's valid request id and replaces anything else", async () => {
    const id = "3f1c2b8e-0a3d-4c1e-9b7a-2d4e6f8a0b1c";
    const kept = await request(http).get("/api/v1/nope").set("X-Request-Id", id);
    expect(kept.headers["x-request-id"]).toBe(id);

    const replaced = await request(http).get("/api/v1/nope").set("X-Request-Id", "<script>");
    expect(replaced.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("configureApp error mapping", () => {
  it("answers malformed JSON as a client error, not a server error", async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ThingsController] }).compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    configureApp(app, env);
    await app.init();
    const res = await request(app.getHttpServer())
      .post("/api/v1/things")
      .set("Content-Type", "application/json")
      .send("{not json")
      .expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, error: "Bad Request" });
    await app.close();
  });
});
