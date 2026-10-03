import { loadEnv } from "./env.js";

const valid: Record<string, string | undefined> = {
  NODE_ENV: "production",
  PORT: "8080",
  DATABASE_URL: "postgres://ajo:s3cret-pass@db.internal:5432/ajo",
  REDIS_URL: "rediss://default:redis-pass@cache.internal:6379",
  WEB_APP_URL: "https://app.ajo.example",
  MAIL_PROVIDER: "smtp",
  SMTP_HOST: "smtp.ajo.example",
  SMTP_USER: "mailer",
  SMTP_PASSWORD: "live-secret",
  SMTP_FROM: "Àjo <noreply@ajo.example>",
  BREACHED_PASSWORD_CHECK: "hibp",
  BOT_CHECK: "turnstile",
  TURNSTILE_SECRET_KEY: "turnstile-secret-for-tests",
  JWT_SECRET: "j".repeat(48),
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
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

describe("adapter configuration", () => {
  const prod = {
    ...valid,
    WEB_APP_URL: "https://app.ajo.example",
    MAIL_PROVIDER: "smtp",
    SMTP_HOST: "smtp.ajo.example",
    SMTP_USER: "mailer",
    SMTP_PASSWORD: "live-secret",
    SMTP_FROM: "Àjo <noreply@ajo.example>",
    BREACHED_PASSWORD_CHECK: "hibp",
  };

  it("accepts real providers in production", () => {
    expect(loadEnv(prod)).toMatchObject({
      MAIL_PROVIDER: "smtp",
      BREACHED_PASSWORD_CHECK: "hibp",
    });
  });

  it("uses stand-ins by default outside production", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://a:b@localhost/ajo",
      REDIS_URL: "redis://localhost",
    });
    expect(env).toMatchObject({
      MAIL_PROVIDER: "fake",
      BREACHED_PASSWORD_CHECK: "fake",
      WEB_APP_URL: "http://localhost:3000",
    });
  });

  it("refuses stand-in adapters in production", () => {
    expect(() => loadEnv({ ...prod, MAIL_PROVIDER: "fake" })).toThrow(/MAIL_PROVIDER/);
    expect(() => loadEnv({ ...prod, BREACHED_PASSWORD_CHECK: "fake" })).toThrow(
      /BREACHED_PASSWORD_CHECK/,
    );
    expect(() => loadEnv({ ...prod, BOT_CHECK: "fake" })).toThrow(/BOT_CHECK/);
  });

  it("needs the Turnstile secret when Turnstile is the bot check, and never accepts it as blank", () => {
    expect(() => loadEnv({ ...prod, TURNSTILE_SECRET_KEY: undefined })).toThrow(
      /TURNSTILE_SECRET_KEY/,
    );
    expect(() => loadEnv({ ...prod, TURNSTILE_SECRET_KEY: "" })).toThrow(/TURNSTILE_SECRET_KEY/);
  });

  it("defaults the bot check to the stand-in outside production, and does not echo the secret in errors", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://a:b@localhost/ajo",
      REDIS_URL: "redis://localhost",
    });
    expect(env.BOT_CHECK).toBe("fake");
    expect(() => loadEnv({ ...prod, BOT_CHECK: "nonsense" })).toThrow(/BOT_CHECK/);
    try {
      loadEnv({ ...prod, BOT_CHECK: "nonsense" });
    } catch (error) {
      expect(String(error)).not.toContain("turnstile-secret-for-tests");
    }
  });

  it("needs SMTP credentials and a sender when SMTP is used", () => {
    expect(() => loadEnv({ ...prod, SMTP_HOST: undefined })).toThrow(/SMTP_HOST/);
    expect(() => loadEnv({ ...prod, SMTP_PASSWORD: undefined })).toThrow(/SMTP_PASSWORD/);
    expect(() => loadEnv({ ...prod, SMTP_FROM: undefined })).toThrow(/SMTP_FROM/);
  });

  it("requires an HTTPS web app URL in production, since links in emails point there", () => {
    expect(() => loadEnv({ ...prod, WEB_APP_URL: "http://app.ajo.example" })).toThrow(
      /WEB_APP_URL/,
    );
    expect(() => loadEnv({ ...prod, WEB_APP_URL: undefined })).toThrow(/WEB_APP_URL/);
  });

  it("never echoes the SMTP password in errors", () => {
    try {
      loadEnv({ ...prod, SMTP_FROM: undefined });
    } catch (error) {
      expect(String(error)).not.toContain("live-secret");
    }
  });
});

describe("JWT_SECRET", () => {
  it("is required in production and must be at least 32 characters", () => {
    expect(() => loadEnv({ ...valid, JWT_SECRET: undefined })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ ...valid, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
    expect(loadEnv({ ...valid, JWT_SECRET: "k".repeat(32) }).JWT_SECRET).toBe("k".repeat(32));
  });

  it("gets a random per-process value in development and tests", () => {
    const base = { DATABASE_URL: "postgres://a:b@localhost/ajo", REDIS_URL: "redis://localhost" };
    const a = loadEnv(base).JWT_SECRET;
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe("FIELD_ENCRYPTION_KEY", () => {
  const dev = {
    NODE_ENV: "development",
    DATABASE_URL: valid.DATABASE_URL,
    REDIS_URL: valid.REDIS_URL,
  };

  it("is required in production", () => {
    expect(() => loadEnv({ ...valid, FIELD_ENCRYPTION_KEY: undefined })).toThrow(
      /FIELD_ENCRYPTION_KEY/,
    );
  });

  it("must be a base64 key of exactly 32 bytes", () => {
    for (const bad of [
      "short",
      Buffer.alloc(16).toString("base64"),
      Buffer.alloc(48).toString("base64"),
    ]) {
      expect(() => loadEnv({ ...valid, FIELD_ENCRYPTION_KEY: bad })).toThrow(
        /FIELD_ENCRYPTION_KEY/,
      );
    }
  });

  it("never echoes the key in an error", () => {
    const secret = "not-a-valid-key-but-very-secret-text";
    try {
      loadEnv({ ...valid, FIELD_ENCRYPTION_KEY: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("falls back to a fixed development key outside production, so local data stays readable across restarts", () => {
    const a = loadEnv(dev).FIELD_ENCRYPTION_KEY;
    const b = loadEnv(dev).FIELD_ENCRYPTION_KEY;
    expect(a).toBe(b);
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(a).not.toBe(valid.FIELD_ENCRYPTION_KEY);
  });
});
