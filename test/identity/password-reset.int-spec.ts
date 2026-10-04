import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import type { FakeMailer } from "../../src/adapters/mail/fake.adapter.js";
import { MAILER } from "../../src/adapters/mail/mailer.port.js";
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
const http = () => app.getHttpServer();
const NEW_PASSWORD = "Lagos-Mango-Drum-4721-Tide";

const forgot = (email: string) =>
  request(http())
    .post("/api/v1/auth/password/forgot")
    .set("X-Forwarded-For", newIp())
    .send({ email });
const reset = (token: string, password: string) =>
  request(http())
    .post("/api/v1/auth/password/reset")
    .set("X-Forwarded-For", newIp())
    .send({ token, password });
const login = (email: string, password: string) =>
  request(http())
    .post("/api/v1/auth/login")
    .set("X-Forwarded-For", newIp())
    .send({ email, password });
const refresh = (refreshToken: string) =>
  request(http())
    .post("/api/v1/auth/refresh")
    .set("X-Forwarded-For", newIp())
    .send({ refreshToken });

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
  mailer = app.get(MAILER);
});
afterAll(async () => {
  await app?.close();
});

/** Pretends the last request was a few minutes ago, which is how long the per-address cooldown is. */
async function waitOutCooldown(email: string, minutes = 5) {
  await db.query(
    `UPDATE password_reset_tokens SET created_at = created_at - make_interval(mins => $2)
      WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
    [email, minutes],
  );
}

async function requestLink(email: string): Promise<string> {
  await forgot(email).expect(202);
  return tokenFrom(mailer.lastTo(email)!.text);
}

describe("POST /auth/password/forgot", () => {
  it("emails a reset link to a registered address and stores only a hash of the token", async () => {
    const { email } = await createVerifiedUser(app);
    const res = await forgot(email).expect(202);
    expect(res.body).toEqual({
      message: "If that email has an account, we've sent a link to reset the password.",
    });

    const sent = mailer.lastTo(email)!;
    expect(sent.subject).toBe("Reset your Àjọ password");
    expect(sent.text).toContain("https://app.ajo.test/reset-password?token=");
    const token = tokenFrom(sent.text);
    const rows = await db.query(
      "SELECT token_hash FROM password_reset_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1",
      [email],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toContain(token);
  });

  it("answers an unknown address exactly the same way and sends nothing", async () => {
    const email = uniqueEmail();
    const res = await forgot(email).expect(202);
    expect(res.body).toEqual({
      message: "If that email has an account, we've sent a link to reset the password.",
    });
    expect(mailer.lastTo(email)).toBeUndefined();
  });

  it("rejects something that is not an email address", async () => {
    await forgot("not-an-email").expect(400);
  });

  it("makes an earlier link stop working when a newer one is requested", async () => {
    const { email } = await createVerifiedUser(app);
    const first = await requestLink(email);
    mailer.outbox.length = 0;
    await waitOutCooldown(email);
    const second = await requestLink(email);
    expect(second).not.toBe(first);
    await reset(first, NEW_PASSWORD).expect(400);
    await reset(second, NEW_PASSWORD).expect(200);
  });
});

describe("POST /auth/password/reset", () => {
  it("sets the new password, which works, while the old one no longer does", async () => {
    const { email, password } = await createVerifiedUser(app);
    const token = await requestLink(email);
    const res = await reset(token, NEW_PASSWORD).expect(200);
    expect(res.body).toEqual({
      message: "Your password has been changed. Sign in with the new one.",
    });
    await login(email, NEW_PASSWORD).expect(200);
    await login(email, password).expect(401);
    expect(mailer.lastTo(email)?.subject).toBe("Your Àjọ password was changed");
    const [user] = await db.query("SELECT password_hash FROM users WHERE email = $1", [email]);
    expect(user.password_hash).toMatch(/^\$argon2id\$/);
  });

  it("can be used once only", async () => {
    const { email } = await createVerifiedUser(app);
    const token = await requestLink(email);
    await reset(token, NEW_PASSWORD).expect(200);
    const again = await reset(token, "Another-Long-Phrase-882-Reed").expect(400);
    expect(again.body.message).toBe("This link is invalid or has expired.");
  });

  it("signs the person out everywhere, so a thief holding a session loses it", async () => {
    const { email, password } = await createVerifiedUser(app);
    const { refreshToken } = (await login(email, password).expect(200)).body;
    const token = await requestLink(email);
    await reset(token, NEW_PASSWORD).expect(200);
    await refresh(refreshToken).expect(401);
    const rows = await db.query(
      "SELECT revoked_reason FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1",
      [email],
    );
    expect(rows.map((r: { revoked_reason: string }) => r.revoked_reason)).toEqual([
      "password_reset",
    ]);
  });

  it("clears a lockout, since the person has proved they own the mailbox", async () => {
    const { email } = await createVerifiedUser(app);
    await db.query(
      "UPDATE users SET failed_login_count = 10, locked_until = now() + interval '15 minutes' WHERE email = $1",
      [email],
    );
    const token = await requestLink(email);
    await reset(token, NEW_PASSWORD).expect(200);
    await login(email, NEW_PASSWORD).expect(200);
  });

  it("confirms the email address, because following the link proves it is theirs", async () => {
    const email = uniqueEmail();
    await request(http())
      .post("/api/v1/auth/sign-up")
      .set("X-Forwarded-For", newIp())
      .send({ email, password: GOOD_PASSWORD, displayName: "Ada" })
      .expect(202);
    const token = await requestLink(email);
    await reset(token, NEW_PASSWORD).expect(200);
    const [user] = await db.query("SELECT email_verified_at FROM users WHERE email = $1", [email]);
    expect(user.email_verified_at).not.toBeNull();
  });

  it("refuses an unknown or expired link with the same message", async () => {
    const { email } = await createVerifiedUser(app);
    const token = await requestLink(email);
    await db.query("UPDATE password_reset_tokens SET expires_at = now() - interval '1 second'");
    expect((await reset(token, NEW_PASSWORD).expect(400)).body.message).toBe(
      "This link is invalid or has expired.",
    );
    expect((await reset("x".repeat(43), NEW_PASSWORD).expect(400)).body.message).toBe(
      "This link is invalid or has expired.",
    );
  });

  it("holds the new password to the same rules as sign-up, without using up the link", async () => {
    const { email } = await createVerifiedUser(app);
    const token = await requestLink(email);
    await reset(token, "short").expect(400);
    await reset(token, `${email}-extra`).expect(400);
    await reset(token, "password123456").expect(400);
    await reset(token, NEW_PASSWORD).expect(200);
  });
});

describe("one inbox cannot be flooded", () => {
  const same = {
    message: "If that email has an account, we've sent a link to reset the password.",
  };

  it("sends one link a minute to an address, and answers every request the same way", async () => {
    const { email } = await createVerifiedUser(app);
    const first = await requestLink(email);
    mailer.outbox.length = 0;

    const again = await forgot(email).expect(202);
    expect(again.body).toEqual(same);
    expect(mailer.lastTo(email)).toBeUndefined();
    // The link already sent keeps working: a refused request cancels nothing.
    await reset(first, NEW_PASSWORD).expect(200);
  });

  it("sends again once the minute has passed", async () => {
    const { email } = await createVerifiedUser(app);
    await requestLink(email);
    mailer.outbox.length = 0;
    await waitOutCooldown(email, 2);
    await forgot(email).expect(202);
    expect(mailer.lastTo(email)).toBeDefined();
  });

  it("stops at ten a day, and starts again after a day", async () => {
    const { email } = await createVerifiedUser(app);
    for (let i = 0; i < 10; i++) {
      await requestLink(email);
      await waitOutCooldown(email, 2);
    }
    mailer.outbox.length = 0;
    const res = await forgot(email).expect(202);
    expect(res.body).toEqual(same);
    expect(mailer.lastTo(email)).toBeUndefined();

    await db.query(
      `UPDATE password_reset_tokens SET created_at = now() - interval '25 hours'
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [email],
    );
    await forgot(email).expect(202);
    expect(mailer.lastTo(email)).toBeDefined();
  });

  it("lets only one of several simultaneous requests through", async () => {
    const { email } = await createVerifiedUser(app);
    await Promise.all(Array.from({ length: 4 }, () => forgot(email).expect(202)));
    const sent = mailer.outbox.filter(
      (m) => m.to === email && m.subject === "Reset your Àjọ password",
    );
    expect(sent).toHaveLength(1);
  });

  it("does not make an unknown address look different", async () => {
    const res = await forgot(uniqueEmail()).expect(202);
    expect(res.body).toEqual(same);
  });
});
