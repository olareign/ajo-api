import * as OTPAuth from "otpauth";

const PERIOD_SECONDS = 30;
const CODE = /^\d{6}$/;

export type TotpCheck = { ok: true; step: number } | { ok: false };

/** RFC 6238 authenticator codes: 6 digits, 30-second steps, SHA-1 (what every app supports). */
export class Totp {
  createSecret(accountName: string): { secret: string; uri: string } {
    const secret = new OTPAuth.Secret({ size: 20 });
    const totp = this.totp(secret, accountName);
    return { secret: secret.base32, uri: totp.toString() };
  }

  /**
   * Accepts the code for the current step or one step either side. A step at or before
   * `lastUsedStep` is refused, so an intercepted code cannot be replayed.
   */
  verify(secret: string, code: string, lastUsedStep: number | null, now = Date.now()): TotpCheck {
    if (!CODE.test(code)) return { ok: false };
    const delta = this.totp(OTPAuth.Secret.fromBase32(secret), "").validate({
      token: code,
      timestamp: now,
      window: 1,
    });
    if (delta === null) return { ok: false };
    const step = Math.floor(now / 1000 / PERIOD_SECONDS) + delta;
    if (lastUsedStep !== null && step <= lastUsedStep) return { ok: false };
    return { ok: true, step };
  }

  private totp(secret: OTPAuth.Secret, label: string) {
    return new OTPAuth.TOTP({
      issuer: "Àjọ",
      label,
      algorithm: "SHA1",
      digits: 6,
      period: PERIOD_SECONDS,
      secret,
    });
  }
}
