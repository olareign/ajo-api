import { ResendMailer } from "./resend.adapter.js";

const settings = {
  apiKey: "re_test_key",
  from: "Àjo <noreply@ajo.example>",
};

const message = {
  to: "ada@example.com",
  subject: "Verify your email",
  text: "Hello",
  html: "<p>Hello</p>",
  idempotencyKey: "verify:3f1c2b8e",
};

describe("ResendMailer", () => {
  it("sends with the configured sender and idempotency key header", async () => {
    const send = vi.fn(async () => ({ id: "msg_123" }));
    const mailer = new ResendMailer(settings);
    mailer["client"] = { emails: { send } } as any;
    await mailer.send(message);
    expect(send).toHaveBeenCalledWith({
      from: "Àjo <noreply@ajo.example>",
      to: "ada@example.com",
      subject: "Verify your email",
      text: "Hello",
      html: "<p>Hello</p>",
      headers: {
        "X-Idempotency-Key": "verify:3f1c2b8e",
      },
    });
  });

  it("fails without leaking the API key", async () => {
    const send = vi.fn(async () => {
      throw new Error("401 Unauthorized re_test_key");
    });
    const mailer = new ResendMailer(settings);
    mailer["client"] = { emails: { send } } as any;
    await expect(mailer.send(message)).rejects.toThrow(/Resend/);
    await expect(mailer.send(message)).rejects.not.toThrow(/re_test_key/);
  });
});
