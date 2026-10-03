import { Resend } from "resend";
import type { Mailer, MailMessage } from "./mailer.port.js";

export type ResendSettings = Readonly<{
  apiKey: string;
  from: string;
}>;

/** Only the error's short code and HTTP status are kept: its text can hold the key or recipient. */
function rejected(error: unknown): Error {
  const { name, code, statusCode } = error as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
  };
  const detail = [code ?? name, statusCode].filter(
    (x) => typeof x === "string" || typeof x === "number",
  );
  return new Error(
    `Email provider rejected the message (Resend${detail.length ? ` ${detail.join(" ")}` : ""})`,
  );
}

export class ResendMailer implements Mailer {
  constructor(
    private readonly settings: ResendSettings,
    private readonly client: Resend = new Resend(settings.apiKey),
  ) {}

  async send(message: MailMessage): Promise<void> {
    let result;
    try {
      result = await this.client.emails.send(
        {
          from: this.settings.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
        { idempotencyKey: message.idempotencyKey },
      );
    } catch (error) {
      throw rejected(error);
    }
    // The SDK reports API errors (bad key, unverified domain, rate limit) in the result instead
    // of throwing, so it must be checked or a failed send looks like a success.
    if (result.error) throw rejected(result.error);
  }
}
