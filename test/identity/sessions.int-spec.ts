import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, GOOD_PASSWORD, newIp, uniqueEmail } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
const http = () => app.getHttpServer();

function login(email: string, password: string, ip = newIp()) {
  return request(http())
    .post("/api/v1/auth/login")
    .set("X-Forwarded-For", ip)
    .send({ email, password });
}
function me(accessToken?: string) {
  const req = request(http()).get("/api/v1/me").set("X-Forwarded-For", newIp());
  return accessToken ? req.set("Authorization", `Bearer ${accessToken}`) : req;
}
function refresh(refreshToken: string) {
  return request(http())
    .post("/api/v1/auth/refresh")
    .set("X-Forwarded-For", newIp())
    .send({ refreshToken });
}

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
});
afterAll(async () => {
  await app?.close();
});

describe("login", () => {
  it("returns an access token, a refresh token and opens a session", async () => {
    const user = await createVerifiedUser(app);
    const res = await login(user.email, user.password).expect(200);
    expect(res.body).toMatchObject({ tokenType: "Bearer", expiresIn: 900 });
    expect(res.body.accessToken).toMatch(/^ey/);
    expect(res.body.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const profile = await me(res.body.accessToken).expect(200);
    expect(profile.body).toMatchObject({
      email: user.email,
      displayName: "Test User",
      emailVerified: true,
    });
    expect(profile.body).not.toHaveProperty("passwordHash");
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const user = await createVerifiedUser(app);
    const wrong = await login(user.email, "wrong password entirely").expect(401);
    const unknown = await login(uniqueEmail(), GOOD_PASSWORD).expect(401);
    expect(wrong.body.message).toBe("Email or password is incorrect.");
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it("asks for email verification only after the right password", async () => {
    const email = uniqueEmail();
    await request(http())
      .post("/api/v1/auth/sign-up")
      .set("X-Forwarded-For", newIp())
      .send({ email, password: GOOD_PASSWORD, displayName: "Ada" })
      .expect(202);
    await login(email, "wrong password entirely").expect(401);
    const res = await login(email, GOOD_PASSWORD).expect(403);
    expect(res.body.message).toBe("Verify your email before signing in.");
  });

  it("locks the account after repeated failures, without revealing the lock", async () => {
    const user = await createVerifiedUser(app);
    for (let i = 0; i < 10; i++) await login(user.email, `wrong password ${i}xx`).expect(401);
    const locked = await login(user.email, user.password).expect(401);
    expect(locked.body.message).toBe("Email or password is incorrect.");

    await db.query("UPDATE users SET locked_until = now() - interval '1 second' WHERE email = $1", [
      user.email,
    ]);
    await login(user.email, user.password).expect(200);
    const [{ failed }] = await db.query(
      "SELECT failed_login_count AS failed FROM users WHERE email = $1",
      [user.email],
    );
    expect(failed).toBe(0);
  });

  it("limits login attempts per client", async () => {
    const ip = newIp();
    for (let i = 0; i < 10; i++) await login(uniqueEmail(), GOOD_PASSWORD, ip).expect(401);
    await login(uniqueEmail(), GOOD_PASSWORD, ip).expect(429);
  });
});

describe("authentication guard", () => {
  it("denies by default without a valid token", async () => {
    await me().expect(401);
    await me("garbage").expect(401);
    await request(http()).get("/api/v1/me").set("Authorization", "Basic abc").expect(401);
  });

  it("keeps public routes public", async () => {
    await request(http()).get("/api/v1/health/live").expect(200);
  });
});

describe("refresh tokens", () => {
  it("rotate on every use", async () => {
    const user = await createVerifiedUser(app);
    const first = (await login(user.email, user.password).expect(200)).body;
    const second = (await refresh(first.refreshToken).expect(200)).body;
    expect(second.refreshToken).not.toBe(first.refreshToken);
    await me(second.accessToken).expect(200);
  });

  it("revoke the whole session when an old token is replayed (stolen-token defence)", async () => {
    const user = await createVerifiedUser(app);
    const first = (await login(user.email, user.password).expect(200)).body;
    const second = (await refresh(first.refreshToken).expect(200)).body;

    await refresh(first.refreshToken).expect(401);
    await me(second.accessToken).expect(401);
    await refresh(second.refreshToken).expect(401);
  });

  it("expire when the session has been idle too long", async () => {
    const user = await createVerifiedUser(app);
    const tokens = (await login(user.email, user.password).expect(200)).body;
    await db.query(
      `UPDATE refresh_tokens SET expires_at = now() - interval '1 second'
        WHERE session_id IN (SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1)`,
      [user.email],
    );
    await refresh(tokens.refreshToken).expect(401);
  });

  it("reject unknown and malformed tokens", async () => {
    await refresh("A".repeat(43)).expect(401);
    await refresh("short").expect(400);
  });

  it("are stored only as hashes", async () => {
    const user = await createVerifiedUser(app);
    const tokens = (await login(user.email, user.password).expect(200)).body;
    const rows = await db.query("SELECT token_hash FROM refresh_tokens");
    expect(JSON.stringify(rows)).not.toContain(tokens.refreshToken);
  });
});

describe("logout", () => {
  it("ends the current session", async () => {
    const user = await createVerifiedUser(app);
    const tokens = (await login(user.email, user.password).expect(200)).body;
    await request(http())
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${tokens.accessToken}`)
      .expect(204);
    await me(tokens.accessToken).expect(401);
    await refresh(tokens.refreshToken).expect(401);
  });

  it("can end every session on every device", async () => {
    const user = await createVerifiedUser(app);
    const phone = (await login(user.email, user.password).expect(200)).body;
    const laptop = (await login(user.email, user.password).expect(200)).body;
    await request(http())
      .post("/api/v1/auth/logout-all")
      .set("Authorization", `Bearer ${phone.accessToken}`)
      .expect(204);
    await me(phone.accessToken).expect(401);
    await me(laptop.accessToken).expect(401);
    await refresh(laptop.refreshToken).expect(401);
  });
});
