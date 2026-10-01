import { loadEnv } from "./env.js";

const valid = {
  NODE_ENV: "production",
  PORT: "8080",
  DATABASE_URL: "postgres://ajo:s3cret-pass@db.internal:5432/ajo",
  REDIS_URL: "rediss://default:redis-pass@cache.internal:6379",
};

describe("loadEnv", () => {
  it("parses a valid production environment", () => {
    expect(loadEnv(valid)).toMatchObject({
      NODE_ENV: "production",
      PORT: 8080,
      DATABASE_SSL: true,
      LOG_LEVEL: "info",
      TRUST_PROXY_HOPS: 1,
      API_DOCS_ENABLED: false,
    });
  });

  it("uses safe local defaults in development", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://ajo:ajo@localhost:5432/ajo",
      REDIS_URL: "redis://localhost:6379",
    });
    expect(env).toMatchObject({ NODE_ENV: "development", PORT: 3000, DATABASE_SSL: false });
  });

  it("refuses to start without a database or Redis", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/DATABASE_URL[\s\S]*REDIS_URL/);
  });

  it("rejects URLs with the wrong scheme", () => {
    expect(() => loadEnv({ ...valid, DATABASE_URL: "mysql://x@y/z" })).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...valid, REDIS_URL: "http://cache" })).toThrow(/REDIS_URL/);
  });

  it("never echoes secret values in its error message", () => {
    try {
      loadEnv({ ...valid, PORT: "not-a-port" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("s3cret-pass");
      expect(String(error)).not.toContain("redis-pass");
      expect(String(error)).toMatch(/PORT/);
    }
  });

  it("requires TLS to the database in production unless explicitly turned off", () => {
    expect(loadEnv(valid).DATABASE_SSL).toBe(true);
    expect(loadEnv({ ...valid, DATABASE_SSL: "false" }).DATABASE_SSL).toBe(false);
  });

  it("never exposes API docs in production", () => {
    expect(() => loadEnv({ ...valid, API_DOCS_ENABLED: "true" })).toThrow(/API_DOCS_ENABLED/);
    expect(
      loadEnv({ ...valid, NODE_ENV: "development", API_DOCS_ENABLED: "true" }).API_DOCS_ENABLED,
    ).toBe(true);
  });

  it("accepts only real booleans for flags", () => {
    expect(() => loadEnv({ ...valid, DATABASE_SSL: "yes" })).toThrow(/DATABASE_SSL/);
  });
});
