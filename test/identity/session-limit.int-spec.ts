import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import { MAX_ACTIVE_SESSIONS } from "../../src/auth/session.service.js";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
});

afterAll(async () => {
  await app?.close();
});

const login = (email: string, password: string) =>
  request(app.getHttpServer())
    .post("/api/v1/auth/login")
    .set("X-Forwarded-For", newIp())
    .send({ email, password });

describe("active sessions per person", () => {
  it("keeps only the newest ones, so repeated sign-ins cannot pile up rows", async () => {
    const { email, password } = await createVerifiedUser(app);
    const first = await login(email, password).expect(200);
    for (let i = 0; i < MAX_ACTIVE_SESSIONS; i++) await login(email, password).expect(200);

    const [{ active }] = await db.query(
      `SELECT count(*)::int AS active FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE u.email = $1 AND s.revoked_at IS NULL`,
      [email],
    );
    expect(active).toBe(MAX_ACTIVE_SESSIONS);

    const [{ ended }] = await db.query(
      `SELECT count(*)::int AS ended FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE u.email = $1 AND s.revoked_reason = 'session_limit'`,
      [email],
    );
    expect(ended).toBe(1);

    // The oldest sign-in is the one that was ended.
    await request(app.getHttpServer())
      .post("/api/v1/auth/refresh")
      .set("X-Forwarded-For", newIp())
      .send({ refreshToken: first.body.refreshToken })
      .expect(401);
  });
});
