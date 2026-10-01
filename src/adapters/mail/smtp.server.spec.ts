import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleParser, type ParsedMail } from "mailparser";
import { SMTPServer } from "smtp-server";
import { SmtpMailer } from "./smtp.adapter.js";

/**
 * Talks real SMTP over real TLS to a local server, so the adapter's wire behaviour (implicit TLS,
 * login, headers, non-ASCII names) is tested rather than assumed.
 */
const USER = "mailer@example.com";
const PASSWORD = "app-password-123";
const FROM = "Àjo <noreply@ajo.example>";

let dir: string;
let server: SMTPServer;
let ca: string;
let port: number;
const received: ParsedMail[] = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "smtp-test-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  ca = readFileSync(join(dir, "cert.pem"), "utf8");
  server = new SMTPServer({
    secure: true, // implicit TLS, like Gmail on port 465
    key: readFileSync(join(dir, "key.pem")),
    cert: ca,
    authOptional: false,
    onAuth(auth, _session, callback) {
      if (auth.username === USER && auth.password === PASSWORD) return callback(null, { user: 1 });
      callback(new Error("Invalid login"));
    },
    onData(stream, _session, callback) {
      simpleParser(stream).then((mail) => {
        received.push(mail);
        callback();
      }, callback);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const settings = (over: Record<string, unknown> = {}) => ({
  host: "localhost",
  port,
  secure: true,
  user: USER,
  password: PASSWORD,
  from: FROM,
  tls: { ca },
  ...over,
});
const message = {
  to: "ada@example.com",
  subject: "Verify your email · Àjo",
  text: "Open the link to verify.",
  html: "<p>Open the link to verify.</p>",
  idempotencyKey: "verify:abc123",
};

describe("SmtpMailer against a real SMTP server", () => {
  it("logs in, delivers the message, and keeps the accented sender name intact", async () => {
    await new SmtpMailer(settings()).send(message);
    const mail = received.at(-1)!;
    expect(mail.from?.value[0]).toEqual({ name: "Àjo", address: "noreply@ajo.example" });
    expect(mail.to).toMatchObject({ text: "ada@example.com" });
    expect(mail.subject).toBe("Verify your email · Àjo");
    expect(mail.text).toContain("Open the link to verify.");
    expect(mail.html).toContain("<p>Open the link");
    expect(mail.messageId).toBe("<verify-abc123@ajo.mail>");
  });

  it("is refused with a short code, never the password, when the login is wrong", async () => {
    const mailer = new SmtpMailer(settings({ password: "wrong-password" }));
    const error = await mailer.send(message).then(
      () => null,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/SMTP.*EAUTH/);
    expect(error?.message).not.toContain("wrong-password");
    expect(error?.message).not.toContain(PASSWORD);
  });

  it("reports a refused connection instead of hanging", async () => {
    const mailer = new SmtpMailer(settings({ port: 1 }));
    await expect(mailer.send(message)).rejects.toThrow(/SMTP.*(ECONNREFUSED|ESOCKET)/);
  });
});
