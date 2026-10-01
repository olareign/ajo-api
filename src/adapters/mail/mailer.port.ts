export type MailMessage = Readonly<{
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The same key is never delivered twice, so retries are safe. */
  idempotencyKey: string;
}>;

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export const MAILER = Symbol("MAILER");
