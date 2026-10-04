import type { NestExpressApplication } from "@nestjs/platform-express";
import * as OTPAuth from "otpauth";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
const http = () => app.getHttpServer();

const codeAt = (secret: string, offsetSeconds = 0) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offsetSeconds * 1000,
  });

function login(email: string, password: string) {
  return request(http())
    .post("/api/v1/auth/login")
    .set("X-Forwarded-For", newIp())
    .send({ email, password });
}
function loginMfa(body: Record<string, string>) {
  return request(http()).post("/api/v1/auth/login/mfa").set("X-Forwarded-For", newIp()).send(body);
}
const authed = (method: "get" | "post" | "delete", path: string, token: string) =>
  request(http())
    [method](path)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Forwarded-For", newIp());

/** A verified user with the authenticator app enrolled; returns its secret and recovery codes. */
async function userWithMfa() {
  const user = await createVerifiedUser(app);
  const { accessToken } = (await login(user.email, user.password).expect(200)).body;
  const enrol = (await authed("post", "/api/v1/auth/mfa/totp", accessToken).expect(200)).body;
  const confirm = await authed("post", "/api/v1/auth/mfa/totp/confirm", accessToken)
    .send({ code: codeAt(enrol.secret) })
    .expect(200);
  return {
    ...user,
    accessToken,
    secret: enrol.secret as string,
    recoveryCodes: confirm.body.recoveryCodes as string[],
  };
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
});
afterAll(async () => {
  await app?.close();
});

describe("enrolling an authenticator app", () => {
  it("gives a secret and QR link, then enables it after a correct code and shows recovery codes once", async () => {
    const user = await createVerifiedUser(app);
    const { accessToken } = (await login(user.email, user.password).expect(200)).body;

    const enrol = await authed("post", "/api/v1/auth/mfa/totp", accessToken).expect(200);
    expect(enrol.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(enrol.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

    await authed("post", "/api/v1/auth/mfa/totp/confirm", accessToken)
      .send({ code: "000000" })
      .expect(400);
    const confirm = await authed("post", "/api/v1/auth/mfa/totp/confirm", accessToken)
      .send({ code: codeAt(enrol.body.secret) })
      .expect(200);
    expect(confirm.body.recoveryCodes).toHaveLength(10);

    const me = await authed("get", "/api/v1/me", accessToken).expect(200);
    expect(me.body.mfaEnabled).toBe(true);
    await authed("post", "/api/v1/auth/mfa/totp", accessToken).expect(409);
  });

  it("stores the secret encrypted, never in plain text", async () => {
    const user = await userWithMfa();
    const rows = await db.query("SELECT totp_secret FROM user_mfa");
    expect(JSON.stringify(rows)).not.toContain(user.secret);
    expect(rows.every((r: { totp_secret: string }) => r.totp_secret.startsWith("v1."))).toBe(true);
  });
});

describe("signing in with a second factor", () => {
  it("asks for a code instead of handing out tokens", async () => {
    const user = await userWithMfa();
    const res = await login(user.email, user.password).expect(200);
    expect(res.body).toEqual({
      mfaRequired: true,
      mfaToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(res.body).not.toHaveProperty("accessToken");

    const done = await loginMfa({
      mfaToken: res.body.mfaToken,
      code: codeAt(user.secret, 30),
    }).expect(200);
    expect(done.body.accessToken).toMatch(/^ey/);
    await authed("get", "/api/v1/me", done.body.accessToken).expect(200);
  });

  it("refuses a code that was already used", async () => {
    const user = await userWithMfa();
    const first = (await login(user.email, user.password).expect(200)).body;
    const code = codeAt(user.secret, 30);
    await loginMfa({ mfaToken: first.mfaToken, code }).expect(200);

    const second = (await login(user.email, user.password).expect(200)).body;
    await loginMfa({ mfaToken: second.mfaToken, code }).expect(401);
  });

  it("accepts each recovery code exactly once", async () => {
    const user = await userWithMfa();
    const [code] = user.recoveryCodes;
    const a = (await login(user.email, user.password).expect(200)).body;
    await loginMfa({ mfaToken: a.mfaToken, recoveryCode: code!.toUpperCase() }).expect(200);
    const b = (await login(user.email, user.password).expect(200)).body;
    await loginMfa({ mfaToken: b.mfaToken, recoveryCode: code! }).expect(401);
  });

  it("ends the challenge after five wrong codes", async () => {
    const user = await userWithMfa();
    const { mfaToken } = (await login(user.email, user.password).expect(200)).body;
    for (let i = 0; i < 5; i++) await loginMfa({ mfaToken, code: "000000" }).expect(401);
    await loginMfa({ mfaToken, code: codeAt(user.secret, 30) }).expect(401);
  });

  it("expires the challenge after a few minutes", async () => {
    const user = await userWithMfa();
    const { mfaToken } = (await login(user.email, user.password).expect(200)).body;
    await db.query("UPDATE mfa_challenges SET expires_at = now() - interval '1 second'");
    await loginMfa({ mfaToken, code: codeAt(user.secret, 30) }).expect(401);
  });

  it("needs exactly one of a code or a recovery code", async () => {
    const user = await userWithMfa();
    const { mfaToken } = (await login(user.email, user.password).expect(200)).body;
    await loginMfa({ mfaToken }).expect(400);
    await loginMfa({ mfaToken, code: "123456", recoveryCode: "abcde-fghjk" }).expect(400);
  });
});

describe("guessing codes", () => {
  it("locks the second step after ten wrong codes, even across fresh sign-ins, then refuses the right code", async () => {
    const user = await userWithMfa();
    for (let round = 0; round < 2; round++) {
      const { mfaToken } = (await login(user.email, user.password).expect(200)).body;
      for (let i = 0; i < 5; i++) await loginMfa({ mfaToken, code: "000000" }).expect(401);
    }
    const { mfaToken } = (await login(user.email, user.password).expect(200)).body;
    const res = await loginMfa({ mfaToken, code: codeAt(user.secret, 30) }).expect(401);
    expect(res.body.message).toMatch(/Too many wrong codes/);
  });

  it("ends a challenge once it has been used, so a code cannot be tried again on it", async () => {
    const user = await userWithMfa();
    const { mfaToken } = (await login(user.email, user.password).expect(200)).body;
    await loginMfa({ mfaToken, code: codeAt(user.secret, 30) }).expect(200);
    const again = await loginMfa({ mfaToken, code: codeAt(user.secret, 60) }).expect(401);
    expect(again.body.message).toMatch(/start again/i);
  });
});

describe("a setup that was never confirmed", () => {
  it("does not change how signing in works, and can be started over with a new secret", async () => {
    const user = await createVerifiedUser(app);
    const { accessToken } = (await login(user.email, user.password).expect(200)).body;
    const first = (await authed("post", "/api/v1/auth/mfa/totp", accessToken).expect(200)).body;
    const second = (await authed("post", "/api/v1/auth/mfa/totp", accessToken).expect(200)).body;
    expect(second.secret).not.toBe(first.secret);

    const me = await authed("get", "/api/v1/me", accessToken).expect(200);
    expect(me.body.mfaEnabled).toBe(false);
    expect((await login(user.email, user.password).expect(200)).body.accessToken).toBeDefined();
    await authed("post", "/api/v1/auth/mfa/totp/confirm", accessToken)
      .send({ code: codeAt(first.secret) })
      .expect(400);
  });

  it("is refused at the database if a secret is ever written without encryption", async () => {
    const user = await createVerifiedUser(app);
    const [{ id }] = await db.query("SELECT id FROM users WHERE email = $1", [user.email]);
    await expect(
      db.query("INSERT INTO user_mfa (user_id, totp_secret) VALUES ($1, 'JBSWY3DPEHPK3PXP')", [id]),
    ).rejects.toThrow();
  });
});

describe("turning the second factor off", () => {
  it("needs the password and a current code", async () => {
    const user = await userWithMfa();
    const wrongPassword = await authed("delete", "/api/v1/auth/mfa/totp", user.accessToken)
      .send({ password: "wrong password entirely", code: codeAt(user.secret, 30) })
      .expect(401);
    expect(wrongPassword.body.code).toBe("password_wrong");
    const wrongCode = await authed("delete", "/api/v1/auth/mfa/totp", user.accessToken)
      .send({ password: user.password, code: "000000" })
      .expect(401);
    expect(wrongCode.body.code).toBe("mfa_code_wrong");
    await authed("delete", "/api/v1/auth/mfa/totp", user.accessToken)
      .send({ password: user.password, code: codeAt(user.secret, 30) })
      .expect(204);

    const res = await login(user.email, user.password).expect(200);
    expect(res.body.accessToken).toBeDefined();
  });
});
