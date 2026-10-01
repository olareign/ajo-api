import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { FakeMailer } from "../../src/adapters/mail/fake.adapter.js";
import { MAILER } from "../../src/adapters/mail/mailer.port.js";

// Random start per test file: files share one Redis, so their client IPs must not collide.
let ipCounter = Math.floor(Math.random() * 2 ** 22);
/** A fresh client IP per call keeps per-IP rate limits from leaking between tests. */
export const newIp = () =>
  `10.${(ipCounter >> 16) & 255}.${(++ipCounter >> 8) & 255}.${ipCounter & 255}`;
export const uniqueEmail = () => `user-${randomUUID().slice(0, 8)}@example.com`;
export const GOOD_PASSWORD = "correct horse battery staple";

export function tokenFrom(text: string): string {
  const match = /token=([A-Za-z0-9_-]+)/.exec(text);
  if (!match) throw new Error("no token in email");
  return match[1]!;
}

/** Signs up and verifies a user through the public API. */
export async function createVerifiedUser(app: NestExpressApplication, email = uniqueEmail()) {
  const http = app.getHttpServer();
  await request(http)
    .post("/api/v1/auth/sign-up")
    .set("X-Forwarded-For", newIp())
    .send({ email, password: GOOD_PASSWORD, displayName: "Test User" })
    .expect(202);
  const mailer = app.get<FakeMailer>(MAILER);
  await request(http)
    .post("/api/v1/auth/email/verify")
    .set("X-Forwarded-For", newIp())
    .send({ token: tokenFrom(mailer.lastTo(email)!.text) })
    .expect(200);
  return { email, password: GOOD_PASSWORD };
}
