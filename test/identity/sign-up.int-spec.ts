import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import { MAILER } from "../../src/adapters/mail/mailer.port.js";
import type { FakeMailer } from "../../src/adapters/mail/fake.adapter.js";
import { createTestApp } from "../support/test-app.js";
import { GOOD_PASSWORD, newIp, tokenFrom, uniqueEmail } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
let mailer: FakeMailer;
const goodPassword = GOOD_PASSWORD;

function signUp(body: Record<string, unknown>, ip = newIp()) {
  return request(app.getHttpServer())
    .post("/api/v1/auth/sign-up")
    .set("X-Forwarded-For", ip)
    .send(body);
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
  mailer = app.get(MAILER);
});

afterAll(async () => {
  await app?.close();
});

describe("POST /auth/sign-up", () => {
  it("creates an unverified account and emails a verification link", async () => {
    const email = uniqueEmail();
    const res = await signUp({ email, password: goodPassword, displayName: "Ada" }).expect(202);
    expect(res.body).toEqual({ message: "Check your email to continue." });

    const [user] = await db.query(
      "SELECT email, display_name, password_hash, email_verified_at FROM users WHERE email = $1",
      [email],
    );
    expect(user).toMatchObject({ email, display_name: "Ada", email_verified_at: null });
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
    expect(user.password_hash).not.toContain(goodPassword);

    const sent = mailer.lastTo(email);
    expect(sent?.subject).toBe("Verify your email for Àjọ");
    expect(sent?.text).toContain("https://app.ajo.test/verify-email?token=");
  });

  it("treats emails case-insensitively", async () => {
    const email = uniqueEmail();
    await signUp({ email, password: goodPassword, displayName: "Ada" }).expect(202);
    await signUp({ email: email.toUpperCase(), password: goodPassword, displayName: "Ada" }).expect(
      202,
    );
    const [{ count }] = await db.query(
      "SELECT count(*)::int AS count FROM users WHERE email = $1",
      [email],
    );
    expect(count).toBe(1);
  });

  it("never reveals whether an email is registered, and warns the real owner instead", async () => {
    const email = uniqueEmail();
    const first = await signUp({ email, password: goodPassword, displayName: "Ada" }).expect(202);
    const second = await signUp({ email, password: goodPassword, displayName: "Mallory" }).expect(
      202,
    );

    expect(second.body).toEqual(first.body);
    expect(mailer.lastTo(email)?.subject).toBe(
      "Someone tried to create an Àjọ account with your email",
    );
    const [{ name }] = await db.query("SELECT display_name AS name FROM users WHERE email = $1", [
      email,
    ]);
    expect(name).toBe("Ada");
  });

  it("rejects weak and breached passwords with a reason the form can show", async () => {
    const short = await signUp({
      email: uniqueEmail(),
      password: "short",
      displayName: "Ada",
    }).expect(400);
    expect(short.body.details).toEqual({ password: ["too_short"] });

    const breached = await signUp({
      email: uniqueEmail(),
      password: "password123456",
      displayName: "Ada",
    }).expect(400);
    expect(breached.body.details).toEqual({ password: ["breached"] });
  });

  it("validates the request and rejects unexpected fields", async () => {
    await signUp({ email: "not-an-email", password: goodPassword, displayName: "Ada" }).expect(400);
    await signUp({ email: uniqueEmail(), password: goodPassword, displayName: "" }).expect(400);
    await signUp({
      email: uniqueEmail(),
      password: goodPassword,
      displayName: "Ada",
      emailVerifiedAt: "2026-01-01",
    }).expect(400);
  });

  it("limits sign-up attempts per client", async () => {
    const ip = newIp();
    for (let i = 0; i < 5; i++) {
      await signUp({ email: uniqueEmail(), password: goodPassword, displayName: "Ada" }, ip).expect(
        202,
      );
    }
    await signUp({ email: uniqueEmail(), password: goodPassword, displayName: "Ada" }, ip).expect(
      429,
    );
  });
});

describe("POST /auth/email/verify", () => {
  function verify(token: string) {
    return request(app.getHttpServer())
      .post("/api/v1/auth/email/verify")
      .set("X-Forwarded-For", newIp())
      .send({ token });
  }

  it("verifies the email with the link's token, once", async () => {
    const email = uniqueEmail();
    await signUp({ email, password: goodPassword, displayName: "Ada" }).expect(202);
    const token = tokenFrom(mailer.lastTo(email)!.text);

    await verify(token).expect(200, { verified: true });
    const [user] = await db.query("SELECT email_verified_at FROM users WHERE email = $1", [email]);
    expect(user.email_verified_at).not.toBeNull();

    const reused = await verify(token).expect(400);
    expect(reused.body.message).toBe("This link is invalid or has expired.");
  });

  it("rejects an expired token", async () => {
    const email = uniqueEmail();
    await signUp({ email, password: goodPassword, displayName: "Ada" }).expect(202);
    const token = tokenFrom(mailer.lastTo(email)!.text);
    await db.query(
      `UPDATE email_verification_tokens SET expires_at = now() - interval '1 minute'
       WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [email],
    );
    await verify(token).expect(400);
  });

  it("rejects unknown and malformed tokens the same way", async () => {
    const unknown = await verify("A".repeat(43)).expect(400);
    expect(unknown.body.message).toBe("This link is invalid or has expired.");
    await verify("not a token").expect(400);
  });

  it("stores only token hashes, never the token itself", async () => {
    const email = uniqueEmail();
    await signUp({ email, password: goodPassword, displayName: "Ada" }).expect(202);
    const token = tokenFrom(mailer.lastTo(email)!.text);
    const rows = await db.query("SELECT token_hash FROM email_verification_tokens");
    expect(JSON.stringify(rows)).not.toContain(token);
  });
});
