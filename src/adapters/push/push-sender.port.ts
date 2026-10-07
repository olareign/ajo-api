/** One browser's address for pushes, as the browser handed it over. */
export type PushTarget = Readonly<{ endpoint: string; p256dh: string; auth: string }>;

/** What goes to the lock screen. Kept small and free of anything private. */
export type PushMessage = Readonly<{ title: string; body: string; link: string; tag: string }>;

/**
 * "sent": the push service took it. "gone": that browser unsubscribed or expired, so forget it.
 * "failed": the push service had a problem; worth another try later.
 */
export type PushOutcome = "sent" | "gone" | "failed";

export interface PushSender {
  send(target: PushTarget, message: PushMessage): Promise<PushOutcome>;
  /** The public half of the key pair, which browsers need to subscribe. */
  readonly publicKey: string;
}

/** Null where push is not switched on (production without VAPID settings). */
export const PUSH_SENDER = Symbol("PUSH_SENDER");

/**
 * Only the real push services may be written to. The address comes from the browser, so without this
 * anyone could make our server post to a host of their choosing.
 */
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /(^|\.)push\.apple\.com$/,
];

export function isPushEndpoint(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      PUSH_HOSTS.some((host) => host.test(url.hostname))
    );
  } catch {
    return false;
  }
}
