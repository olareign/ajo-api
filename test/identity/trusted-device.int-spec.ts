import type { NestExpressApplication } from "@nestjs/platform-express";
import * as OTPAuth from "otpauth";
import request from "supertest";
import { DataSource } from "typeorm";
import type { FakeMailer } from "../../src/adapters/mail/fake.adapter.js";
import { MAILER } from "../../src/adapters/mail/mailer.port.js";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp, tokenFrom } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
const http = () => app.getHttpServer();

const codeAt = (secret: string, offsetSeconds = 0) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offsetSeconds * 1000,
  });
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile";

const login = (email: string, password: string, deviceToken?: string) =>
  request(http())
    .post("/api/v1/auth/login")
    .set("X-Forwarded-For", newIp())
    .set("User-Agent", ANDROID)
    .send({ email, password, ...(deviceToken ? { deviceToken } : {}) });
const loginMfa = (body: Record<string, unknown>) =>
  request(http())
    .post("/api/v1/auth/login/mfa")
    .set("X-Forwarded-For", newIp())
    .set("User-Agent", ANDROID)
    .send(body);
const authed = (method: "get" | "post" | "delete", path: string, token: string) =>
  request(http())
    [method](path)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Forwarded-For", newIp())
    .set("User-Agent", ANDROID);

/** A verified user with the authenticator app on. `trust` is the token the confirm step hands back. */
async function userWithMfa() {
  const user = await createVerifiedUser(app);
  const { accessToken } = (await login(user.email, user.password).expect(200)).body;
  const enrol = (await authed("post", "/api/v1/auth/mfa/totp", accessToken).expect(200)).body;
  const confirm = (
    await authed("post", "/api/v1/auth/mfa/totp/confirm", accessToken)
      .send({ code: codeAt(enrol.secret) })
      .expect(200)
  ).body;
  return {
    ...user,
    accessToken: accessToken as string,
    secret: enrol.secret as string,
    recoveryCodes: confirm.recoveryCodes as string[],
    trust: confirm.deviceToken as string | undefined,
  };
}

/**
 * Signs in with a recovery code and asks to be remembered; returns the device token. Recovery codes
 * leave the authenticator's own step free, because a code works once and only the current step and
 * its neighbours are accepted, so a test cannot use many.
 */
async function trustThisDevice(user: Awaited<ReturnType<typeof userWithMfa>>, spare = 0) {
  const challenge = (await login(user.email, user.password).expect(200)).body;
  const done = await loginMfa({
    mfaToken: challenge.mfaToken,
    recoveryCode: user.recoveryCodes[spare],
    trustDevice: true,
  }).expect(200);
  return done.body as { accessToken: string; deviceToken?: string };
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
});
afterAll(async () => {
  await app?.close();
});

describe("a device that has proved itself is not asked again", () => {
  it("asks for a code on a device it has not seen, and remembers the device only when asked to", async () => {
    const user = await userWithMfa();
    const challenge = (await login(user.email, user.password).expect(200)).body;
    expect(challenge.mfaRequired).toBe(true);

    const plain = await loginMfa({ mfaToken: challenge.mfaToken, code: codeAt(user.secret, 30) });
    expect(plain.status).toBe(200);
    expect(plain.body.deviceToken).toBeUndefined();
  });

  it("lets a remembered device sign in with the password alone", async () => {
    const user = await userWithMfa();
    const { deviceToken } = await trustThisDevice(user);
    expect(deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const again = await login(user.email, user.password, deviceToken).expect(200);
    expect(again.body.mfaRequired).toBeUndefined();
    expect(again.body.accessToken).toMatch(/^ey/);
  });

  it("trusts the phone the authenticator was just turned on from", async () => {
    const user = await userWithMfa();
    expect(user.trust).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const again = await login(user.email, user.password, user.trust).expect(200);
    expect(again.body.accessToken).toMatch(/^ey/);
  });

  it("works for a sign-in with a recovery code too", async () => {
    const user = await userWithMfa();
    const challenge = (await login(user.email, user.password).expect(200)).body;
    const done = await loginMfa({
      mfaToken: challenge.mfaToken,
      recoveryCode: user.recoveryCodes[0],
      trustDevice: true,
    }).expect(200);
    expect(done.body.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("is for that person only: someone else's token, an invented one, or none still means a code", async () => {
    const ada = await userWithMfa();
    const bola = await userWithMfa();
    const { deviceToken } = await trustThisDevice(ada);

    expect((await login(bola.email, bola.password, deviceToken).expect(200)).body.mfaRequired).toBe(
      true,
    );
    const invented = "A".repeat(43);
    expect((await login(ada.email, ada.password, invented).expect(200)).body.mfaRequired).toBe(
      true,
    );
    expect((await login(ada.email, ada.password).expect(200)).body.mfaRequired).toBe(true);
  });

  it("is still refused with a wrong password", async () => {
    const user = await userWithMfa();
    const { deviceToken } = await trustThisDevice(user);
    await login(user.email, "not the password at all", deviceToken).expect(401);
  });

  it("keeps only a hash of the token, never the token", async () => {
    const user = await userWithMfa();
    const { deviceToken } = await trustThisDevice(user);
    const rows = await db.query("SELECT token_hash FROM trusted_devices");
    expect(JSON.stringify(rows)).not.toContain(deviceToken);
  });

  it("forgets a device after 30 days without a sign-in, and keeps one that is used", async () => {
    const user = await userWithMfa();
    const { deviceToken } = await trustThisDevice(user);
    await db.query(`UPDATE trusted_devices SET expires_at = now() - interval '1 second'`);
    expect((await login(user.email, user.password, deviceToken).expect(200)).body.mfaRequired).toBe(
      true,
    );

    const fresh = await trustThisDevice(user, 1);
    await db.query(
      `UPDATE trusted_devices SET expires_at = now() + interval '1 day' WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [user.email],
    );
    await login(user.email, user.password, fresh.deviceToken).expect(200);
    const [row] = await db.query(
      `SELECT expires_at > now() + interval '29 days' AS slid FROM trusted_devices
        WHERE user_id = (SELECT id FROM users WHERE email = $1) AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
      [user.email],
    );
    expect(row.slid).toBe(true);
  });

  it("keeps at most ten devices, dropping the oldest", async () => {
    const user = await userWithMfa();
    // The phone it was turned on from is the first of the eleven.
    const first = { deviceToken: user.trust };
    for (let i = 0; i < 10; i++) await trustThisDevice(user, i);
    const [{ count }] = await db.query(
      `SELECT count(*)::int AS count FROM trusted_devices WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [user.email],
    );
    expect(count).toBe(10);
    expect(
      (await login(user.email, user.password, first.deviceToken).expect(200)).body.mfaRequired,
    ).toBe(true);
  });
});

describe("what takes trust away", () => {
  it("signing out of all devices", async () => {
    const user = await userWithMfa();
    const { deviceToken, accessToken } = await trustThisDevice(user);
    await authed("post", "/api/v1/auth/logout-all", accessToken).expect(204);
    expect((await login(user.email, user.password, deviceToken).expect(200)).body.mfaRequired).toBe(
      true,
    );
  });

  it("choosing a new password", async () => {
    const user = await userWithMfa();
    const { deviceToken } = await trustThisDevice(user);
    const mailer = app.get<FakeMailer>(MAILER);
    await request(http())
      .post("/api/v1/auth/password/forgot")
      .set("X-Forwarded-For", newIp())
      .send({ email: user.email })
      .expect(202);
    const token = tokenFrom(mailer.lastTo(user.email)!.text);
    const password = "Lagos-Mango-Drum-4721-Tide";
    await request(http())
      .post("/api/v1/auth/password/reset")
      .set("X-Forwarded-For", newIp())
      .send({ token, password })
      .expect(200);
    expect((await login(user.email, password, deviceToken).expect(200)).body.mfaRequired).toBe(
      true,
    );
  });

  it("turning the authenticator off, so turning it on again starts from nothing", async () => {
    const user = await userWithMfa();
    const { deviceToken, accessToken } = await trustThisDevice(user);
    await authed("delete", "/api/v1/auth/mfa/totp", accessToken)
      .send({ password: user.password, code: codeAt(user.secret, 30) })
      .expect(204);
    const [{ count }] = await db.query(
      `SELECT count(*)::int AS count FROM trusted_devices WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [user.email],
    );
    expect(count).toBe(0);

    const t = (await login(user.email, user.password).expect(200)).body.accessToken;
    const enrol = (await authed("post", "/api/v1/auth/mfa/totp", t).expect(200)).body;
    await authed("post", "/api/v1/auth/mfa/totp/confirm", t)
      .send({ code: codeAt(enrol.secret) })
      .expect(200);
    expect((await login(user.email, user.password, deviceToken).expect(200)).body.mfaRequired).toBe(
      true,
    );
  });
});
