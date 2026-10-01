import type { Mailer, MailMessage } from "./mailer.port.js";

/** Development and test stand-in: keeps messages in memory. Refused in production. */
export class FakeMailer implements Mailer {
  readonly outbox: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    if (this.outbox.some((m) => m.idempotencyKey === message.idempotencyKey)) return;
    this.outbox.push(message);
  }

  lastTo(to: string): MailMessage | undefined {
    return this.outbox.filter((m) => m.to === to).at(-1);
  }
}
