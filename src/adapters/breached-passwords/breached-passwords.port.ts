/** Answers whether a password appears in known data breaches. */
export interface BreachedPasswords {
  isBreached(password: string): Promise<boolean>;
}

export const BREACHED_PASSWORDS = Symbol("BREACHED_PASSWORDS");
