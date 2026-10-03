import type { BotCheck, BotCheckResult } from "./bot-check.port.js";

/**
 * Development and test stand-in: passes everything, including no token, so ordinary tests and local
 * work need no widget. Two fixed tokens force the refusals. Refused in production.
 */
export class FakeBotCheck implements BotCheck {
  static readonly FAIL = "fail-bot-check";
  static readonly UNAVAILABLE = "unavailable-bot-check";

  async verify(token: string | undefined): Promise<BotCheckResult> {
    if (token === FakeBotCheck.FAIL) return "failed";
    if (token === FakeBotCheck.UNAVAILABLE) return "unavailable";
    return "passed";
  }
}
