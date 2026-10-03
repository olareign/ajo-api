import type { Resend } from "resend";
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

/** A stand-in for the SDK client whose `emails.send` is the given function. */
function clientWith(send: (...args: unknown[]) => Promise<unknown>): Resend {
  return { emails: { send } } as unknown as Resend;
}

describe("ResendMailer", () => {
  it("sends with the configured sender and passes the idempotency key to Resend", async () => {
    const send = vi.fn(async () => ({ data: { id: "msg_123" }, error: null, headers: null }));
    await new ResendMailer(settings, clientWith(send)).send(message);
    expect(send).toHaveBeenCalledWith(
      {
        from: "Àjo <noreply@ajo.example>",
        to: "ada@example.com",
        subject: "Verify your email",
        text: "Hello",
        html: "<p>Hello</p>",
      },
      { idempotencyKey: "verify:3f1c2b8e" },
    );
  });

  it("fails when Resend answers with an error, which the SDK returns instead of throwing", async () => {
    const send = vi.fn(async () => ({
      data: null,
      error: { name: "validation_error", message: "The domain is not verified", statusCode: 403 },
      headers: null,
    }));
    await expect(new ResendMailer(settings, clientWith(send)).send(message)).rejects.toThrow(
      "Email provider rejected the message (Resend validation_error 403)",
    );
  });

  it("fails without leaking the API key when the request itself fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("401 Unauthorized re_test_key");
    });
    const mailer = new ResendMailer(settings, clientWith(send));
    await expect(mailer.send(message)).rejects.toThrow(/Resend/);
    await expect(mailer.send(message)).rejects.not.toThrow(/re_test_key/);
  });
});
