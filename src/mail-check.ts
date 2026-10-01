/* oxlint-disable no-console -- a command-line tool whose output is the console */
/**
 * Sends one real email with the configured SMTP settings, to prove they work:
 *   pnpm build && pnpm mail:check you@example.com
 * Prints only a short result; the password never appears in the output.
 */
import { loadEnv } from "./config/env.js";
import { SmtpMailer } from "./adapters/mail/smtp.adapter.js";

const to = process.argv[2];
if (!to?.includes("@")) {
  console.error("Usage: pnpm mail:check <recipient email>");
  process.exit(2);
}
const env = loadEnv(process.env);
if (env.MAIL_PROVIDER !== "smtp") {
  console.error("MAIL_PROVIDER is not smtp, so there is nothing to check.");
  process.exit(2);
}
const mailer = new SmtpMailer({
  host: env.SMTP_HOST!,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  user: env.SMTP_USER!,
  password: env.SMTP_PASSWORD!,
  from: env.SMTP_FROM!,
});
try {
  await mailer.send({
    to,
    subject: "Àjo email check",
    text: "If you can read this, Àjo can send email.",
    html: "<p>If you can read this, Àjo can send email.</p>",
    idempotencyKey: `mail-check:${Date.now()}`,
  });
  console.log(`Sent to ${to} from ${env.SMTP_FROM} via ${env.SMTP_HOST}:${env.SMTP_PORT}.`);
} catch (error) {
  console.error(`Failed: ${(error as Error).message}`);
  process.exit(1);
}
