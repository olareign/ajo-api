import type { NestExpressApplication } from "@nestjs/platform-express";
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

describe("blocking", () => {
  it("ends the friendship and any request, hides each from the other, and does not tell the blocked", async () => {
    const a = await h.member();
    const b = await h.member();
    await h.befriend(a, b);
    await a.call("post", "/friends/blocks").send({ username: b.username }).expect(204);
    expect(await h.pairRows(a.id, b.id)).toHaveLength(0);
    for (const [me, them] of [
      [a, b],
      [b, a],
    ] as const) {
      expect((await me.call("get", `/friends/search?q=${them.username}`).expect(200)).body).toEqual(
        [],
      );
      await me.call("get", `/friends/people/${them.username}`).expect(404);
      expect((await me.call("get", "/friends").expect(200)).body.friends).toEqual([]);
      await me.call("post", "/friends/requests").send({ username: them.username }).expect(404);
    }
    expect((await h.notices(b.id)).filter((n: { kind: string }) => /block/.test(n.kind))).toEqual(
      [],
    );
    const blocked = (await a.call("get", "/friends/blocks").expect(200)).body;
    expect(blocked.map((p: { username: string }) => p.username)).toEqual([b.username]);
    expect((await b.call("get", "/friends/blocks").expect(200)).body).toEqual([]);
  });

  it("cancels a pending request in either direction, and is the same the second time", async () => {
    const a = await h.member();
    const b = await h.member();
    await a.call("post", "/friends/requests").send({ username: b.username }).expect(200);
    await b.call("post", "/friends/blocks").send({ username: a.username }).expect(204);
    await b.call("post", "/friends/blocks").send({ username: a.username }).expect(204);
    expect(await h.pairRows(a.id, b.id)).toHaveLength(0);
    expect((await b.call("get", "/friends/requests").expect(200)).body.incoming).toEqual([]);
  });

  it("unblocking makes them visible again, but does not bring the friendship back", async () => {
    const a = await h.member();
    const b = await h.member();
    await h.befriend(a, b);
    await a.call("post", "/friends/blocks").send({ username: b.username }).expect(204);
    await a.call("delete", `/friends/blocks/${b.username}`).expect(204);
    await a.call("delete", `/friends/blocks/${b.username}`).expect(204);
    expect((await a.call("get", `/friends/people/${b.username}`).expect(200)).body.relation).toBe(
      "none",
    );
    expect(await h.pairRows(a.id, b.id)).toHaveLength(0);
  });

  it("is never left with a friendship once the block is in, even when accepting races it", async () => {
    for (let round = 0; round < 6; round += 1) {
      const a = await h.member();
      const b = await h.member();
      await a.call("post", "/friends/requests").send({ username: b.username }).expect(200);
      await Promise.all([
        b.call("post", `/friends/requests/${a.username}/accept`),
        b.call("post", "/friends/blocks").send({ username: a.username }),
        a.call("post", "/friends/requests").send({ username: b.username }),
      ]);
      expect(await h.pairRows(a.id, b.id)).toHaveLength(0);
    }
  });

  it("refuses to block yourself or someone who does not exist", async () => {
    const a = await h.member();
    await a.call("post", "/friends/blocks").send({ username: a.username }).expect(404);
    await a.call("post", "/friends/blocks").send({ username: "nobody_at_all" }).expect(404);
  });
});

describe("reporting", () => {
  it("passes a report to the admin queue, once while it is open, with the reason", async () => {
    const a = await h.member();
    const b = await h.member();
    await a
      .call("post", "/friends/reports")
      .send({ username: b.username, reason: "scam", details: "  asked me to send money first  " })
      .expect(204);
    await a
      .call("post", "/friends/reports")
      .send({ username: b.username, reason: "spam" })
      .expect(204);
    const rows = await h.t.db.query(
      "SELECT reason, details, status FROM reports WHERE reporter_id = $1 AND reported_id = $2",
      [a.id, b.id],
    );
    expect(rows).toEqual([
      { reason: "scam", details: "asked me to send money first", status: "open" },
    ]);
    // Once it has been dealt with, a new one can be made.
    await h.t.db.query("UPDATE reports SET status = 'reviewed' WHERE reporter_id = $1", [a.id]);
    await a
      .call("post", "/friends/reports")
      .send({ username: b.username, reason: "harassment" })
      .expect(204);
    expect(await h.t.db.query("SELECT 1 FROM reports WHERE reporter_id = $1", [a.id])).toHaveLength(
      2,
    );
  });

  it("lets someone report a person they have blocked, and nobody they cannot see", async () => {
    const a = await h.member();
    const b = await h.member();
    const c = await h.member();
    await a.call("post", "/friends/blocks").send({ username: b.username }).expect(204);
    await a
      .call("post", "/friends/reports")
      .send({ username: b.username, reason: "harassment" })
      .expect(204);
    expect(
      await h.t.db.query("SELECT 1 FROM reports WHERE reporter_id = $1 AND reported_id = $2", [
        a.id,
        b.id,
      ]),
    ).toHaveLength(1);
    await c.call("post", "/friends/blocks").send({ username: a.username }).expect(204);
    await a
      .call("post", "/friends/reports")
      .send({ username: c.username, reason: "spam" })
      .expect(404);
  });

  it("only takes the reasons it knows, and short details", async () => {
    const a = await h.member();
    const b = await h.member();
    await a
      .call("post", "/friends/reports")
      .send({ username: b.username, reason: "rude" })
      .expect(400);
    await a
      .call("post", "/friends/reports")
      .send({ username: b.username, reason: "other", details: "x".repeat(501) })
      .expect(400);
    await a.call("post", "/friends/reports").send({ username: b.username }).expect(400);
  });

  it("is many reports at once, but one in the queue", async () => {
    const a = await h.member();
    const b = await h.member();
    await Promise.all(
      Array.from({ length: 6 }, () =>
        a.call("post", "/friends/reports").send({ username: b.username, reason: "spam" }),
      ),
    );
    expect(
      await h.t.db.query(
        "SELECT 1 FROM reports WHERE reporter_id = $1 AND reported_id = $2 AND status = 'open'",
        [a.id, b.id],
      ),
    ).toHaveLength(1);
  });
});
