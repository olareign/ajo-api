import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import type { FakeMailer } from "../../src/adapters/mail/fake.adapter.js";
import { MAILER } from "../../src/adapters/mail/mailer.port.js";
import { createTestApp } from "../support/test-app.js";
import { GOOD_PASSWORD, newIp, tokenFrom, uniqueEmail } from "../support/users.js";

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

async function signUp(email: string) {
  await request(app.getHttpServer())
    .post("/api/v1/auth/sign-up")
    .set("X-Forwarded-For", newIp())
    .send({ email, password: GOOD_PASSWORD, displayName: "Ada" })
    .expect(202);
}

async function verification(email: string) {
  const [row] = await db.query(
    "SELECT email_verified, email_verified_at FROM users WHERE email = $1",
    [email],
  );
  return row as { email_verified: boolean; email_verified_at: Date | null };
}

describe("users.email_verified", () => {
  it("starts false, and turns true with the timestamp when the link is used", async () => {
    const email = uniqueEmail();
    await signUp(email);
    expect(await verification(email)).toEqual({ email_verified: false, email_verified_at: null });

    await request(app.getHttpServer())
      .post("/api/v1/auth/email/verify")
      .set("X-Forwarded-For", newIp())
      .send({ token: tokenFrom(mailer.lastTo(email)!.text) })
      .expect(200);

    const after = await verification(email);
    expect(after.email_verified).toBe(true);
    expect(after.email_verified_at).not.toBeNull();
  });

  it("is set by a password reset, which proves the mailbox is theirs", async () => {
    const email = uniqueEmail();
    await signUp(email);
    await request(app.getHttpServer())
      .post("/api/v1/auth/password/forgot")
      .set("X-Forwarded-For", newIp())
      .send({ email })
      .expect(202);
    await request(app.getHttpServer())
      .post("/api/v1/auth/password/reset")
      .set("X-Forwarded-For", newIp())
      .send({
        token: tokenFrom(mailer.lastTo(email)!.text),
        password: "a different long passphrase",
      })
      .expect(200);

    const after = await verification(email);
    expect(after.email_verified).toBe(true);
    expect(after.email_verified_at).not.toBeNull();
  });

  it("cannot say verified without a verification time, nor the reverse", async () => {
    const email = uniqueEmail();
    await signUp(email);

    await expect(
      db.query("UPDATE users SET email_verified = true WHERE email = $1", [email]),
    ).rejects.toThrow(/users_email_verified_matches_timestamp/);

    await db.query("UPDATE users SET email_verified_at = now() WHERE email = $1", [email]);
    await expect(
      db.query("UPDATE users SET email_verified = false WHERE email = $1", [email]),
    ).rejects.toThrow(/users_email_verified_matches_timestamp/);
  });

  it("follows the timestamp when only the timestamp is written (code deployed before this column)", async () => {
    const email = uniqueEmail();
    await signUp(email);
    await db.query("UPDATE users SET email_verified_at = now() WHERE email = $1", [email]);
    expect((await verification(email)).email_verified).toBe(true);
  });

  it("only lets a verified account sign in", async () => {
    const email = uniqueEmail();
    await signUp(email);
    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .send({ email, password: GOOD_PASSWORD })
      .expect(403);
  });
});
