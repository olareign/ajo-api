import { ResendMailer } from "./resend.adapter.js";

const message = {
  to: "ada@example.com",
  subject: "Verify your email",
  text: "Hello",
  html: "<p>Hello</p>",
  idempotencyKey: "verify:3f1c2b8e",
};

describe("ResendMailer", () => {
  it("sends through the Resend API with the sender, key and an idempotency key", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ id: "em_1" }));
    await new ResendMailer("re_secret_key", "Àjọ <no-reply@ajo.example>", fetch).send(message);

    const [url, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(headers.get("Authorization")).toBe("Bearer re_secret_key");
    expect(headers.get("Idempotency-Key")).toBe("verify:3f1c2b8e");
    expect(JSON.parse(init?.body as string)).toEqual({
      from: "Àjọ <no-reply@ajo.example>",
      to: ["ada@example.com"],
      subject: "Verify your email",
      text: "Hello",
      html: "<p>Hello</p>",
    });
  });

  it("fails loudly on an API error without leaking the key", async () => {
    const fetch = vi.fn(async () => new Response("bad", { status: 422 }));
    const mailer = new ResendMailer("re_secret_key", "x@y.z", fetch);
    await expect(mailer.send(message)).rejects.toThrow(/422/);
    await expect(mailer.send(message)).rejects.not.toThrow(/re_secret_key/);
  });
});
