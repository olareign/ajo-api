import { createHash } from "node:crypto";
import { HibpBreachedPasswords } from "./hibp.adapter.js";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex").toUpperCase();

function fakeFetch(body: string, status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status }));
}

describe("HibpBreachedPasswords", () => {
  it("sends only the first five characters of the SHA-1 hash (k-anonymity)", async () => {
    const fetch = fakeFetch("");
    await new HibpBreachedPasswords(fetch).isBreached("password123456");
    const url = fetch.mock.calls[0]![0];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha1("password123456").slice(0, 5)}`);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("password123456");
  });

  it("asks for padded responses so the reply size reveals nothing", async () => {
    const fetch = fakeFetch("");
    await new HibpBreachedPasswords(fetch).isBreached("x".repeat(12));
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("Add-Padding")).toBe("true");
  });

  it("finds a breached password in the range response", async () => {
    const suffix = sha1("password123456").slice(5);
    const fetch = fakeFetch(`0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${suffix}:2391\r\n`);
    expect(await new HibpBreachedPasswords(fetch).isBreached("password123456")).toBe(true);
  });

  it("ignores padding entries with a zero count", async () => {
    const suffix = sha1("unique passphrase here").slice(5);
    const fetch = fakeFetch(`${suffix}:0\r\n`);
    expect(await new HibpBreachedPasswords(fetch).isBreached("unique passphrase here")).toBe(false);
  });

  it("lets sign-up continue if the service is unavailable, rather than locking everyone out", async () => {
    const down = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await new HibpBreachedPasswords(down).isBreached("anything goes here")).toBe(false);
    expect(
      await new HibpBreachedPasswords(fakeFetch("", 503)).isBreached("anything goes here"),
    ).toBe(false);
  });
});
