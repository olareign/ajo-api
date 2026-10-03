/**
 * What a bot check says about a person's token. "unavailable" is kept apart from "failed": a
 * wrong secret or an outage on the provider's side is not the person's fault, and must not look
 * like a wrong answer.
 */
export type BotCheckResult = "passed" | "failed" | "unavailable";

/** Decides whether the person at the other end of a form is a human. */
export interface BotCheck {
  verify(token: string | undefined): Promise<BotCheckResult>;
}

export const BOT_CHECK = Symbol("BOT_CHECK");

/** A Turnstile token is at most 2048 characters; anything longer is refused without a lookup. */
export const BOT_TOKEN_MAX_LENGTH = 2048;
