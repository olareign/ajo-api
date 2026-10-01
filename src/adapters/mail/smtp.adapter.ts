import { createTransport } from "nodemailer";
import type { Mailer, MailMessage } from "./mailer.port.js";

export type SmtpSettings = Readonly<{
  host: string;
  port: number;
  /** Port 465 is always implicit TLS, whatever this says; other ports upgrade with STARTTLS. */
  secure?: boolean;
  user: string;
  password: string;
  from: string;
  /** Extra TLS options, for a private certificate authority in tests. */
  tls?: Readonly<{ ca?: string }>;
}>;

/** The part of a nodemailer transport the mailer uses; tests pass a stand-in. */
export type SmtpTransport = {
  sendMail(options: Record<string, unknown>): Promise<unknown>;
};

export function resolveSecure(port: number, secure: boolean | undefined): boolean {
  return port === 465 ? true : (secure ?? false);
}

export class SmtpMailer implements Mailer {
  private readonly transport: SmtpTransport;

  constructor(
    private readonly settings: SmtpSettings,
    transport?: SmtpTransport,
  ) {
    this.transport =
      transport ??
      createTransport({
        host: settings.host,
        port: settings.port,
        secure: resolveSecure(settings.port, settings.secure),
        requireTLS: true,
        tls: settings.tls ? { ca: settings.tls.ca } : undefined,
        auth: { user: settings.user, pass: settings.password },
        connectionTimeout: 30_000,
        greetingTimeout: 15_000,
        socketTimeout: 30_000,
      });
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        // SMTP has no idempotency key; a stable Message-ID lets receivers drop duplicates.
        messageId: `<${message.idempotencyKey.replace(/[^\w.-]/g, "-")}@ajo.mail>`,
      });
    } catch (error) {
      // Only the error's short code reaches the logs: the full text can echo the server's reply.
      const code = (error as { code?: unknown }).code;
      const responseCode = (error as { responseCode?: unknown }).responseCode;
      const detail = [code, responseCode].filter(
        (x) => typeof x === "string" || typeof x === "number",
      );
      throw new Error(
        `Email provider rejected the message (SMTP${detail.length ? ` ${detail.join(" ")}` : ""})`,
      );
    }
  }
}
