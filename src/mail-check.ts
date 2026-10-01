/* oxlint-disable no-console -- a command-line tool whose output is the console */
/**
 * Sends one real email with the configured email provider, to prove it works:
 *   pnpm build && pnpm mail:check you@example.com
 * Prints only a short result; the password never appears in the output.
 *
 * This script validates only email provider environment variables, not the full application config.
 * Supports both SMTP and Resend based on MAIL_PROVIDER.
 */
import { z } from "zod";
import { ResendMailer } from "./adapters/mail/resend.adapter.js";
import { SmtpMailer } from "./adapters/mail/smtp.adapter.js";

const to = process.argv[2];
if (!to?.includes("@")) {
  console.error("Usage: pnpm mail:check <recipient email>");
  process.exit(2);
}

// Minimal validation for email provider settings only
const flag = z.enum(["true", "false"]).transform((value) => value === "true");
const emailerSchema = z
  .object({
    MAIL_PROVIDER: z.enum(["fake", "smtp", "resend"]),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465).optional(),
    SMTP_SECURE: flag.optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    SMTP_FROM: z.string().min(3).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    RESEND_FROM: z.string().min(3).optional(),
  })
  .superRefine((env, ctx) => {
    const require = (key: keyof typeof env, message: string) =>
      ctx.addIssue({ code: "custom", path: [key], message });

    if (env.MAIL_PROVIDER === "fake") {
      ctx.addIssue({
        code: "custom",
        path: ["MAIL_PROVIDER"],
        message: "must be 'smtp' or 'resend' to check email sending",
      });
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

const result = emailerSchema.safeParse(process.env);
if (!result.success) {
  const problems = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  console.error(`Invalid emailer configuration: ${problems}`);
  process.exit(2);
}

const env = result.data;
const mailer =
  env.MAIL_PROVIDER === "smtp"
    ? new SmtpMailer({
        host: env.SMTP_HOST!,
        port: env.SMTP_PORT!,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER!,
        password: env.SMTP_PASSWORD!,
        from: env.SMTP_FROM!,
      })
    : new ResendMailer({
        apiKey: env.RESEND_API_KEY!,
        from: env.RESEND_FROM!,
      });
try {
  await mailer.send({
    to,
    subject: "Àjo email check",
    text: "If you can read this, Àjo can send email.",
    html: "<p>If you can read this, Àjo can send email.</p>",
    idempotencyKey: `mail-check:${Date.now()}`,
  });
  const from = env.MAIL_PROVIDER === "smtp" ? env.SMTP_FROM! : env.RESEND_FROM!;
  const via =
    env.MAIL_PROVIDER === "smtp"
      ? `${env.SMTP_HOST}:${env.SMTP_PORT}`
      : "Resend API";
  console.log(`Sent to ${to} from ${from} via ${via} (MAIL_PROVIDER=${env.MAIL_PROVIDER}).`);
} catch (error) {
  console.error(`Failed: ${(error as Error).message}`);
  process.exit(1);
}
