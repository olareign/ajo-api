import { Logger } from "@nestjs/common";
import { FakeBotCheck } from "./fake.adapter.js";
import { TurnstileBotCheck } from "./turnstile.adapter.js";

type Answer = { success: boolean; "error-codes"?: string[] };
const answer = (body: Answer, status = 200) =>
  vi.fn(async (_url: string, _init?: RequestInit) => Response.json(body, { status }));
const SECRET = "test-only-secret";
const check = (fetchFn: ReturnType<typeof answer>) => new TurnstileBotCheck(SECRET, fetchFn, 1000);

describe("TurnstileBotCheck", () => {
  it("asks Cloudflare, sending the secret and the person's token as a form", async () => {
    const fetchFn = answer({ success: true });
    await check(fetchFn).verify("token-from-the-form");

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    const sent = new URLSearchParams(init?.body as string);
    expect(sent.get("secret")).toBe(SECRET);
    expect(sent.get("response")).toBe("token-from-the-form");
  });

  it("passes a token Cloudflare accepts", async () => {
    expect(await check(answer({ success: true })).verify("good")).toBe("passed");
  });

  it.each([
    ["a token that was already used or has expired", "timeout-or-duplicate"],
    ["a token that is not valid", "invalid-input-response"],
    ["a missing token", "missing-input-response"],
  ])("fails %s", async (_name, code) => {
    expect(await check(answer({ success: false, "error-codes": [code] })).verify("bad")).toBe(
      "failed",
    );
  });

  it("never calls Cloudflare without a token, and fails an absurdly long one", async () => {
    const fetchFn = answer({ success: true });
    expect(await check(fetchFn).verify(undefined)).toBe("failed");
    expect(await check(fetchFn).verify("")).toBe("failed");
    expect(await check(fetchFn).verify("x".repeat(2049))).toBe("failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["our own secret is wrong", { success: false, "error-codes": ["invalid-input-secret"] }],
    ["our secret is missing", { success: false, "error-codes": ["missing-input-secret"] }],
    ["Cloudflare had an internal error", { success: false, "error-codes": ["internal-error"] }],
  ])("is unavailable, not the person's fault, when %s", async (_name, body) => {
    expect(await check(answer(body)).verify("token")).toBe("unavailable");
  });

  it("is unavailable when Cloudflare cannot be reached, answers badly, or times out", async () => {
    const down = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await check(down as never).verify("t")).toBe("unavailable");
    expect(await check(answer({ success: true }, 503)).verify("t")).toBe("unavailable");
    const garbage = vi.fn(async () => new Response("<html>", { status: 200 }));
    expect(await check(garbage as never).verify("t")).toBe("unavailable");
  });

  it("recognises a wrong secret even when Cloudflare answers it with an HTTP 400, and logs that, not 'unreachable'", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const result = await check(
      answer({ success: false, "error-codes": ["invalid-input-secret"] }, 400),
    ).verify("token");

    expect(result).toBe("unavailable");
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).toContain("invalid-input-secret");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it("logs why it was unavailable, without the secret or the person's token", async () => {
    const down = vi.fn(async () => {
      throw new Error("network down");
    });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    await check(down as never).verify("secret-looking-token");
    await check(answer({ success: false, "error-codes": ["invalid-input-secret"] })).verify(
      "secret-looking-token",
    );

    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(warn.mock.calls.length + error.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("secret-looking-token");
    warn.mockRestore();
    error.mockRestore();
  });
});

describe("FakeBotCheck (development and tests only)", () => {
  it("passes anything, including no token, so ordinary tests need no widget", async () => {
    expect(await new FakeBotCheck().verify(undefined)).toBe("passed");
    expect(await new FakeBotCheck().verify("anything")).toBe("passed");
  });

  it("can be told to fail or to be unavailable, so the refusals can be tested", async () => {
    expect(await new FakeBotCheck().verify(FakeBotCheck.FAIL)).toBe("failed");
    expect(await new FakeBotCheck().verify(FakeBotCheck.UNAVAILABLE)).toBe("unavailable");
  });
});
