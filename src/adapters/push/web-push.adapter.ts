import { Logger } from "@nestjs/common";
import webpush from "web-push";
import type { PushMessage, PushOutcome, PushSender, PushTarget } from "./push-sender.port.js";

export type VapidSettings = Readonly<{ publicKey: string; privateKey: string; subject: string }>;

/** Sends through the browsers' own push services with our VAPID key. The private key is never logged. */
export class WebPushSender implements PushSender {
  private readonly logger = new Logger(WebPushSender.name);
  readonly publicKey: string;
  /** A true private field: it cannot end up in a log line or a JSON dump of this object. */
  readonly #settings: VapidSettings;

  constructor(settings: VapidSettings) {
    this.#settings = settings;
    this.publicKey = settings.publicKey;
  }

  async send(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        {
          vapidDetails: {
            subject: this.#settings.subject,
            publicKey: this.#settings.publicKey,
            privateKey: this.#settings.privateKey,
          },
          TTL: 60 * 60,
          urgency: "normal",
          timeout: 10_000,
        },
      );
      return "sent";
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) return "gone";
      this.logger.warn(`A push was not accepted (${status ?? "no answer"})`);
      return "failed";
    }
  }
}
