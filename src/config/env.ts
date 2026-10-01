import { z } from "zod";

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
  })
  .transform((env) => ({
    ...env,
    DATABASE_SSL: env.DATABASE_SSL ?? env.NODE_ENV === "production",
    WEB_APP_URL: env.WEB_APP_URL ?? (env.NODE_ENV === "production" ? "" : "http://localhost:3000"),
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
