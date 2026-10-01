import type { Mailer, MailMessage } from "./mailer.port.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": message.idempotencyKey,
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Email provider rejected the message (HTTP ${res.status})`);
    }
  }
}
