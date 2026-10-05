import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomInt } from "node:crypto";
import request from "supertest";
import { Notifications } from "../../src/notifications/notifications.service.js";
import { codeAt, paymentsHarness } from "../payments/support.js";
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

/** A Nigerian mobile number nobody else in the shared test database has. */
const freshNumber = () => `0803${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;

describe("the profile", () => {
  it("includes the phone (none yet, not verified) and the person's standing in circles", async () => {
    const me = await h.ready("NG", { mfa: false });
    const body = (await me.call("get", "/me").expect(200)).body;
    expect(body).toMatchObject({
      phone: null,
      phoneVerified: false,
      trust: { level: "new", score: 0 },
    });
  });

  it("sets a phone read by the account's country, refuses nonsense and another account's number, and removes it", async () => {
    const [me, other] = [await h.ready("NG", { mfa: false }), await h.ready("NG", { mfa: false })];
    const local = freshNumber();
    await me
      .call("put", "/me/phone")
      .send({ phone: local.replace(/(\d{4})(\d{3})/, "$1 $2 ") })
      .expect(204);
    const set = (await me.call("get", "/me").expect(200)).body;
    expect(set.phone).toBe(`+234${local.slice(1)}`);
    expect(set.phoneVerified).toBe(false);

    const bad = await me.call("put", "/me/phone").send({ phone: "12345" }).expect(400);
    expect(bad.body.code).toBe("phone_invalid");
    const taken = await other
      .call("put", "/me/phone")
      .send({ phone: `+234${local.slice(1)}` })
      .expect(409);
    expect(taken.body.code).toBe("phone_taken");

    await me.call("delete", "/me/phone").expect(204);
    expect((await me.call("get", "/me").expect(200)).body.phone).toBeNull();
    const kinds = (await me.call("get", "/me/security/events").expect(200)).body.map(
      (e: { kind: string }) => e.kind,
    );
    expect(kinds.filter((k: string) => k === "phone_changed")).toHaveLength(2);
  });
});

describe("which emails come", () => {
  it("starts with everything on, changes only what is named, and never stops money emails", async () => {
    const me = await h.ready("NG", { mfa: false });
    expect((await me.call("get", "/notifications/settings").expect(200)).body).toEqual({
      reminders: true,
      savings: true,
      circles: true,
      friends: true,
    });
    const after = (
      await me
        .call("put", "/notifications/settings")
        .send({ friends: false, savings: false })
        .expect(200)
    ).body;
    expect(after).toEqual({ reminders: true, savings: false, circles: true, friends: false });
    await me.call("put", "/notifications/settings").send({ friends: "no" }).expect(400);

    const notifications = app.get(Notifications);
    const send = (kind: string) =>
      notifications.notify(me.id, {
        kind,
        title: "t",
        body: "b",
        dedupeKey: `${kind}-${Date.now()}`,
        email: true,
      });
    await send("friend.request");
    await send("plan.created");
    await send("plan.debit_missed");
    await send("group.invite");
    const rows = await h.db.query(
      `SELECT kind, email_status FROM notifications WHERE user_id = $1 ORDER BY created_at`,
      [me.id],
    );
    expect(
      Object.fromEntries(
        rows.map((r: { kind: string; email_status: string }) => [r.kind, r.email_status]),
      ),
    ).toEqual({
      "friend.request": "none",
      "plan.created": "none",
      "plan.debit_missed": "pending",
      "group.invite": "pending",
    });
  });
});

describe("closing the account", () => {
  const close = (who: { call: (m: "post", p: string) => request.Test }, body: object) =>
    who.call("post", "/me/security/close").send(body);

  it("refuses while there is money left, with the reason, and needs the password and code", async () => {
    const me = await h.ready("NG", { mfa: true });
    await h.giveMoney(me.id, "500000");
    const wrong = await close(me, { password: "not it" }).expect(401);
    expect(wrong.body.code).toBe("password_wrong");
    const noCode = await close(me, { password: GOOD_PASSWORD }).expect(401);
    expect(noCode.body.code).toBe("mfa_code_required");
    const blocked = await close(me, {
      password: GOOD_PASSWORD,
      code: codeAt(me.secret!, 30),
    }).expect(409);
    expect(blocked.body.code).toBe("close_blocked_money");
    await me.call("get", "/me").expect(200);
  });

  it("closes an empty account: signed out everywhere, and it can't sign in again", async () => {
    const me = await h.ready("NG", { mfa: false });
    await close(me, { password: GOOD_PASSWORD }).expect(204);
    await me.call("get", "/me").expect(401);
    const login = await request(h.http())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .send({ email: me.email, password: GOOD_PASSWORD });
    expect(login.status).toBeGreaterThanOrEqual(400);
    const [user] = await h.db.query(`SELECT status, closed_at FROM users WHERE id = $1`, [me.id]);
    expect(user.status).toBe("closed");
    expect(user.closed_at).not.toBeNull();
    const [event] = await h.db.query(
      `SELECT kind FROM security_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [me.id],
    );
    expect(event.kind).toBe("account_closed");
  });
});
