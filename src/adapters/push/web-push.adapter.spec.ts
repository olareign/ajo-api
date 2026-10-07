import webpush from "web-push";
import { WebPushSender } from "./web-push.adapter.js";

vi.mock("web-push", () => ({ default: { sendNotification: vi.fn() } }));

const keys = webpush as unknown as { sendNotification: ReturnType<typeof vi.fn> };
const sender = new WebPushSender({
  publicKey: "P".repeat(87),
  privateKey: "S".repeat(43),
  subject: "mailto:owner@example.com",
});
const target = { endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "k", auth: "a" };
const message = {
  title: "Rent: debit missed",
  body: "Tap to open Àjọ.",
  link: "/save",
  tag: "plan",
};

afterEach(() => keys.sendNotification.mockReset());

describe("WebPushSender", () => {
  it("sends the message as JSON to the subscription with our key, a short life and no secrets in it", async () => {
    keys.sendNotification.mockResolvedValue({});
    expect(await sender.send(target, message)).toBe("sent");
    const [subscription, payload, options] = keys.sendNotification.mock.calls[0]!;
    expect(subscription).toEqual({ endpoint: target.endpoint, keys: { p256dh: "k", auth: "a" } });
    expect(JSON.parse(payload)).toEqual(message);
    expect(options).toMatchObject({
      TTL: 3600,
      vapidDetails: { subject: "mailto:owner@example.com" },
    });
  });

  it("says gone for a browser that has unsubscribed, and failed for any other trouble", async () => {
    keys.sendNotification.mockRejectedValueOnce(Object.assign(new Error("x"), { statusCode: 410 }));
    expect(await sender.send(target, message)).toBe("gone");
    keys.sendNotification.mockRejectedValueOnce(Object.assign(new Error("x"), { statusCode: 404 }));
    expect(await sender.send(target, message)).toBe("gone");
    keys.sendNotification.mockRejectedValueOnce(Object.assign(new Error("x"), { statusCode: 500 }));
    expect(await sender.send(target, message)).toBe("failed");
    keys.sendNotification.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await sender.send(target, message)).toBe("failed");
  });

  it("exposes only the public key", () => {
    expect(sender.publicKey).toBe("P".repeat(87));
    expect(JSON.stringify(sender)).not.toContain("S".repeat(43));
  });
});
