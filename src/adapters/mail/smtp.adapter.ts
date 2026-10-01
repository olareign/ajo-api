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
        auth: { user: settings.user, pass: settings.password },
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
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
    } catch {
      // Never surface the transport error: it can echo the server's reply or credentials.
      throw new Error("Email provider rejected the message (SMTP)");
    }
  }
}
