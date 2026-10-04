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
    MAIL_PROVIDER: z.enum(["fake", "smtp", "resend"]).default("fake"),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    SMTP_SECURE: flag.optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    /** Sender shown on every email, e.g. `Àjo <noreply@example.com>`. */
    SMTP_FROM: z.string().min(3).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_FROM: z.string().min(3).optional(),
    SUPPORT_EMAIL: z.string().email().optional(),
    BREACHED_PASSWORD_CHECK: z.enum(["fake", "hibp"]).default("fake"),
    /** Bot protection on sign-up. `turnstile` is Cloudflare Turnstile and needs its secret key. */
    BOT_CHECK: z.enum(["fake", "turnstile"]).default("fake"),
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
    /**
     * Shared with the web app's server. When set, the person's own address and device that the web
     * server reports (proved by this secret) are used for rate limits, sessions and sign-in alerts.
     * Unset, they are ignored. At least 32 characters; generate with: openssl rand -base64 48
     */
    BFF_SHARED_SECRET: z.string().min(32).optional(),
    /**
     * Payment partners. With none set, money screens show "not switched on" and nothing can move.
     * Paystack serves Nigeria (card, transfer, USSD, direct debit, payouts); GoCardless serves the UK
     * (bank payments and Bacs direct debit). Use test keys until the business is verified.
     */
    PAYSTACK_SECRET_KEY: z
      .string()
      .regex(
        /^sk_(test|live)_[A-Za-z0-9]+$/,
        "must be a Paystack secret key (sk_test_… or sk_live_…)",
      )
      .optional(),
    PAYSTACK_BASE_URL: urlWithScheme(["https", "http"]).default("https://api.paystack.co"),
    GOCARDLESS_ACCESS_TOKEN: z.string().min(1).optional(),
    /** The signing secret of the webhook endpoint set up in the GoCardless dashboard. */
    GOCARDLESS_WEBHOOK_SECRET: z.string().min(1).optional(),
    GOCARDLESS_ENVIRONMENT: z.enum(["sandbox", "live"]).default("sandbox"),
    /** A stand-in partner for development and tests (it can pretend to move money). Never in production. */
    PAYMENTS_FAKE: flag.default(false),
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
      if (env.BOT_CHECK === "fake") require("BOT_CHECK", "stand-in not allowed in production");
    }
    if (env.NODE_ENV === "production" && env.PAYMENTS_FAKE) {
      require("PAYMENTS_FAKE", "stand-in not allowed in production");
    }
    if (env.GOCARDLESS_ACCESS_TOKEN && !env.GOCARDLESS_WEBHOOK_SECRET) {
      require("GOCARDLESS_WEBHOOK_SECRET", "required when GOCARDLESS_ACCESS_TOKEN is set");
    }
    if (env.BOT_CHECK === "turnstile" && !env.TURNSTILE_SECRET_KEY) {
      require("TURNSTILE_SECRET_KEY", "required when BOT_CHECK=turnstile");
    }
    if (env.MAIL_PROVIDER === "smtp") {
      for (const key of ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"] as const) {
        if (!env[key]) require(key, "required when MAIL_PROVIDER=smtp");
      }
    }
    if (env.MAIL_PROVIDER === "resend") {
      for (const key of ["RESEND_API_KEY", "RESEND_FROM"] as const) {
        if (!env[key]) require(key, "required when MAIL_PROVIDER=resend");
      }
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
