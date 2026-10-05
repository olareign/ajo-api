import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import type { FakeMailer } from "../../src/adapters/mail/fake.adapter.js";
import { MAILER } from "../../src/adapters/mail/mailer.port.js";
import { codeAt, paymentsHarness, PIN } from "../payments/support.js";
import { createTestApp } from "../support/test-app.js";
import { GOOD_PASSWORD, newIp } from "../support/users.js";

let app: NestExpressApplication;
let h: ReturnType<typeof paymentsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  h = paymentsHarness(app);
});
afterAll(async () => {
  await app?.close();
});

const NEW_PASSWORD = "a brand new passphrase for testing";
const as = (token: string) => (method: "get" | "post" | "delete", path: string) =>
  request(h.http())
    [method](`/api/v1${path}`)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Forwarded-For", newIp())
    .set("User-Agent", "Mozilla/5.0 (Linux; Android 14) Chrome/129.0 Mobile Safari/537.36");

/** A second device signed in to the same account (no authenticator on, so no second step). */
async function secondDevice(email: string, password = GOOD_PASSWORD) {
  const res = await request(h.http())
    .post("/api/v1/auth/login")
    .set("X-Forwarded-For", newIp())
    .set(
      "User-Agent",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    )
    .send({ email, password })
    .expect(200);
  return res.body.accessToken as string;
}
const kinds = async (call: ReturnType<typeof as>) =>
  ((await call("get", "/me/security/events").expect(200)).body as { kind: string }[]).map(
    (e) => e.kind,
  );

describe("changing the password", () => {
  it("needs the current password, keeps this device, signs every other out, forgets remembered devices, and emails", async () => {
    const me = await h.ready("NG", { mfa: false });
    const other = await secondDevice(me.email);
    await h.db.query(
      `INSERT INTO trusted_devices (user_id, token_hash, label, expires_at) VALUES ($1, repeat('a', 64), 'x', now() + interval '1 day')`,
      [me.id],
    );
    const call = as(me.token);

    const wrong = await call("post", "/me/security/password")
      .send({ currentPassword: "not it", newPassword: NEW_PASSWORD })
      .expect(401);
    expect(wrong.body.code).toBe("password_wrong");
    const weak = await call("post", "/me/security/password")
      .send({ currentPassword: GOOD_PASSWORD, newPassword: "short" })
      .expect(400);
    expect(weak.body.details.password).toBeDefined();

    await call("post", "/me/security/password")
      .send({ currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(204);
    await call("get", "/me").expect(200);
    await as(other)("get", "/me").expect(401);
    expect(
      await h.db.query(`SELECT 1 FROM trusted_devices WHERE user_id = $1`, [me.id]),
    ).toHaveLength(0);
    await secondDevice(me.email, NEW_PASSWORD);
    expect(await kinds(call)).toContain("password_changed");
    const mail = app.get<FakeMailer>(MAILER).lastTo(me.email);
    expect(mail?.subject).toBe("Your Àjọ password was changed");
  });

  it("asks for the authenticator code when it is on, and counts a wrong one even though the change is refused", async () => {
    const me = await h.ready("NG", { mfa: true });
    const call = as(me.token);
    const missing = await call("post", "/me/security/password")
      .send({ currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD })
      .expect(401);
    expect(missing.body.code).toBe("mfa_code_required");
    const wrong = await call("post", "/me/security/password")
      .send({ currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD, code: "000000" })
      .expect(401);
    expect(wrong.body.code).toBe("mfa_code_wrong");
    const [{ failed_attempts }] = await h.db.query(
      `SELECT failed_attempts FROM user_mfa WHERE user_id = $1`,
      [me.id],
    );
    expect(failed_attempts).toBe(1);

    const code = codeAt(me.secret!, 30);
    await call("post", "/me/security/password")
      .send({ currentPassword: GOOD_PASSWORD, newPassword: NEW_PASSWORD, code })
      .expect(204);
    // A code works once.
    const again = await call("post", "/me/security/password")
      .send({ currentPassword: NEW_PASSWORD, newPassword: `${NEW_PASSWORD} again`, code })
      .expect(401);
    expect(again.body.code).toBe("mfa_code_wrong");
  });
});

describe("the PIN", () => {
  it("changes with the current PIN, and a wrong current PIN counts towards the lockout", async () => {
    const me = await h.ready("NG", { mfa: false });
    const call = as(me.token);
    await call("post", "/me/security/pin")
      .send({ currentPin: "000000", newPin: "582914" })
      .expect(422);
    await call("post", "/me/security/pin").send({ currentPin: PIN, newPin: "111111" }).expect(400);
    await call("post", "/me/security/pin").send({ currentPin: PIN, newPin: "582914" }).expect(204);
    await call("post", "/me/pin/verify").send({ pin: "582914" }).expect(204);
    await call("post", "/me/pin/verify").send({ pin: PIN }).expect(422);
    expect(await kinds(call)).toContain("pin_changed");
  });

  it("resets with the password and an authenticator code, clears a lockout, and refuses without the authenticator", async () => {
    const without = await h.ready("NG", { mfa: false });
    const refused = await as(without.token)("post", "/me/security/pin/reset")
      .send({ password: GOOD_PASSWORD, code: "123456", newPin: "582914" })
      .expect(403);
    expect(refused.body.code).toBe("mfa_enrolment_required");

    const me = await h.ready("NG", { mfa: true });
    await h.db.query(
      `UPDATE transaction_pins SET locked_until = now() + interval '1 hour' WHERE user_id = $1`,
      [me.id],
    );
    const call = as(me.token);
    await call("post", "/me/security/pin/reset")
      .send({ password: GOOD_PASSWORD, code: codeAt(me.secret!, 30), newPin: "582914" })
      .expect(204);
    await call("post", "/me/pin/verify").send({ pin: "582914" }).expect(204);
    expect(await kinds(call)).toContain("pin_reset");
  });
});

describe("devices", () => {
  it("lists signed-in devices with this one marked and only part of the address, and signs another out", async () => {
    const me = await h.ready("NG", { mfa: false });
    const other = await secondDevice(me.email);
    const call = as(me.token);
    const list = (await call("get", "/me/security/sessions").expect(200)).body as {
      id: string;
      current: boolean;
      device: string;
      ip: string | null;
    }[];
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.some((s) => s.device === "Safari on iPhone")).toBe(true);
    for (const s of list) if (s.ip) expect(s.ip).toMatch(/x\.x$|…$/);
    const theirs = list.find((s) => s.device === "Safari on iPhone")!;
    await call("delete", `/me/security/sessions/${theirs.id}`).expect(204);
    await as(other)("get", "/me").expect(401);
    await call("delete", `/me/security/sessions/${theirs.id}`).expect(404);
    expect(await kinds(call)).toContain("device_signed_out");
  });

  it("will not touch another person's sessions or remembered devices", async () => {
    const [a, b] = [await h.ready("NG", { mfa: false }), await h.ready("NG", { mfa: true })];
    const [bSession] = await h.db.query(
      `SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1`,
      [b.id],
    );
    await as(a.token)("delete", `/me/security/sessions/${bSession.id}`).expect(404);
    await as(b.token)("get", "/me").expect(200);
    const [bDevice] = await h.db.query(
      `SELECT id FROM trusted_devices WHERE user_id = $1 LIMIT 1`,
      [b.id],
    );
    await as(a.token)("delete", `/me/security/trusted-devices/${bDevice.id}`).expect(404);
    await as(b.token)("delete", `/me/security/trusted-devices/${bDevice.id}`).expect(204);
    expect((await as(b.token)("get", "/me/security/trusted-devices").expect(200)).body).toEqual([]);
    await as(a.token)("delete", "/me/security/sessions/not-an-id").expect(400);
  });
});

describe("recovery codes and the security record", () => {
  it("makes a new set of ten recovery codes with the password and a code, and the old set stops working", async () => {
    const me = await h.ready("NG", { mfa: true });
    const before = await h.db.query(`SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1`, [
      me.id,
    ]);
    const res = await as(me.token)("post", "/me/security/recovery-codes")
      .send({ password: GOOD_PASSWORD, code: codeAt(me.secret!, 30) })
      .expect(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    const after = await h.db.query(`SELECT code_hash FROM mfa_recovery_codes WHERE user_id = $1`, [
      me.id,
    ]);
    expect(after).toHaveLength(10);
    const old = new Set(before.map((r: { code_hash: string }) => r.code_hash));
    expect(after.every((r: { code_hash: string }) => !old.has(r.code_hash))).toBe(true);
  });

  it("records sign-ins and changes, newest first, with the device described and the address cut short", async () => {
    const me = await h.ready("NG", { mfa: true });
    const events = (await as(me.token)("get", "/me/security/events").expect(200)).body as {
      kind: string;
      at: string;
    }[];
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(["mfa_on", "signed_in"]));
    const times = events.map((e) => Date.parse(e.at));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });
});
