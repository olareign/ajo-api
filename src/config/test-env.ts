/** A complete, valid production environment for unit tests (no real secrets). */
export const PRODUCTION_TEST_ENV: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://ajo:pw@db:5432/ajo",
  REDIS_URL: "redis://cache:6379",
  WEB_APP_URL: "https://app.ajo.example",
  MAIL_PROVIDER: "smtp",
  SMTP_HOST: "smtp.ajo.example",
  SMTP_USER: "mailer",
  SMTP_PASSWORD: "not-a-real-password",
  SMTP_FROM: "Àjo <noreply@ajo.example>",
  BREACHED_PASSWORD_CHECK: "hibp",
  BOT_CHECK: "turnstile",
  TURNSTILE_SECRET_KEY: "test-only-turnstile-secret",
  JWT_SECRET: "test-only-signing-key-not-used-anywhere-else",
  FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
};
