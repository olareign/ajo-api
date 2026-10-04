import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { createTestApp } from "../support/test-app.js";
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

describe("finding people", () => {
  it("finds verified people by the start of their username, the exact one first, and never yourself", async () => {
    const me = await h.member();
    const [a, b] = await h.crowd(2, "findme");
    const [rows] = [
      await h.t.db.query(
        "SELECT username::text AS username FROM users WHERE id = ANY($1::uuid[]) ORDER BY username",
        [[a, b]],
      ),
    ];
    const exact = rows[0].username as string;
    const res = await me.call("get", `/friends/search?q=${exact.slice(0, 8)}`).expect(200);
    expect(names(res.body)).toEqual(expect.arrayContaining([rows[0].username, rows[1].username]));
    expect(
      res.body.every((p: { username: string }) => p.username.startsWith(exact.slice(0, 8))),
    ).toBe(true);
    const exactFirst = await me.call("get", `/friends/search?q=${exact}`).expect(200);
    expect(exactFirst.body[0].username).toBe(exact);
    const self = await me.call("get", `/friends/search?q=${me.username}`).expect(200);
    expect(names(self.body)).not.toContain(me.username);
    expect(res.body[0]).toEqual(
      expect.objectContaining({ relation: "none", mutualFriends: 0, tier: 1 }),
    );
    expect(res.body[0]).not.toHaveProperty("id");
    expect(res.body[0]).not.toHaveProperty("email");
  });

  it("does not show people who are not verified, or are suspended", async () => {
    const me = await h.member();
    const [hidden] = await h.crowd(1, "unverifd", { approved: false });
    const [suspended] = await h.crowd(1, "suspendd");
    await h.t.db.query("UPDATE users SET status = 'suspended' WHERE id = $1", [suspended]);
    const rows = await h.t.db.query(
      "SELECT username::text AS username FROM users WHERE id = ANY($1::uuid[])",
      [[hidden, suspended]],
    );
    for (const { username } of rows) {
      expect((await me.call("get", `/friends/search?q=${username}`).expect(200)).body).toEqual([]);
      await me.call("get", `/friends/people/${username}`).expect(404);
    }
  });

  it("asks for at least three letters of a real username, and treats an underscore as a letter, not a wildcard", async () => {
    const me = await h.member();
    for (const bad of ["a", "ab", "9abc", "ab%", "a b c", "../me", ""]) {
      const res = await me.call("get", `/friends/search?q=${encodeURIComponent(bad)}`);
      expect([400]).toContain(res.status);
    }
    const [id] = await h.crowd(1, "wild");
    const unique = `wd${Math.random().toString(36).slice(2, 8)}`;
    await h.t.db.query("UPDATE users SET username = $2 WHERE id = $1", [id, `${unique}_card`]);
    expect(
      names((await me.call("get", `/friends/search?q=${unique}_c`).expect(200)).body),
    ).toContain(`${unique}_card`);
    // A "_" in the search is a letter: it does not stand for any character.
    expect(
      names((await me.call("get", `/friends/search?q=${unique}x_c`).expect(200)).body),
    ).not.toContain(`${unique}_card`);
    expect(
      names(
        (
          await me
            .call("get", `/friends/search?q=${unique.slice(0, 4)}_${unique.slice(5)}`)
            .expect(200)
        ).body,
      ),
    ).not.toContain(`${unique}_card`);
  });

  it("returns at most ten", async () => {
    const me = await h.member();
    await h.crowd(14, "tencap");
    const res = await me.call("get", "/friends/search?q=tencap").expect(200);
    expect(res.body).toHaveLength(10);
  });

  it("shows how you are related, and how many friends you share", async () => {
    const me = await h.member();
    const friend = await h.member();
    const other = await h.member();
    const stranger = await h.member();
    await h.befriend(me, friend);
    await h.befriend(other, friend);
    await me.call("post", "/friends/requests").send({ username: stranger.username }).expect(200);
    const find = async (who: typeof friend) =>
      (await me.call("get", `/friends/search?q=${who.username}`).expect(200)).body.find(
        (p: { username: string }) => p.username === who.username,
      );
    expect(await find(friend)).toMatchObject({ relation: "friend" });
    expect(await find(stranger)).toMatchObject({ relation: "requested" });
    expect(await find(other)).toMatchObject({ relation: "none", mutualFriends: 1 });
    await stranger.call("post", "/friends/requests").send({ username: other.username }).expect(200);
    const asOther = (await other.call("get", `/friends/people/${stranger.username}`).expect(200))
      .body;
    expect(asOther.relation).toBe("incoming");
  });

  it("shows a second badge to someone with a national check", async () => {
    const me = await h.member();
    const [id] = await h.crowd(1, "bvnbadge");
    await h.t.db.query(
      "INSERT INTO kyc_steps (user_id, step, status) VALUES ($1, 'national_check', 'approved')",
      [id],
    );
    const [{ username }] = await h.t.db.query(
      "SELECT username::text AS username FROM users WHERE id = $1",
      [id],
    );
    expect((await me.call("get", `/friends/people/${username}`).expect(200)).body.tier).toBe(2);
  });

  it("is closed to people who are not verified themselves, and to the signed out", async () => {
    const unverified = await h.member({ kyc: false });
    const res = await unverified.call("get", "/friends/search?q=abc");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("kyc_required");
    await unverified.call("get", "/friends").expect(403);
    await request(h.t.http()).get("/api/v1/friends/search?q=abc").expect(401);
  });
});

describe("trust on a person's card", () => {
  it("says new for someone with no record, and trusted for someone with a good one, in search, the card and the friend list", async () => {
    const me = await h.member();
    const [fresh, veteran] = await h.crowd(2, "trustcard");
    for (let i = 0; i < 8; i += 1) {
      await h.t.db.query(
        "INSERT INTO trust_events (user_id, kind, ref) VALUES ($1, 'payment_on_time', $2)",
        [veteran, `card:${i}:${veteran}`],
      );
    }
    const rows = await h.t.db.query(
      "SELECT id, username::text AS username FROM users WHERE id = ANY($1::uuid[])",
      [[fresh, veteran]],
    );
    const nameOf = (id: string) => rows.find((r: { id: string }) => r.id === id).username as string;
    const a = (await me.call("get", `/friends/people/${nameOf(fresh!)}`).expect(200)).body;
    const b = (await me.call("get", `/friends/people/${nameOf(veteran!)}`).expect(200)).body;
    expect(a.trust).toEqual({ level: "new", score: 0 });
    expect(b.trust).toEqual({ level: "trusted", score: 40 });
    const found = (await me.call("get", `/friends/search?q=${nameOf(veteran!)}`).expect(200)).body;
    expect(found[0].trust.level).toBe("trusted");
    // A record is never shown in detail: only the level and score.
    expect(Object.keys(b.trust).sort()).toEqual(["level", "score"]);
  });
});
