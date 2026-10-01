import type { BreachedPasswords } from "./breached-passwords.port.js";

/** Development and test stand-in: a fixed list of "breached" passwords. Refused in production. */
export class FakeBreachedPasswords implements BreachedPasswords {
  static readonly KNOWN_BREACHED = new Set(["password123456", "qwertyuiop123", "123456789012"]);

  async isBreached(password: string): Promise<boolean> {
    return FakeBreachedPasswords.KNOWN_BREACHED.has(password);
  }
}
