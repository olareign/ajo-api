import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import type { FakeMailer } from "../../src/adapters/mail/fake.adapter.js";
import { MAILER, type MailMessage } from "../../src/adapters/mail/mailer.port.js";
import {
  MAX_EMAIL_ATTEMPTS,
  Notifications,
} from "../../src/notifications/notifications.service.js";
import { paymentsHarness } from "../payments/support.js";
import { createTestApp } from "../support/test-app.js";

let app: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;
let notifications: Notifications;
let mailer: FakeMailer;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  t = paymentsHarness(app);
  notifications = app.get(Notifications);
  mailer = app.get<FakeMailer>(MAILER);
});
afterAll(async () => {
  await app?.close();
});

const message = (over: Partial<Parameters<Notifications["notify"]>[1]> = {}) => ({
  kind: "plan.test",
  title: "A title",
  body: "Something happened.",
  dedupeKey: `k-${randomUUID()}`,
  ...over,
});

describe("telling people things", () => {
  it("saves a message once, however many times it is sent with the same key", async () => {
    const who = await t.ready("NG", { mfa: false, kyc: false });
    const m = message();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => notifications.notify(who.id, m)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const page = (await who.call("get", "/notifications").expect(200)).body;
    expect(page.items).toHaveLength(1);
    expect(page.unread).toBe(1);
  });

  it("shows only the caller's own, newest first, a page at a time, even when they share a timestamp", async () => {
    const who = await t.ready("NG", { mfa: false, kyc: false });
    const other = await t.ready("NG", { mfa: false, kyc: false });
    await notifications.notify(other.id, message({ title: "Not yours" }));
    // One database transaction: every row gets the same created_at.
    await t.db.transaction(async (tx) => {
      for (let i = 1; i <= 5; i += 1) {
        await notifications.notify(who.id, message({ title: `Message ${i}` }), tx);
      }
    });
    const first = (await who.call("get", "/notifications?limit=2").expect(200)).body;
    expect(first.items.map((n: { title: string }) => n.title)).toEqual(["Message 5", "Message 4"]);
    const second = (
      await who.call("get", `/notifications?limit=2&before=${first.next}`).expect(200)
    ).body;
    expect(second.items.map((n: { title: string }) => n.title)).toEqual(["Message 3", "Message 2"]);
    const third = (
      await who.call("get", `/notifications?limit=2&before=${second.next}`).expect(200)
    ).body;
    expect(third.items.map((n: { title: string }) => n.title)).toEqual(["Message 1"]);
    expect(third.next).toBeNull();
    expect(first.unread).toBe(5);
  });

  it("marks one read, or all, and never someone else's", async () => {
    const who = await t.ready("NG", { mfa: false, kyc: false });
    const other = await t.ready("NG", { mfa: false, kyc: false });
    await notifications.notify(who.id, message());
    await notifications.notify(who.id, message());
    const items = (await who.call("get", "/notifications").expect(200)).body.items;
    await other.call("post", `/notifications/${items[0].id}/read`).expect(204);
    expect((await who.call("get", "/notifications").expect(200)).body.unread).toBe(2);
    await who.call("post", `/notifications/${items[0].id}/read`).expect(204);
    expect((await who.call("get", "/notifications").expect(200)).body.unread).toBe(1);
    await who.call("post", "/notifications/read-all").expect(204);
    expect((await who.call("get", "/notifications").expect(200)).body.unread).toBe(0);
    await who.call("post", "/notifications/not-a-uuid/read").expect(400);
  });
});

describe("the email queue", () => {
  it("emails only what asked to be emailed, once, even when several sweeps run at once", async () => {
    const who = await t.ready("NG", { mfa: false, kyc: false });
    const emailed = message({ email: true, title: "Your debit failed", link: "/save/abc" });
    await notifications.notify(who.id, emailed);
    await notifications.notify(who.id, message({ title: "Quiet one" }));
    await Promise.all(Array.from({ length: 5 }, () => notifications.sendQueuedEmails(5000)));
    const mine = mailer.outbox.filter(
      (m) => m.to === who.email && m.subject === "Your debit failed",
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("https://app.ajo.test/save/abc");
    expect(mailer.outbox.some((m) => m.to === who.email && m.subject === "Quiet one")).toBe(false);
    await notifications.sendQueuedEmails(5000);
    expect(
      mailer.outbox.filter((m) => m.to === who.email && m.subject === "Your debit failed"),
    ).toHaveLength(1);
  });

  it("keeps trying after a mail outage, and gives up after a few goes without losing the in-app message", async () => {
    const who = await t.ready("NG", { mfa: false, kyc: false });
    await notifications.notify(who.id, message({ email: true, title: "Flaky one" }));
    const original = mailer.send.bind(mailer);
    let down = true;
    mailer.send = async (m: MailMessage) => {
      if (down && m.to === who.email) throw new Error("mail is down");
      return original(m);
    };
    try {
      await notifications.sendQueuedEmails(5000);
      expect(mailer.outbox.some((m) => m.to === who.email && m.subject === "Flaky one")).toBe(
        false,
      );
      down = false;
      await notifications.sendQueuedEmails(5000);
      expect(mailer.outbox.some((m) => m.to === who.email && m.subject === "Flaky one")).toBe(true);

      down = true;
      await notifications.notify(who.id, message({ email: true, title: "Hopeless" }));
      for (let i = 0; i < MAX_EMAIL_ATTEMPTS + 2; i += 1) await notifications.sendQueuedEmails(5000);
      const [row] = await t.db.query(
        "SELECT email_status, email_attempts FROM notifications WHERE user_id = $1 AND title = 'Hopeless'",
        [who.id],
      );
      expect(row).toMatchObject({ email_status: "failed", email_attempts: MAX_EMAIL_ATTEMPTS });
      expect(
        (await who.call("get", "/notifications").expect(200)).body.items.map(
          (n: { title: string }) => n.title,
        ),
      ).toContain("Hopeless");
    } finally {
      mailer.send = original;
    }
  });
});
