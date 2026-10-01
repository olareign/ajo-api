import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { BreachedPasswords } from "./breached-passwords.port.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Have I Been Pwned "Pwned Passwords" range API (k-anonymity): only the first five
 * characters of the password's SHA-1 leave the server, with padded responses.
 *
 * If the service is unreachable the check fails open (returns "not breached") so an
 * outage cannot block every sign-up; the other password rules still apply and the
 * failure is logged for follow-up.
 */
export class HibpBreachedPasswords implements BreachedPasswords {
  private readonly logger = new Logger(HibpBreachedPasswords.name);

  constructor(
    private readonly fetchFn: Fetch = fetch,
    private readonly timeoutMs = 2000,
  ) {}

  async isBreached(password: string): Promise<boolean> {
    const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    try {
      const res = await this.fetchFn(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { "Add-Padding": "true", "User-Agent": "ajo-api" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      return body.split(/\r?\n/).some((line) => {
        const [candidate, count] = line.split(":");
        return candidate === suffix && Number(count) > 0;
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Breached-password check unavailable; allowing password");
      return false;
    }
  }
}
