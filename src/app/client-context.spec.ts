import { clientContextMiddleware } from "./client-context.js";

const SECRET = "s".repeat(40);

type Fake = { headers: Record<string, string | string[] | undefined>; ip: string };
const run = (secret: string | undefined, headers: Fake["headers"]) => {
  const req: Fake = { headers: { "user-agent": "node-fetch", ...headers }, ip: "76.76.21.21" };
  const next = vi.fn();
  clientContextMiddleware(secret)(req as never, {} as never, next);
  expect(next).toHaveBeenCalledTimes(1);
  return req;
};
const trusted = (extra: Fake["headers"] = {}) => ({
  "x-ajo-bff-secret": SECRET,
  "x-ajo-client-ip": "102.89.34.7",
  "x-ajo-client-ua": "Mozilla/5.0 (Linux; Android 14) Chrome/130",
  ...extra,
});

describe("clientContextMiddleware", () => {
  it("takes the person's address and device from the web server when it proves who it is", () => {
    const req = run(SECRET, trusted());
    expect(req.ip).toBe("102.89.34.7");
    expect(req.headers["user-agent"]).toBe("Mozilla/5.0 (Linux; Android 14) Chrome/130");
  });

  it("accepts an IPv6 address too", () => {
    expect(run(SECRET, trusted({ "x-ajo-client-ip": "2a00:23c8:1::7" })).ip).toBe("2a00:23c8:1::7");
  });

  it.each([
    ["no secret presented", { "x-ajo-bff-secret": undefined }],
    ["a wrong secret", { "x-ajo-bff-secret": "x".repeat(40) }],
    ["a secret of another length", { "x-ajo-bff-secret": "short" }],
    ["a secret sent twice", { "x-ajo-bff-secret": [SECRET, SECRET] }],
  ])("ignores everything when there is %s", (_why, header) => {
    const req = run(SECRET, trusted(header));
    expect(req.ip).toBe("76.76.21.21");
    expect(req.headers["user-agent"]).toBe("node-fetch");
  });

  it("ignores everything when the API has no secret configured, so a browser's own headers can never set an address", () => {
    const req = run(undefined, trusted());
    expect(req.ip).toBe("76.76.21.21");
    expect(req.headers["user-agent"]).toBe("node-fetch");
  });

  it.each([
    ["not an address", "not-an-ip"],
    ["a list", "1.2.3.4, 5.6.7.8"],
    ["an address with a path", "1.2.3.4/../x"],
    ["empty", ""],
  ])("keeps the connection's own address when the claimed one is %s", (_why, claimed) => {
    const req = run(SECRET, trusted({ "x-ajo-client-ip": claimed }));
    expect(req.ip).toBe("76.76.21.21");
  });

  it("caps the device description, so a hostile one cannot fill a column or a log", () => {
    const req = run(SECRET, trusted({ "x-ajo-client-ua": "A".repeat(5000) }));
    expect((req.headers["user-agent"] as string).length).toBe(512);
  });

  it("removes its own headers either way, so the secret never travels further into the app", () => {
    for (const secret of [SECRET, undefined]) {
      const req = run(secret, trusted());
      expect(Object.keys(req.headers).filter((h) => h.startsWith("x-ajo-"))).toEqual([]);
    }
  });
});
