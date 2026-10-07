import type { PushMessage, PushOutcome, PushSender, PushTarget } from "./push-sender.port.js";

/** Keeps what it was asked to send, for development and tests. Never used in production. */
export class FakePushSender implements PushSender {
  readonly publicKey =
    "BFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake";
  readonly sent: { target: PushTarget; message: PushMessage }[] = [];
  /** What to answer for an endpoint; "sent" for any that is not listed. */
  readonly answers = new Map<string, PushOutcome>();

  async send(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
    this.sent.push({ target, message });
    return this.answers.get(target.endpoint) ?? "sent";
  }
}
