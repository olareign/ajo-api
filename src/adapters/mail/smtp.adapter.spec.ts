import { resolveSecure, SmtpMailer } from "./smtp.adapter.js";

const settings = {
  host: "smtp.example.com",
  port: 465,
  user: "mailer",
  password: "s3cret-pass",
  from: "Àjo <noreply@ajo.example>",
};
const message = {
  to: "ada@example.com",
  subject: "Verify your email",
  text: "Hello",
  html: "<p>Hello</p>",
  idempotencyKey: "verify:3f1c2b8e",
};

describe("SmtpMailer", () => {
  it("sends with the configured sender and a stable message id", async () => {
    const sendMail = vi.fn(async () => ({}));
    await new SmtpMailer(settings, { sendMail }).send(message);
    expect(sendMail).toHaveBeenCalledWith({
      from: "Àjo <noreply@ajo.example>",
      to: "ada@example.com",
      subject: "Verify your email",
      text: "Hello",
      html: "<p>Hello</p>",
      messageId: "<verify-3f1c2b8e@ajo.mail>",
    });
  });

  it("fails without leaking the server's reply or the password", async () => {
    const sendMail = vi.fn(async () => {
      throw new Error("535 bad login s3cret-pass");
    });
    const mailer = new SmtpMailer(settings, { sendMail });
    await expect(mailer.send(message)).rejects.toThrow(/SMTP/);
    await expect(mailer.send(message)).rejects.not.toThrow(/s3cret-pass/);
  });

  it("treats port 465 as implicit TLS even when told otherwise", () => {
    expect(resolveSecure(465, false)).toBe(true);
    expect(resolveSecure(587, undefined)).toBe(false);
    expect(resolveSecure(587, true)).toBe(true);
  });
});
