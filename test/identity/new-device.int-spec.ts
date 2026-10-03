import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import type { FakeMailer } from "../../src/adapters/mail/fake.adapter.js";
import { MAILER } from "../../src/adapters/mail/mailer.port.js";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
let mailer: FakeMailer;

const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
  mailer = app.get(MAILER);
});
afterAll(async () => {
  await app?.close();
});

const signIn = (user: { email: string; password: string }, userAgent: string) =>
  request(app.getHttpServer())
    .post("/api/v1/auth/login")
    .set("X-Forwarded-For", newIp())
    .set("User-Agent", userAgent)
    .send(user);
const alertsFor = (email: string) =>
  mailer.outbox.filter((m) => m.to === email && m.subject === "New sign-in to your Àjọ account");
/** Mail is sent without waiting for the sign-in answer, so give it a moment to land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

describe("new-device sign-in alert", () => {
  it("stays quiet for the first device ever, and for the same device coming back, even after a browser update", async () => {
    const user = await createVerifiedUser(app);
    await signIn(user, CHROME_ANDROID).expect(200);
    await signIn(user, CHROME_ANDROID.replace("130.0.6723.58", "131.0.6778.39")).expect(200);
    await settle();
    expect(alertsFor(user.email)).toHaveLength(0);

    const devices = await db.query(
      `SELECT d.label FROM login_devices d JOIN users u ON u.id = d.user_id WHERE u.email = $1`,
      [user.email],
    );
    expect(devices).toEqual([{ label: "Chrome on Android" }]);
  });

  it("emails the owner once when a different device signs in, saying which, and how to react", async () => {
    const user = await createVerifiedUser(app);
    await signIn(user, CHROME_ANDROID).expect(200);
    await signIn(user, SAFARI_IPHONE).expect(200);
    await settle();

    const [alert, ...more] = alertsFor(user.email);
    expect(more).toHaveLength(0);
    expect(alert!.text).toContain("Safari on iPhone");
    expect(alert!.text).toMatch(/If this was you, there's nothing to do/);
    expect(alert!.text).toContain("https://app.ajo.test/forgot-password");

    // The same new device again is no longer new.
    await signIn(user, SAFARI_IPHONE).expect(200);
    await settle();
    expect(alertsFor(user.email)).toHaveLength(1);
  });

  it("does not alert for a failed sign-in, or for someone who never got past the password", async () => {
    const user = await createVerifiedUser(app);
    await signIn(user, CHROME_ANDROID).expect(200);
    await signIn({ email: user.email, password: "wrong password here" }, SAFARI_IPHONE).expect(401);
    await settle();
    expect(alertsFor(user.email)).toHaveLength(0);
    const [{ count }] = await db.query(
      `SELECT count(*)::int AS count FROM login_devices d JOIN users u ON u.id = d.user_id WHERE u.email = $1`,
      [user.email],
    );
    expect(count).toBe(1);
  });

  it("stops at five alerts a day, so a hostile mix of device names cannot flood an inbox", async () => {
    const user = await createVerifiedUser(app);
    await signIn(user, CHROME_ANDROID).expect(200);
    const others = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
      SAFARI_IPHONE,
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0",
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 OPR/110.0",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36",
    ];
    for (const ua of others) await signIn(user, ua).expect(200);
    await settle();
    expect(alertsFor(user.email)).toHaveLength(5);
    const [{ count }] = await db.query(
      `SELECT count(*)::int AS count FROM login_devices d JOIN users u ON u.id = d.user_id WHERE u.email = $1`,
      [user.email],
    );
    expect(count).toBe(8); // every device is still recorded; only the emails stop
  });

  it("is one person's business only: another account's devices do not count", async () => {
    const [a, b] = [await createVerifiedUser(app), await createVerifiedUser(app)];
    await signIn(a, CHROME_ANDROID).expect(200);
    await signIn(b, SAFARI_IPHONE).expect(200);
    await settle();
    expect(alertsFor(a.email)).toHaveLength(0);
    expect(alertsFor(b.email)).toHaveLength(0);
  });
});
