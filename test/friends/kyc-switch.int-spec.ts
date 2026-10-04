import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "../support/test-app.js";
import { friendsHarness } from "./support.js";

/**
 * "Only verified people can be found" must mean what the money gate means by verified, including the
 * owner's switches: approved by hand, approved with everyone, and a hold that beats both.
 */
const found = async (
  h: ReturnType<typeof friendsHarness>,
  who: Awaited<ReturnType<ReturnType<typeof friendsHarness>["member"]>>,
  username: string,
) => {
  const res = await who.call("get", `/friends/search?q=${username}`).expect(200);
  return (res.body as { username: string }[]).some((p) => p.username === username);
};

async function unverified(h: ReturnType<typeof friendsHarness>) {
  const [id] = await h.crowd(1, "sw", { approved: false });
  const [row] = await h.t.db.query("SELECT username::text AS username FROM users WHERE id = $1", [
    id,
  ]);
  return { id: id as string, username: row.username as string };
}

describe("with the automatic switch off", () => {
  let app: NestExpressApplication;
  let h: ReturnType<typeof friendsHarness>;
  beforeAll(async () => {
    app = await createTestApp({ PAYMENTS_FAKE: "true", KYC_AUTO_APPROVE: "false" });
    h = friendsHarness(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("hides someone with no checks, shows them once approved by hand, hides them again when held or cleared", async () => {
    const me = await h.member();
    const them = await unverified(h);
    expect(await found(h, me, them.username)).toBe(false);

    await h.t.db.query("UPDATE users SET kyc_override = 'approved' WHERE id = $1", [them.id]);
    expect(await found(h, me, them.username)).toBe(true);
    await me.call("post", "/friends/requests").send({ username: them.username }).expect(200);

    await h.t.db.query("UPDATE users SET kyc_override = 'denied' WHERE id = $1", [them.id]);
    expect(await found(h, me, them.username)).toBe(false);
    await me.call("post", "/friends/requests").send({ username: them.username }).expect(404);

    await h.t.db.query("UPDATE users SET kyc_override = NULL WHERE id = $1", [them.id]);
    expect(await found(h, me, them.username)).toBe(false);
  });

  it("holds back someone whose checks all passed", async () => {
    const me = await h.member();
    const [id] = await h.crowd(1, "swh");
    const [row] = await h.t.db.query("SELECT username::text AS username FROM users WHERE id = $1", [
      id,
    ]);
    expect(await found(h, me, row.username)).toBe(true);
    await h.t.db.query("UPDATE users SET kyc_override = 'denied' WHERE id = $1", [id]);
    expect(await found(h, me, row.username)).toBe(false);
  });
});

describe("with the automatic switch on", () => {
  let app: NestExpressApplication;
  let h: ReturnType<typeof friendsHarness>;
  beforeAll(async () => {
    app = await createTestApp({ PAYMENTS_FAKE: "true", KYC_AUTO_APPROVE: "true" });
    h = friendsHarness(app);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("finds everyone, except someone who is held", async () => {
    const me = await h.member({ kyc: false });
    const them = await unverified(h);
    expect(await found(h, me, them.username)).toBe(true);
    await h.t.db.query("UPDATE users SET kyc_override = 'denied' WHERE id = $1", [them.id]);
    expect(await found(h, me, them.username)).toBe(false);
  });
});
