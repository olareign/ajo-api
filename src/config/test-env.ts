/** A complete, valid production environment for unit tests (no real secrets). */
export const PRODUCTION_TEST_ENV: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://ajo:pw@db:5432/ajo",
  REDIS_URL: "redis://cache:6379",
  WEB_APP_URL: "https://app.ajo.example",
  MAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test_not_a_real_key",
  MAIL_FROM: "Àjọ <no-reply@ajo.example>",
  BREACHED_PASSWORD_CHECK: "hibp",
  JWT_SECRET: "test-only-signing-key-not-used-anywhere-else",
};
