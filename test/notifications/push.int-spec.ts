import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes, randomUUID } from "node:crypto";
import { FakePushSender } from "../../src/adapters/push/fake.adapter.js";
import { PUSH_SENDER } from "../../src/adapters/push/push-sender.port.js";
import { MAX_PUSH_ATTEMPTS, Notifications } from "../../src/notifications/notifications.service.js";
import { MAX_SUBSCRIPTIONS } from "../../src/notifications/push.service.js";
import { paymentsHarness } from "../payments/support.js";
import { createTestApp } from "../support/test-app.js";

let app: NestExpressApplication;
let h: ReturnType<typeof paymentsHarness>;
let notifications: Notifications;
let sender: FakePushSender;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  h = paymentsHarness(app);
  notifications = app.get(Notifications);
  sender = app.get<FakePushSender>(PUSH_SENDER);
});
afterAll(async () => {
  await app?.close();
});

const endpoint = () => `https://fcm.googleapis.com/fcm/send/${randomBytes(12).toString("hex")}`;
const keys = () => ({
  p256dh: randomBytes(32).toString("base64url"),
  auth: randomBytes(16).toString("base64url"),
});
const message = (over: Partial<Parameters<Notifications["notify"]>[1]> = {}) => ({
  kind: "plan.debit_missed",
  title: "Rent: a debit was missed",
  body: "Your wallet doesn't have ₦5,000 for Rent.",
  link: "/save/abc",
  dedupeKey: `k-${randomUUID()}`,
  ...over,
});
type Who = Awaited<ReturnType<typeof h.ready>>;
const subscribe = (who: Who, ep = endpoint()) =>
  who.call("post", "/push/subscriptions").send({ endpoint: ep, keys: keys() });
const pushStatus = async (id: string) =>
  (await h.db.query(
    "SELECT kind, push_status, push_attempts FROM notifications WHERE user_id = $1 ORDER BY seq",
    [id],
  )) as {
    kind: string;
    push_status: string;
    push_attempts: number;
  }[];
const mine = (ep: string) => sender.sent.filter((s) => s.target.endpoint === ep);

describe("subscribing a browser", () => {
  it("says whether push is on and gives the key a browser needs", async () => {
    const me = await h.ready("NG", { mfa: false });
    const res = await me.call("get", "/push").expect(200);
    expect(res.body).toEqual({ enabled: true, publicKey: sender.publicKey, devices: 0 });
    await subscribe(me).expect(204);
    expect((await me.call("get", "/push").expect(200)).body.devices).toBe(1);
  });

  it("takes only the browsers' own push services, never an address of someone's choosing", async () => {
    const me = await h.ready("NG", { mfa: false });
    for (const bad of [
      "https://evil.example.com/push",
      "https://169.254.169.254/latest/meta-data",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/x",
    ]) {
      const res = await subscribe(me, bad).expect(400);
      expect(res.body.code).toBe("push_endpoint_invalid");
    }
    await me
      .call("post", "/push/subscriptions")
      .send({ endpoint: endpoint(), keys: { p256dh: "bad key!", auth: "x" } })
      .expect(400);
    expect((await me.call("get", "/push").expect(200)).body.devices).toBe(0);
  });

  it("is one subscription however many times the same browser asks, and moves to whoever signs in on it", async () => {
    const [ada, ben] = [await h.ready("NG", { mfa: false }), await h.ready("NG", { mfa: false })];
    const shared = endpoint();
    await subscribe(ada, shared).expect(204);
    await subscribe(ada, shared).expect(204);
    expect((await ada.call("get", "/push").expect(200)).body.devices).toBe(1);
    await subscribe(ben, shared).expect(204);
    expect((await ada.call("get", "/push").expect(200)).body.devices).toBe(0);
    expect((await ben.call("get", "/push").expect(200)).body.devices).toBe(1);
  });

  it("keeps the newest few, and lets only the owner remove one", async () => {
    const [ada, ben] = [await h.ready("NG", { mfa: false }), await h.ready("NG", { mfa: false })];
    const first = endpoint();
    await subscribe(ada, first).expect(204);
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) await subscribe(ada).expect(204);
    expect((await ada.call("get", "/push").expect(200)).body.devices).toBe(MAX_SUBSCRIPTIONS);
    const keep = endpoint();
    await subscribe(ada, keep).expect(204);
    // Someone else cannot remove it, and cannot tell whether it exists.
    await ben.call("delete", "/push/subscriptions").send({ endpoint: keep }).expect(204);
    expect((await ada.call("get", "/push").expect(200)).body.devices).toBe(MAX_SUBSCRIPTIONS);
    await ada.call("delete", "/push/subscriptions").send({ endpoint: keep }).expect(204);
    expect((await ada.call("get", "/push").expect(200)).body.devices).toBe(MAX_SUBSCRIPTIONS - 1);
  });

  it("needs a signed-in person", async () => {
    const me = await h.ready("NG", { mfa: false });
    await me.call("get", "/push").set("Authorization", "Bearer nope").expect(401);
  });
});

describe("sending pushes", () => {
  it("queues one for a person with a browser subscribed, and shows only the title on the lock screen", async () => {
    const me = await h.ready("NG", { mfa: false });
    const ep = endpoint();
    await subscribe(me, ep).expect(204);
    await notifications.notify(me.id, message());
    expect((await pushStatus(me.id)).map((r) => r.push_status)).toEqual(["pending"]);
    await notifications.sendQueuedPush();
    const [sent] = mine(ep);
    expect(sent!.message).toEqual({
      title: "Rent: a debit was missed",
      body: "Tap to open Àjọ.",
      link: "/save/abc",
      tag: "plan.debit_missed",
    });
    expect(JSON.stringify(sent!.message)).not.toContain("₦");
    expect((await pushStatus(me.id)).map((r) => r.push_status)).toEqual(["sent"]);
    // A second pass sends nothing again.
    await notifications.sendQueuedPush();
    expect(mine(ep)).toHaveLength(1);
  });

  it("queues nothing for a person with no browser, so their old messages never push later", async () => {
    const me = await h.ready("NG", { mfa: false });
    await notifications.notify(me.id, message());
    await subscribe(me).expect(204);
    expect((await pushStatus(me.id)).map((r) => r.push_status)).toEqual(["none"]);
  });

  it("honours switched-off optional messages, but money and account messages always go", async () => {
    const me = await h.ready("NG", { mfa: false });
    await subscribe(me).expect(204);
    await me
      .call("put", "/notifications/settings")
      .send({ friends: false, reminders: false })
      .expect(200);
    await notifications.notify(me.id, message({ kind: "friend.request" }));
    await notifications.notify(me.id, message({ kind: "plan.debit_soon" }));
    await notifications.notify(me.id, message({ kind: "plan.debit_missed" }));
    await notifications.notify(me.id, message({ kind: "security.password_changed" }));
    expect((await pushStatus(me.id)).map((r) => [r.kind, r.push_status])).toEqual([
      ["friend.request", "none"],
      ["plan.debit_soon", "none"],
      ["plan.debit_missed", "pending"],
      ["security.password_changed", "pending"],
    ]);
  });

  it("forgets a browser the push service says is gone, and still reaches the others", async () => {
    const me = await h.ready("NG", { mfa: false });
    const [gone, alive] = [endpoint(), endpoint()];
    await subscribe(me, gone).expect(204);
    await subscribe(me, alive).expect(204);
    sender.answers.set(gone, "gone");
    await notifications.notify(me.id, message());
    await notifications.sendQueuedPush();
    expect((await me.call("get", "/push").expect(200)).body.devices).toBe(1);
    expect(mine(alive)).toHaveLength(1);
    expect((await pushStatus(me.id)).map((r) => r.push_status)).toEqual(["sent"]);
  });

  it("tries again later when the push service has trouble, and gives up after a few tries", async () => {
    const me = await h.ready("NG", { mfa: false });
    const ep = endpoint();
    await subscribe(me, ep).expect(204);
    sender.answers.set(ep, "failed");
    await notifications.notify(me.id, message());
    for (let i = 1; i < MAX_PUSH_ATTEMPTS; i += 1) {
      await notifications.sendQueuedPush();
      const [row] = await pushStatus(me.id);
      expect([row!.push_status, row!.push_attempts]).toEqual(["pending", i]);
    }
    await notifications.sendQueuedPush();
    expect((await pushStatus(me.id))[0]).toMatchObject({
      push_status: "failed",
      push_attempts: MAX_PUSH_ATTEMPTS,
    });
    // The browser is not forgotten for a passing problem.
    expect((await me.call("get", "/push").expect(200)).body.devices).toBe(1);
    await notifications.sendQueuedPush();
    expect(mine(ep)).toHaveLength(MAX_PUSH_ATTEMPTS);
  });

  it("opens a message's own place in the app, and the message list when it has none", async () => {
    const me = await h.ready("NG", { mfa: false });
    const ep = endpoint();
    await subscribe(me, ep).expect(204);
    await notifications.notify(me.id, message({ link: "/save/abc" }));
    await notifications.notify(me.id, message({ link: undefined }));
    await notifications.sendQueuedPush();
    expect(mine(ep).map((s) => s.message.link)).toEqual(["/save/abc", "/notifications"]);
  });

  it("never points the lock screen outside the app: a full address is refused by the database, and a protocol-relative one is replaced", async () => {
    const me = await h.ready("NG", { mfa: false });
    const ep = endpoint();
    await subscribe(me, ep).expect(204);
    await expect(
      notifications.notify(me.id, message({ link: "https://evil.example.com/phish" })),
    ).rejects.toThrow(/notifications_link_check/);
    await notifications.notify(me.id, message({ link: "//evil.example.com" }));
    await notifications.sendQueuedPush();
    expect(mine(ep).map((s) => s.message.link)).toEqual(["/notifications"]);
  });

  it("a test message reaches the caller's own browsers, a few times an hour at most", async () => {
    const me = await h.ready("NG", { mfa: false });
    const ep = endpoint();
    await subscribe(me, ep).expect(204);
    await me.call("post", "/push/test").expect(204);
    await notifications.sendQueuedPush();
    expect(mine(ep).map((s) => s.message.title)).toEqual(["Notifications are on"]);
    // The limit is per address, and each call here would otherwise come from a new one.
    const again = () => me.call("post", "/push/test").set("X-Forwarded-For", "203.0.113.77");
    for (let i = 0; i < 5; i += 1) await again();
    await again().expect(429);
  });
});
