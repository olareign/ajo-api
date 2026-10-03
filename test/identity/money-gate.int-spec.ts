import type { NestExpressApplication } from "@nestjs/platform-express";
import * as OTPAuth from "otpauth";
import request from "supertest";
import { DataSource } from "typeorm";
import { MoneyProbeController } from "../support/money-probe.controller.js";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
const http = () => app.getHttpServer();

const codeAt = (secret: string, offsetSeconds = 0) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offsetSeconds * 1000,
  });

const authed = (method: "get" | "post", path: string, token: string) =>
  request(http())
    [method](path)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Forwarded-For", newIp());

async function signedIn() {
  const user = await createVerifiedUser(app);
  const { accessToken } = (
    await request(http())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .send({ email: user.email, password: user.password })
      .expect(200)
  ).body;
  return { ...user, accessToken: accessToken as string };
}

async function withAuthenticator() {
  const user = await signedIn();
  const enrol = (await authed("post", "/api/v1/auth/mfa/totp", user.accessToken).expect(200)).body;
  await authed("post", "/api/v1/auth/mfa/totp/confirm", user.accessToken)
    .send({ code: codeAt(enrol.secret) })
    .expect(200);
  return { ...user, secret: enrol.secret as string };
}

const move = (token: string, code?: string) => {
  const req = authed("post", "/api/v1/test/money", token);
  return code === undefined ? req : req.set("X-Ajo-Mfa-Code", code);
};

beforeAll(async () => {
  app = await createTestApp({}, [MoneyProbeController]);
  db = app.get(DataSource);
});
afterAll(async () => {
  await app?.close();
});

describe("moving money needs the authenticator app", () => {
  it("is refused, with a word the app can act on, until the person has turned the app on", async () => {
    const user = await signedIn();
    const res = await move(user.accessToken, "123456").expect(403);
    expect(res.body.code).toBe("mfa_enrolment_required");
    expect(res.body.message).toMatch(/authenticator app/i);
  });

  it("is refused for someone who started setting it up but never confirmed", async () => {
    const user = await signedIn();
    await authed("post", "/api/v1/auth/mfa/totp", user.accessToken).expect(200);
    const res = await move(user.accessToken, "123456").expect(403);
    expect(res.body.code).toBe("mfa_enrolment_required");
  });

  it("asks for a code when none is sent", async () => {
    const user = await withAuthenticator();
    const res = await move(user.accessToken).expect(401);
    expect(res.body.code).toBe("mfa_code_required");
  });

  it("refuses a wrong code and lets a right one through", async () => {
    const user = await withAuthenticator();
    const wrong = await move(user.accessToken, "000000").expect(401);
    expect(wrong.body.code).toBe("mfa_code_wrong");
    const done = await move(user.accessToken, codeAt(user.secret, 30)).expect(200);
    expect(done.body).toEqual({ moved: true });
  });

  it("refuses a code that was already used, so an intercepted one cannot be replayed", async () => {
    const user = await withAuthenticator();
    const code = codeAt(user.secret, 30);
    await move(user.accessToken, code).expect(200);
    await move(user.accessToken, code).expect(401);
  });

  it("does not accept a recovery code as the step-up", async () => {
    const user = await withAuthenticator();
    await move(user.accessToken, "abcde-fghjk").expect(401);
  });

  it("locks after ten wrong codes, then refuses even the right one", async () => {
    const user = await withAuthenticator();
    for (let i = 0; i < 10; i++) await move(user.accessToken, "000000").expect(401);
    const res = await move(user.accessToken, codeAt(user.secret, 30)).expect(401);
    expect(res.body.message).toMatch(/Too many wrong codes/);
    await db.query(`UPDATE user_mfa SET locked_until = now() - interval '1 second'`);
    await move(user.accessToken, codeAt(user.secret, 30)).expect(200);
  });

  it("still needs a signed-in session before anything else", async () => {
    await request(http()).post("/api/v1/test/money").set("X-Forwarded-For", newIp()).expect(401);
  });
});
