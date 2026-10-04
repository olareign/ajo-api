import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { createTestApp } from "../support/test-app.js";
import { newIp, GOOD_PASSWORD, uniqueEmail } from "../support/users.js";
import { friendsHarness } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof friendsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  h = friendsHarness(app);
});
afterAll(async () => {
  await app?.close();
});

const names = (body: { username: string }[]) => body.map((p) => p.username);

describe("people you may know", () => {
  it("ranks friends of friends by how many you share, and names two of them", async () => {
    const me = await h.member();
    const [b, c] = [await h.member({ name: "Bola" }), await h.member({ name: "Chi" })];
    const [x, y, z] = [await h.member(), await h.member(), await h.member()];
    await h.befriend(me, b);
    await h.befriend(me, c);
    await h.befriend(b, x);
    await h.befriend(c, x);
    await h.befriend(b, y);
    await h.befriend(z, await h.member()); // not connected to me at all
    const res = (await me.call("get", "/friends/suggestions").expect(200)).body;
    expect(names(res)).toEqual([x.username, y.username]);
    expect(res[0]).toMatchObject({
      reason: "mutual",
      mutualFriends: 2,
      mutualNames: ["Bola", "Chi"],
      relation: "none",
    });
    expect(res[1]).toMatchObject({ mutualFriends: 1, mutualNames: ["Bola"] });
    expect(names(res)).not.toContain(b.username);
    expect(names(res)).not.toContain(me.username);
  });

  it("leaves out anyone you already have a request with, anyone blocked either way, and anyone not verified", async () => {
    const me = await h.member();
    const bridge = await h.member();
    const [pending, blockedByMe, blocksMe, unverified, fine] = [
      await h.member(),
      await h.member(),
      await h.member(),
      await h.member(),
      await h.member(),
    ];
    await h.befriend(me, bridge);
    for (const p of [pending, blockedByMe, blocksMe, unverified, fine]) await h.befriend(bridge, p);
    await me.call("post", "/friends/requests").send({ username: pending.username }).expect(200);
    await me.call("post", "/friends/blocks").send({ username: blockedByMe.username }).expect(204);
    await blocksMe.call("post", "/friends/blocks").send({ username: me.username }).expect(204);
    await h.t.db.query("DELETE FROM kyc_steps WHERE user_id = $1", [unverified.id]);
    expect(names((await me.call("get", "/friends/suggestions").expect(200)).body)).toEqual([
      fine.username,
    ]);
  });

  it("has nothing to suggest to someone with no friends", async () => {
    const me = await h.member();
    expect((await me.call("get", "/friends/suggestions").expect(200)).body).toEqual([]);
  });
});

describe("invite links", () => {
  it("gives each person one stable code and link, even when asked for all at once", async () => {
    const me = await h.member();
    const sends = await Promise.all(
      Array.from({ length: 6 }, () => me.call("get", "/friends/invite")),
    );
    expect(sends.every((r) => r.status === 200)).toBe(true);
    const codes = new Set(sends.map((r) => r.body.code));
    expect(codes.size).toBe(1);
    const { code, link } = sends[0]!.body;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(link).toBe(`https://app.ajo.test/join/${code}`);
    expect((await me.call("get", "/friends/invite").expect(200)).body.code).toBe(code);
  });

  it("says who an invite is from before anyone signs in: a first name and a handle, nothing else", async () => {
    const me = await h.member({ name: "Ada Ola Bello" });
    const { code } = (await me.call("get", "/friends/invite").expect(200)).body;
    const res = await request(h.t.http()).get(`/api/v1/invites/${code.toLowerCase()}`).expect(200);
    expect(res.body).toEqual({ name: "Ada", username: me.username });
    await request(h.t.http()).get("/api/v1/invites/ZZZZZZZZ").expect(404);
    await request(h.t.http()).get("/api/v1/invites/not-a-code").expect(404);
  });

  it("closes the link when the account is closed", async () => {
    const me = await h.member();
    const { code } = (await me.call("get", "/friends/invite").expect(200)).body;
    await h.t.db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [me.id]);
    await request(h.t.http()).get(`/api/v1/invites/${code}`).expect(404);
  });

  it("remembers who invited a new person, ignores a wrong code without a word, and suggests each to the other once verified", async () => {
    const inviter = await h.member();
    const { code } = (await inviter.call("get", "/friends/invite").expect(200)).body;
    const signUp = async (extra: object) => {
      const email = uniqueEmail();
      const res = await request(h.t.http())
        .post("/api/v1/auth/sign-up")
        .set("X-Forwarded-For", newIp())
        .send({ email, password: GOOD_PASSWORD, displayName: "New Person", ...extra });
      return { email, res };
    };
    const good = await signUp({ invite: code });
    const wrong = await signUp({ invite: "ZZZZZZZZ" });
    const none = await signUp({});
    expect([good.res.status, wrong.res.status, none.res.status]).toEqual([202, 202, 202]);
    expect(good.res.body).toEqual(wrong.res.body);
    await request(h.t.http())
      .post("/api/v1/auth/sign-up")
      .set("X-Forwarded-For", newIp())
      .send({ email: uniqueEmail(), password: GOOD_PASSWORD, displayName: "x", invite: "short" })
      .expect(400);

    const [goodUser] = await h.t.db.query("SELECT id FROM users WHERE email = $1", [good.email]);
    const referral = await h.t.db.query("SELECT inviter_id FROM referrals WHERE invitee_id = $1", [
      goodUser.id,
    ]);
    expect(referral).toEqual([{ inviter_id: inviter.id }]);
    const [wrongUser] = await h.t.db.query("SELECT id FROM users WHERE email = $1", [wrong.email]);
    expect(
      await h.t.db.query("SELECT 1 FROM referrals WHERE invitee_id = $1", [wrongUser.id]),
    ).toHaveLength(0);

    // Not suggested until they are verified and have a username.
    expect((await inviter.call("get", "/friends/suggestions").expect(200)).body).toEqual([]);
    await h.approve(goodUser.id);
    const invitedName = `inv${Math.random().toString(36).slice(2, 9)}`;
    await h.t.db.query("UPDATE users SET username = $2 WHERE id = $1", [goodUser.id, invitedName]);
    const suggested = (await inviter.call("get", "/friends/suggestions").expect(200)).body;
    expect(suggested).toEqual([
      expect.objectContaining({ username: invitedName, reason: "you_invited" }),
    ]);
  });

  it("suggests the inviter to the person who joined through their link, first", async () => {
    const inviter = await h.member();
    const joiner = await h.member();
    const stranger = await h.member();
    await h.befriend(joiner, stranger);
    await h.t.db.query("INSERT INTO referrals (invitee_id, inviter_id) VALUES ($1, $2)", [
      joiner.id,
      inviter.id,
    ]);
    const res = (await joiner.call("get", "/friends/suggestions").expect(200)).body;
    expect(res).toEqual([
      expect.objectContaining({ username: inviter.username, reason: "invited_you" }),
    ]);
    await joiner.call("post", "/friends/requests").send({ username: inviter.username }).expect(200);
    expect((await joiner.call("get", "/friends/suggestions").expect(200)).body).toEqual([]);
  });

  it("never lets someone be their own inviter", async () => {
    const me = await h.member();
    const { code } = (await me.call("get", "/friends/invite").expect(200)).body;
    const [row] = await h.t.db.query(
      `INSERT INTO referrals (invitee_id, inviter_id) SELECT $1, user_id FROM invite_links WHERE code = $2 AND user_id <> $1 RETURNING 1`,
      [me.id, code],
    );
    expect(row).toBeUndefined();
  });
});
