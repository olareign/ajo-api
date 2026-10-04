import type { NestExpressApplication } from "@nestjs/platform-express";
import { createTestApp } from "../support/test-app.js";
import { MAX_OUTGOING_REQUESTS } from "../../src/friends/friends.service.js";
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

const many = <T>(n: number, make: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => make(i)));

describe("asking, accepting and ending", () => {
  it("sends a request that shows up for both, and tells the person asked", async () => {
    const a = await h.member({ name: "Ada Ola" });
    const b = await h.member();
    const res = await a
      .call("post", "/friends/requests")
      .send({ username: `@${b.username.toUpperCase()}` })
      .expect(200);
    expect(res.body).toEqual({ relation: "requested" });
    const sent = (await a.call("get", "/friends/requests").expect(200)).body;
    expect(sent.outgoing.map((r: { username: string }) => r.username)).toEqual([b.username]);
    expect(sent.incoming).toEqual([]);
    const got = (await b.call("get", "/friends/requests").expect(200)).body;
    expect(got.incoming.map((r: { username: string }) => r.username)).toEqual([a.username]);
    expect(
      (await h.notices(b.id)).find((n: { kind: string }) => n.kind === "friend.request"),
    ).toMatchObject({ title: "Ada Ola wants to be friends" });
    expect((await h.notices(a.id)).some((n: { kind: string }) => n.kind === "friend.request")).toBe(
      false,
    );
  });

  it("makes one request however many times, or how many at once, it is asked", async () => {
    const a = await h.member();
    const b = await h.member();
    const sends = await many(8, () =>
      a.call("post", "/friends/requests").send({ username: b.username }),
    );
    expect(sends.every((r) => r.status === 200 && r.body.relation === "requested")).toBe(true);
    expect(await h.pairRows(a.id, b.id)).toHaveLength(1);
    expect(
      (await h.notices(b.id)).filter((n: { kind: string }) => n.kind === "friend.request"),
    ).toHaveLength(1);
  });

  it("accepts, tells the asker, and shows each in the other's list; accepting again changes nothing", async () => {
    const a = await h.member();
    const b = await h.member({ name: "Bola Ade" });
    await a.call("post", "/friends/requests").send({ username: b.username }).expect(200);
    const first = await b.call("post", `/friends/requests/${a.username}/accept`).expect(200);
    const second = await b.call("post", `/friends/requests/${a.username}/accept`).expect(200);
    expect(first.body).toEqual({ relation: "friend" });
    expect(second.body).toEqual({ relation: "friend" });
    expect(
      (await a.call("get", "/friends").expect(200)).body.friends.map(
        (f: { username: string }) => f.username,
      ),
    ).toEqual([b.username]);
    expect(
      (await b.call("get", "/friends").expect(200)).body.friends.map(
        (f: { username: string }) => f.username,
      ),
    ).toEqual([a.username]);
    expect((await a.call("get", "/friends/requests").expect(200)).body.outgoing).toEqual([]);
    expect(
      (await h.notices(a.id)).filter((n: { kind: string }) => n.kind === "friend.accepted"),
    ).toHaveLength(1);
  });

  it("will not let the asker accept their own request, or anyone accept one that was never made", async () => {
    const a = await h.member();
    const b = await h.member();
    const c = await h.member();
    await a.call("post", "/friends/requests").send({ username: b.username }).expect(200);
    expect((await a.call("post", `/friends/requests/${b.username}/accept`)).body.code).toBe(
      "no_request",
    );
    expect((await c.call("post", `/friends/requests/${a.username}/accept`)).status).toBe(404);
    expect((await h.pairRows(a.id, b.id))[0].status).toBe("pending");
  });

  it("makes two people who ask each other at the same moment friends, with one row, every time", async () => {
    for (let round = 0; round < 6; round += 1) {
      const a = await h.member();
      const b = await h.member();
      await Promise.all([
        a.call("post", "/friends/requests").send({ username: b.username }),
        b.call("post", "/friends/requests").send({ username: a.username }),
      ]);
      const rows = await h.pairRows(a.id, b.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("accepted");
    }
  });

  it("asking someone who already asked you is accepting", async () => {
    const a = await h.member();
    const b = await h.member();
    await a.call("post", "/friends/requests").send({ username: b.username }).expect(200);
    expect(
      (await b.call("post", "/friends/requests").send({ username: a.username }).expect(200)).body
        .relation,
    ).toBe("friend");
  });

  it("lets the asker take a request back, and the asked say no without the asker being told", async () => {
    const a = await h.member();
    const b = await h.member();
    const c = await h.member();
    await a.call("post", "/friends/requests").send({ username: b.username }).expect(200);
    await a.call("delete", `/friends/requests/${b.username}`).expect(204);
    await a.call("delete", `/friends/requests/${b.username}`).expect(204);
    expect(await h.pairRows(a.id, b.id)).toHaveLength(0);

    await a.call("post", "/friends/requests").send({ username: c.username }).expect(200);
    // The asker cannot "decline" their own, and cancelling someone else's changes nothing.
    await a.call("delete", `/friends/requests/${c.username}/received`).expect(204);
    await c.call("delete", `/friends/requests/${a.username}`).expect(204);
    expect(await h.pairRows(a.id, c.id)).toHaveLength(1);
    await c.call("delete", `/friends/requests/${a.username}/received`).expect(204);
    expect(await h.pairRows(a.id, c.id)).toHaveLength(0);
    expect(
      (await h.notices(a.id)).filter((n: { kind: string }) => /friend\./.test(n.kind)),
    ).toEqual([]);
    // Declined, they can ask again, and it is a new request that tells the person again.
    await a.call("post", "/friends/requests").send({ username: c.username }).expect(200);
    expect(
      (await h.notices(c.id)).filter((n: { kind: string }) => n.kind === "friend.request"),
    ).toHaveLength(2);
  });

  it("ends a friendship for both, and either can ask again", async () => {
    const a = await h.member();
    const b = await h.member();
    await h.befriend(a, b);
    await a.call("delete", `/friends/${b.username}`).expect(204);
    await a.call("delete", `/friends/${b.username}`).expect(204);
    expect((await b.call("get", "/friends").expect(200)).body.friends).toEqual([]);
    await b.call("post", "/friends/requests").send({ username: a.username }).expect(200);
    expect(await h.pairRows(a.id, b.id)).toHaveLength(1);
  });

  it("leaves a friendship alone when 'remove' is used on someone who is only asked", async () => {
    const a = await h.member();
    const b = await h.member();
    await a.call("post", "/friends/requests").send({ username: b.username }).expect(200);
    await a.call("delete", `/friends/${b.username}`).expect(204);
    expect(await h.pairRows(a.id, b.id)).toHaveLength(1);
  });

  it("never ends in two rows or a half-state when accepting, cancelling and removing all race", async () => {
    for (let round = 0; round < 5; round += 1) {
      const a = await h.member();
      const b = await h.member();
      await a.call("post", "/friends/requests").send({ username: b.username }).expect(200);
      await Promise.all([
        b.call("post", `/friends/requests/${a.username}/accept`),
        a.call("delete", `/friends/requests/${b.username}`),
        b.call("delete", `/friends/${a.username}`),
        a.call("post", "/friends/requests").send({ username: b.username }),
      ]);
      const rows = await h.pairRows(a.id, b.id);
      expect(rows.length).toBeLessThanOrEqual(1);
    }
  });

  it("keeps a person to fifty requests waiting, even when they are made together", async () => {
    const a = await h.member();
    const crowd = await h.crowd(MAX_OUTGOING_REQUESTS + 3, "reqcap");
    const usernames = (
      await h.t.db.query(
        "SELECT username::text AS username FROM users WHERE id = ANY($1::uuid[]) ORDER BY username",
        [crowd],
      )
    ).map((r: { username: string }) => r.username);
    const results = await many(usernames.length, (i) =>
      a.call("post", "/friends/requests").send({ username: usernames[i] }),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(MAX_OUTGOING_REQUESTS);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.code === "too_many_requests"),
    ).toBe(true);
  });

  it("answers the same 'no such person' for someone who does not exist, is not verified or is blocked", async () => {
    const a = await h.member();
    const blocker = await h.member();
    const [unverified] = await h.crowd(1, "noverify", { approved: false });
    const [{ username: unverifiedName }] = await h.t.db.query(
      "SELECT username::text AS username FROM users WHERE id = $1",
      [unverified],
    );
    await blocker.call("post", "/friends/blocks").send({ username: a.username }).expect(204);
    const answers = await Promise.all(
      ["nobody_here_x", unverifiedName, blocker.username].map((u) =>
        a.call("post", "/friends/requests").send({ username: u }),
      ),
    );
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(new Set(answers.map((r) => JSON.stringify(r.body.code))).size).toBe(1);
    await a.call("post", "/friends/requests").send({ username: a.username }).expect(404);
    await a.call("post", "/friends/requests").send({ username: "x" }).expect(400);
    await a.call("post", "/friends/requests").send({ username: "ok_name", extra: 1 }).expect(400);
  });
});
