import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

/** One random signing key per process for development and tests (sessions reset on restart). */
const DEV_JWT_SECRET = randomBytes(48).toString("base64url");

/**
 * A fixed key for development and tests only, so data encrypted locally can be read after a
 * restart. Production refuses to start without a real key.
 */
const DEV_FIELD_ENCRYPTION_KEY = createHash("sha256")
  .update("ajo-development-only-field-encryption-key")
  .digest("base64");

const flag = z.enum(["true", "false"]).transform((value) => value === "true");

const urlWithScheme = (schemes: readonly string[]) =>
  z.string().refine(
    (value) => {
      try {
        return schemes.includes(new URL(value).protocol.replace(/:$/, ""));
      } catch {
        return false;
      }
    },
    { message: `must be a ${schemes.join(" or ")} URL` },
  );

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    DATABASE_URL: urlWithScheme(["postgres", "postgresql"]),
    /** TLS to Postgres. Defaults to on in production. */
    DATABASE_SSL: flag.optional(),
    REDIS_URL: urlWithScheme(["redis", "rediss"]),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    /** Reverse proxies in front of the API (Render has one); used for client IPs and rate limits. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    API_DOCS_ENABLED: flag.default(false),
    /** Base URL of the web app; links in emails (verification, reset) point here. */
    WEB_APP_URL: urlWithScheme(["https", "http"]).optional(),
    MAIL_PROVIDER: z.enum(["fake", "resend"]).default("fake"),
    RESEND_API_KEY: z.string().min(1).optional(),
    MAIL_FROM: z.string().min(3).optional(),
    BREACHED_PASSWORD_CHECK: z.enum(["fake", "hibp"]).default("fake"),
    /** HMAC key for access tokens; at least 32 characters, required in production. */
    JWT_SECRET: z.string().min(32).optional(),
    /** AES-256 key (32 random bytes, base64) for sensitive columns such as authenticator secrets. */
    FIELD_ENCRYPTION_KEY: z
      .string()
      .refine((value) => Buffer.from(value, "base64").length === 32, {
        message: "must be 32 bytes, base64-encoded",
      })
      .optional(),
  })
  .transform((env) => ({
    ...env,
    DATABASE_SSL: env.DATABASE_SSL ?? env.NODE_ENV === "production",
    WEB_APP_URL: env.WEB_APP_URL ?? (env.NODE_ENV === "production" ? "" : "http://localhost:3000"),
    JWT_SECRET: env.JWT_SECRET ?? (env.NODE_ENV === "production" ? "" : DEV_JWT_SECRET),
    FIELD_ENCRYPTION_KEY:
      env.FIELD_ENCRYPTION_KEY ?? (env.NODE_ENV === "production" ? "" : DEV_FIELD_ENCRYPTION_KEY),
  }))
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production" && env.API_DOCS_ENABLED) {
      ctx.addIssue({
        code: "custom",
        path: ["API_DOCS_ENABLED"],
        message: "must be false in production",
      });
    }
    const require = (key: keyof typeof env, message: string) =>
      ctx.addIssue({ code: "custom", path: [key], message });

    if (env.NODE_ENV === "production") {
      if (!env.WEB_APP_URL.startsWith("https://"))
        require("WEB_APP_URL", "must be an https URL in production");
      // Stand-in adapters exist for development and tests only.
      if (env.MAIL_PROVIDER === "fake")
        require("MAIL_PROVIDER", "stand-in not allowed in production");
      if (!env.JWT_SECRET) require("JWT_SECRET", "required in production");
      if (!env.FIELD_ENCRYPTION_KEY) require("FIELD_ENCRYPTION_KEY", "required in production");
      if (env.BREACHED_PASSWORD_CHECK === "fake") {
        require("BREACHED_PASSWORD_CHECK", "stand-in not allowed in production");
      }
    }
    if (env.MAIL_PROVIDER === "resend") {
      if (!env.RESEND_API_KEY) require("RESEND_API_KEY", "required when MAIL_PROVIDER=resend");
      if (!env.MAIL_FROM) require("MAIL_FROM", "required when MAIL_PROVIDER=resend");
    }
  });

export type Env = z.output<typeof schema>;

/**
 * Validates the process environment at startup. The error lists the variable names and
 * what is wrong with them, never their values, so secrets cannot leak into logs.
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return result.data;
}
