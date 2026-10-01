import * as OTPAuth from "otpauth";
import { Totp } from "./totp.js";

const now = new Date("2026-10-01T12:00:00Z").getTime();
const step = Math.floor(now / 1000 / 30);

function codeAt(secret: string, timestamp: number) {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret),
    digits: 6,
    period: 30,
  }).generate({
    timestamp,
  });
}

describe("Totp", () => {
  const totp = new Totp();

  it("creates a 160-bit secret and an authenticator-app URI", () => {
    const { secret, uri } = totp.createSecret("ada@example.com");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("ada%40example.com");
    expect(uri).toContain(`secret=${secret}`);
    expect(totp.createSecret("a@b.co").secret).not.toBe(secret);
  });

  it("accepts the current code and its time step", () => {
    const { secret } = totp.createSecret("a@b.co");
    expect(totp.verify(secret, codeAt(secret, now), null, now)).toEqual({ ok: true, step });
  });

  it("tolerates one step of clock drift either way, but no more", () => {
    const { secret } = totp.createSecret("a@b.co");
    expect(totp.verify(secret, codeAt(secret, now - 30_000), null, now).ok).toBe(true);
    expect(totp.verify(secret, codeAt(secret, now + 30_000), null, now).ok).toBe(true);
    expect(totp.verify(secret, codeAt(secret, now - 90_000), null, now).ok).toBe(false);
  });

  it("refuses a code that was already used (replay)", () => {
    const { secret } = totp.createSecret("a@b.co");
    const code = codeAt(secret, now);
    expect(totp.verify(secret, code, step, now).ok).toBe(false);
    expect(totp.verify(secret, codeAt(secret, now - 30_000), step, now).ok).toBe(false);
  });

  it("refuses wrong and malformed codes", () => {
    const { secret } = totp.createSecret("a@b.co");
    const right = codeAt(secret, now);
    const wrong = String((Number(right) + 1) % 1_000_000).padStart(6, "0");
    expect(totp.verify(secret, wrong, null, now).ok).toBe(false);
    expect(totp.verify(secret, "12345", null, now).ok).toBe(false);
    expect(totp.verify(secret, "abcdef", null, now).ok).toBe(false);
  });
});
