import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { LOCK_MINUTES, MAX_FAILED } from "../../src/admin/admin-auth.service.js";
import { codeAt } from "../payments/support.js";
import { createTestApp } from "../support/test-app.js";
import { newIp } from "../support/users.js";
import { ADMIN_PASSWORD, adminHarness } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof adminHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  h = adminHarness(app);
});
afterAll(async () => {
  await app?.close();
});

/** An answer without the per-request id, to compare what was said. */
const said = (body: Record<string, unknown>) => ({ ...body, requestId: undefined });
const login = (email: string, password: string, code: string) =>
  h.api("post", "/auth/login").send({ email, password, code });

describe("joining the team", () => {
  const invite = async (role: "owner" | "support" = "support") => {
    const email = `join-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@ajo.test`;
    const made = await h.auth.invite(
      { id: null, email: "test", role: "owner", ip: undefined },
      { email, name: "New Member", role },
    );
    return { email, ...made };
  };

  it("takes a password and an authenticator app, then signs the member in", async () => {
    const { email, setupCode } = await invite();
    const started = await h
      .api("post", "/auth/setup/start")
      .send({ email, setupCode, password: ADMIN_PASSWORD })
      .expect(200);
    expect(started.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    // Nothing works until the app has proved itself.
    await login(email, ADMIN_PASSWORD, codeAt(started.body.secret)).expect(401);
    const joined = await h
      .api("post", "/auth/setup/confirm")
      .send({ email, setupCode, code: codeAt(started.body.secret) })
      .expect(200);
    expect(joined.body.token).toHaveLength(43);
    expect(joined.body.admin).toMatchObject({ email, role: "support" });
    const me = await h.api("get", "/me", joined.body.token).expect(200);
    expect(me.body.permissions).toContain("users:read");
    expect(me.body.permissions).not.toContain("kyc:decide");
    // The setup code is spent.
    await h
      .api("post", "/auth/setup/start")
      .send({ email, setupCode, password: ADMIN_PASSWORD })
      .expect(401);
  });

  it("refuses a weak or breached password, a wrong code, and says the same thing for each way the setup code is wrong", async () => {
    const { email, setupCode } = await invite();
    const weak = await h
      .api("post", "/auth/setup/start")
      .send({ email, setupCode, password: "short" })
      .expect(400);
    expect(weak.body.code).toBe("admin_password_weak");
    await h
      .api("post", "/auth/setup/start")
      .send({ email, setupCode, password: "twelve chars!" })
      .expect(400);
    const wrong = await h
      .api("post", "/auth/setup/start")
      .send({ email, setupCode: "AAAAA-AAAAA-AAAAA-AAAAA", password: ADMIN_PASSWORD })
      .expect(401);
    const nobody = await h
      .api("post", "/auth/setup/start")
      .send({ email: "nobody@ajo.test", setupCode, password: ADMIN_PASSWORD })
      .expect(401);
    expect(said(wrong.body)).toEqual(said(nobody.body));
  });

  it("cancels the setup code after ten wrong tries, so it cannot be guessed", async () => {
    const { email, setupCode } = await invite();
    for (let i = 0; i < 10; i += 1) {
      await h
        .api("post", "/auth/setup/start")
        .send({ email, setupCode: `ZZZZZ-ZZZZZ-ZZZZZ-ZZZ${i}Z`, password: ADMIN_PASSWORD })
        .expect(401);
    }
    // Even the right one is dead now.
    await h
      .api("post", "/auth/setup/start")
      .send({ email, setupCode, password: ADMIN_PASSWORD })
      .expect(401);
  });

  it("lets a setup code expire", async () => {
    const { email, setupCode } = await invite();
    await h.t.db.query(
      "UPDATE admin_users SET setup_expires_at = now() - interval '1 minute' WHERE email = $1",
      [email],
    );
    await h
      .api("post", "/auth/setup/start")
      .send({ email, setupCode, password: ADMIN_PASSWORD })
      .expect(401);
  });
});

describe("signing in", () => {
  it("needs the password and a current code together, and gives a session", async () => {
    const m = await h.member("support");
    const res = await login(m.email, ADMIN_PASSWORD, await m.code()).expect(200);
    expect(res.body.admin.role).toBe("support");
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("says the same thing for a wrong password, a wrong code and an unknown address", async () => {
    const m = await h.member();
    const wrongPassword = await login(m.email, "not the password at all", await m.code()).expect(
      401,
    );
    const wrongCode = await login(m.email, ADMIN_PASSWORD, "000000").expect(401);
    const unknown = await login("nobody@ajo.test", ADMIN_PASSWORD, "123456").expect(401);
    expect(said(wrongPassword.body)).toEqual(said(wrongCode.body));
    expect(said(wrongCode.body)).toEqual(said(unknown.body));
  });

  it("refuses a code that was already used, so one that was seen cannot be replayed", async () => {
    const m = await h.member();
    const code = await m.code();
    await login(m.email, ADMIN_PASSWORD, code).expect(200);
    await login(m.email, ADMIN_PASSWORD, code).expect(401);
  });

  it("locks the member out for a while after a few misses, even for the right details", async () => {
    const m = await h.member();
    for (let i = 0; i < MAX_FAILED; i += 1)
      await login(m.email, "wrong wrong wrong wrong", "000000").expect(401);
    await login(m.email, ADMIN_PASSWORD, await m.code()).expect(401);
    const [row] = await h.t.db.query(
      "SELECT locked_until > now() AS locked FROM admin_users WHERE id = $1",
      [m.id],
    );
    expect(row.locked).toBe(true);
    await h.t.db.query(
      "UPDATE admin_users SET locked_until = now() - interval '1 second' WHERE id = $1",
      [m.id],
    );
    await login(m.email, ADMIN_PASSWORD, await m.code()).expect(200);
    expect(LOCK_MINUTES).toBeGreaterThan(0);
  });

  it("keeps a record of every attempt, with who tried and how it went, and never the password", async () => {
    const m = await h.member();
    await login(m.email, "wrong wrong wrong wrong", "000000").expect(401);
    await login(m.email, ADMIN_PASSWORD, await m.code()).expect(200);
    const rows = await h.audit("WHERE admin_email = $1 AND action = 'login'", [m.email]);
    expect(rows.map((r) => r.outcome)).toEqual(["failed", "ok"]);
    expect(JSON.stringify(rows)).not.toContain(ADMIN_PASSWORD);
  });

  it("makes a customer's token useless here, and a staff token useless for customers", async () => {
    const customer = await h.t.ready("NG", { mfa: false });
    await h.api("get", "/me", customer.token).expect(401);
    await h.api("get", "/overview", customer.token).expect(401);
    const m = await h.member();
    await request(h.t.http())
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${m.token}`)
      .expect(401);
    await request(h.t.http())
      .get("/api/v1/wallet")
      .set("Authorization", `Bearer ${m.token}`)
      .expect(401);
    await h.api("get", "/me").expect(401);
    await h.api("get", "/me", "x".repeat(43)).expect(401);
  });

  it("ends a session at logout, when idle too long, past eight hours, or when the member is turned off", async () => {
    const m = await h.member();
    await h.api("get", "/me", m.token).expect(200);
    await h.t.db.query(
      "UPDATE admin_sessions SET last_seen_at = now() - interval '31 minutes' WHERE admin_id = $1",
      [m.id],
    );
    await h.api("get", "/me", m.token).expect(401);

    const long = await h.member();
    await h.t.db.query(
      "UPDATE admin_sessions SET expires_at = now() - interval '1 second' WHERE admin_id = $1",
      [long.id],
    );
    await h.api("get", "/me", long.token).expect(401);

    const out = await h.member();
    await h.api("post", "/auth/logout", out.token).expect(204);
    await h.api("get", "/me", out.token).expect(401);

    const off = await h.member();
    await h.t.db.query("UPDATE admin_users SET status = 'disabled' WHERE id = $1", [off.id]);
    await h.api("get", "/me", off.token).expect(401);
  });

  it("keeps three sessions at most, ending the oldest", async () => {
    const m = await h.member();
    const tokens = [m.token];
    for (let i = 0; i < 3; i += 1) {
      tokens.push((await login(m.email, ADMIN_PASSWORD, await m.code()).expect(200)).body.token);
    }
    await h.api("get", "/me", tokens[0]).expect(401);
    for (const token of tokens.slice(1)) await h.api("get", "/me", token).expect(200);
  });

  it("limits attempts from one address", async () => {
    const ip = newIp();
    const attempt = () =>
      request(h.t.http())
        .post("/api/v1/admin/auth/login")
        .set("X-Forwarded-For", ip)
        .send({ email: "a@ajo.test", password: "x".repeat(15), code: "123456" });
    for (let i = 0; i < 8; i += 1) await attempt().expect(401);
    await attempt().expect(429);
  });
});
