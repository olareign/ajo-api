import { Logger } from "@nestjs/common";
import { BOT_TOKEN_MAX_LENGTH, type BotCheck, type BotCheckResult } from "./bot-check.port.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Answers that mean the problem is ours or Cloudflare's, not the person's. */
const NOT_THE_PERSONS_FAULT = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "internal-error",
  "bad-request",
]);

/**
 * Cloudflare Turnstile server-side check. A token is single-use, so it is verified exactly once.
 *
 * Fails closed: if Cloudflare cannot be reached or gives an unusable answer the result is
 * "unavailable" and sign-up is refused with a try-again message, because a bot check that waves
 * everyone through during an outage protects nothing. The secret and the token are never logged.
 *
 * The visitor's address is deliberately not sent: until the web server forwards the person's real
 * address (plan E1.4), every request would carry the web server's own.
 */
export class TurnstileBotCheck implements BotCheck {
  private readonly logger = new Logger(TurnstileBotCheck.name);

  constructor(
    private readonly secret: string,
    private readonly fetchFn: Fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  async verify(token: string | undefined): Promise<BotCheckResult> {
    if (!token || token.length > BOT_TOKEN_MAX_LENGTH) return "failed";
    try {
      const res = await this.fetchFn(SITEVERIFY, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: this.secret, response: token }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Cloudflare explains a refusal in the body, sometimes with an HTTP 400, so read it first.
      const body = (await res.json().catch(() => null)) as {
        success?: unknown;
        "error-codes"?: unknown;
      } | null;
      if (body === null || typeof body !== "object") throw new Error(`HTTP ${res.status}`);
      if (res.ok && body.success === true) return "passed";
      const codes = Array.isArray(body["error-codes"]) ? (body["error-codes"] as string[]) : [];
      const ours = codes.filter((code) => NOT_THE_PERSONS_FAULT.has(code));
      if (ours.length > 0) {
        this.logger.error({ codes: ours }, "Turnstile refused our request; check the secret key");
        return "unavailable";
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return "failed";
    } catch (error) {
      this.logger.warn({ err: error }, "Turnstile could not be reached; refusing the sign-up");
      return "unavailable";
    }
  }
}
