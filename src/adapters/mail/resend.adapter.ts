import { Resend } from "resend";
import type { Mailer, MailMessage } from "./mailer.port.js";

export type ResendSettings = Readonly<{
  apiKey: string;
  from: string;
}>;

export class ResendMailer implements Mailer {
  private readonly client: Resend;

  constructor(private readonly settings: ResendSettings) {
    this.client = new Resend(settings.apiKey);
  }

  async send(message: MailMessage): Promise<void> {
    try {
      await this.client.emails.send({
        from: this.settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: {
          "X-Idempotency-Key": message.idempotencyKey,
        },
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      const detail = [code, statusCode].filter(
        (x) => typeof x === "string" || typeof x === "number",
      );
      throw new Error(
        `Email provider rejected the message (Resend${detail.length ? ` ${detail.join(" ")}` : ""})`,
      );
    }
  }
}
