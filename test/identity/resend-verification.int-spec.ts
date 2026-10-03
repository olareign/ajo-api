import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import type { FakeMailer } from "../../src/adapters/mail/fake.adapter.js";
import { MAILER } from "../../src/adapters/mail/mailer.port.js";
import {
  MAX_VERIFICATION_EMAILS_PER_DAY,
  RESEND_COOLDOWN_SECONDS,
} from "../../src/identity/email-verification.service.js";
import { createTestApp } from "../support/test-app.js";
import {
  createVerifiedUser,
  GOOD_PASSWORD,
  newIp,
  tokenFrom,
  uniqueEmail,
} from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
let mailer: FakeMailer;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
  mailer = app.get(MAILER);
});

afterAll(async () => {
  await app?.close();
});

const VERIFY_SUBJECT = "Verify your email for Àjọ";
const GENERIC = {
  message: "If that account still needs confirming, we've sent a new link.",
};

async function signUp(email = uniqueEmail()) {
  await request(app.getHttpServer())
    .post("/api/v1/auth/sign-up")
    .set("X-Forwarded-For", newIp())
    .send({ email, password: GOOD_PASSWORD, displayName: "Ada" })
    .expect(202);
  return email;
}

const resend = (email: string, ip = newIp()) =>
  request(app.getHttpServer())
    .post("/api/v1/auth/email/resend")
    .set("X-Forwarded-For", ip)
    .send({ email });

const login = (email: string, password = GOOD_PASSWORD) =>
  request(app.getHttpServer())
    .post("/api/v1/auth/login")
    .set("X-Forwarded-For", newIp())
    .send({ email, password });

const sentTo = (email: string) => mailer.outbox.filter((m) => m.to === email);

/** Pretends the last link was sent a while ago, so the cooldown has passed. */
async function ageTokens(email: string, seconds: number) {
  await db.query(
    `UPDATE email_verification_tokens
        SET created_at = created_at - make_interval(secs => $2)
      WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
    [email, seconds],
  );
}

describe("POST /auth/email/resend", () => {
  it("emails a new working link to an account that is not verified yet", async () => {
    const email = await signUp();
    await ageTokens(email, RESEND_COOLDOWN_SECONDS + 1);

    const res = await resend(email).expect(202);
    expect(res.body).toEqual(GENERIC);

    const mails = sentTo(email);
    expect(mails).toHaveLength(2);
    expect(mails[1]?.subject).toBe(VERIFY_SUBJECT);
    expect(mails[1]?.text).toContain("https://app.ajo.test/verify-email?token=");

    await request(app.getHttpServer())
      .post("/api/v1/auth/email/verify")
      .set("X-Forwarded-For", newIp())
      .send({ token: tokenFrom(mails[1]!.text) })
      .expect(200);
    await login(email).expect(200);
  });

  it("answers the same, and sends nothing, for unknown and already verified addresses", async () => {
    const unknown = uniqueEmail();
    const verified = (await createVerifiedUser(app)).email;
    const before = mailer.outbox.length;

    const a = await resend(unknown).expect(202);
    const b = await resend(verified).expect(202);

    expect(a.body).toEqual(GENERIC);
    expect(b.body).toEqual(GENERIC);
    expect(mailer.outbox).toHaveLength(before);
  });

  it("sends at most one email a minute to the same address", async () => {
    const email = await signUp();
    await resend(email).expect(202);
    await resend(email).expect(202);
    expect(sentTo(email)).toHaveLength(1); // the sign-up email; both resends were too soon

    await ageTokens(email, RESEND_COOLDOWN_SECONDS + 1);
    await resend(email).expect(202);
    expect(sentTo(email)).toHaveLength(2);
  });

  it("stops after a day's allowance, so an address cannot be flooded", async () => {
    const email = await signUp();
    for (let i = 1; i < MAX_VERIFICATION_EMAILS_PER_DAY; i++) {
      await ageTokens(email, RESEND_COOLDOWN_SECONDS + 1);
      await resend(email).expect(202);
    }
    expect(sentTo(email)).toHaveLength(MAX_VERIFICATION_EMAILS_PER_DAY);

    await ageTokens(email, RESEND_COOLDOWN_SECONDS + 1);
    await resend(email).expect(202);
    expect(sentTo(email)).toHaveLength(MAX_VERIFICATION_EMAILS_PER_DAY);
  });

  it("limits requests per client", async () => {
    const ip = newIp();
    for (let i = 0; i < 5; i++) await resend(uniqueEmail(), ip).expect(202);
    await resend(uniqueEmail(), ip).expect(429);
  });

  it("validates the email", async () => {
    await resend("not-an-email").expect(400);
  });
});

describe("signing in before the email is confirmed", () => {
  it("is refused with a code the app can act on, and sends a fresh link", async () => {
    const email = await signUp();
    await ageTokens(email, RESEND_COOLDOWN_SECONDS + 1);

    const res = await login(email).expect(403);
    expect(res.body).toMatchObject({
      message: "Verify your email before signing in.",
      code: "email_not_verified",
    });
    expect(sentTo(email)).toHaveLength(2);
    expect(sentTo(email)[1]?.subject).toBe(VERIFY_SUBJECT);

    await request(app.getHttpServer())
      .post("/api/v1/auth/email/verify")
      .set("X-Forwarded-For", newIp())
      .send({ token: tokenFrom(sentTo(email)[1]!.text) })
      .expect(200);
    await login(email).expect(200);
  });

  it("does not send another email on every attempt", async () => {
    const email = await signUp();
    await login(email).expect(403);
    await login(email).expect(403);
    expect(sentTo(email)).toHaveLength(1);
  });

  it("sends nothing, and says nothing about the account, when the password is wrong", async () => {
    const email = await signUp();
    await ageTokens(email, RESEND_COOLDOWN_SECONDS + 1);

    const res = await login(email, "not the password at all").expect(401);
    expect(res.body.code).toBeUndefined();
    expect(sentTo(email)).toHaveLength(1);
  });
});
