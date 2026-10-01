import { FakeMailer } from "./fake.adapter.js";

describe("FakeMailer", () => {
  it("keeps sent messages in an outbox for tests and local development", async () => {
    const mailer = new FakeMailer();
    await mailer.send({ to: "a@b.co", subject: "Hi", text: "t", html: "h", idempotencyKey: "k" });
    expect(mailer.outbox).toHaveLength(1);
    expect(mailer.lastTo("a@b.co")?.subject).toBe("Hi");
    expect(mailer.lastTo("nobody@b.co")).toBeUndefined();
  });

  it("does not send the same idempotency key twice", async () => {
    const mailer = new FakeMailer();
    const msg = { to: "a@b.co", subject: "Hi", text: "t", html: "h", idempotencyKey: "k" };
    await mailer.send(msg);
    await mailer.send(msg);
    expect(mailer.outbox).toHaveLength(1);
  });
});
