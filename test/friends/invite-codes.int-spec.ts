import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import request from "supertest";
import { createTestApp } from "../support/test-app.js";
import { GOOD_PASSWORD, newIp, uniqueEmail } from "../support/users.js";
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

/** A code nobody else in the shared test database has used. */
const fresh = (prefix = "C") => `${prefix}-${randomBytes(4).toString("hex")}`.toUpperCase();
const whose = (code: string) => request(h.t.http()).get(`/api/v1/invites/${code}`);

describe("choosing your own invite code", () => {
  it("sets it in capitals, gives the new link, and the old link stops working at once", async () => {
    const me = await h.member();
    const { code: old } = (await me.call("get", "/friends/invite").expect(200)).body;
    const wanted = fresh("Ada");
    const res = await me
      .call("put", "/friends/invite")
      .send({ code: wanted.toLowerCase() })
      .expect(200);
    expect(res.body.code).toBe(wanted);
    expect(res.body.link).toMatch(new RegExp(`/join/${wanted}$`));
    expect((await me.call("get", "/friends/invite").expect(200)).body.code).toBe(wanted);
    await whose(old).expect(404);
    await whose(wanted.toLowerCase()).expect(200);
  });

  it("refuses a malformed code, and words that are reserved, impersonate the app or offend, with one answer", async () => {
    const me = await h.member();
    const bad = await me.call("put", "/friends/invite").send({ code: "a b!" }).expect(400);
    expect(bad.body.code ?? bad.body.message).toBeTruthy();
    for (const code of ["AJO-SUPPORT", "ADMIN-1", "JOIN"]) {
      const res = await me.call("put", "/friends/invite").send({ code }).expect(409);
      expect(res.body.code).toBe("code_unavailable");
    }
  });

  it("will not hand out a code someone else holds, or one someone gave up in the last 90 days", async () => {
    const [a, b] = [await h.member(), await h.member()];
    const first = fresh();
    await a.call("put", "/friends/invite").send({ code: first }).expect(200);
    expect(
      (await b.call("put", "/friends/invite").send({ code: first }).expect(409)).body.code,
    ).toBe("code_unavailable");
    // a moves on; the code a gave up is still held for a, not free for b.
    await a.call("put", "/friends/invite").send({ code: fresh() }).expect(200);
    await b.call("put", "/friends/invite").send({ code: first }).expect(409);
    // a can take it back.
    await a.call("put", "/friends/invite").send({ code: first }).expect(200);
  });

  it("allows three changes in thirty days, and choosing the same code again is not a change", async () => {
    const me = await h.member();
    const codes = [fresh(), fresh(), fresh()];
    for (const code of codes) await me.call("put", "/friends/invite").send({ code }).expect(200);
    await me.call("put", "/friends/invite").send({ code: codes[2] }).expect(200);
    const res = await me.call("put", "/friends/invite").send({ code: fresh() }).expect(429);
    expect(res.body.code).toBe("code_change_limit");
    expect((await me.call("get", "/friends/invite").expect(200)).body.code).toBe(codes[2]);
  });

  it("gives a code to exactly one of two people asking for it at the same moment", async () => {
    const [a, b] = [await h.member(), await h.member()];
    const code = fresh();
    const [ra, rb] = await Promise.all([
      a.call("put", "/friends/invite").send({ code }),
      b.call("put", "/friends/invite").send({ code }),
    ]);
    expect([ra.status, rb.status].sort((x, y) => x - y)).toEqual([200, 409]);
    const owners = await h.t.db.query("SELECT user_id FROM invite_links WHERE code = $1", [code]);
    expect(owners).toHaveLength(1);
  });

  it("records who joined through a custom code, and lists them for the inviter, newest first", async () => {
    const inviter = await h.member();
    const code = fresh("Joinme");
    await inviter.call("put", "/friends/invite").send({ code }).expect(200);
    for (const name of ["First Person", "Second Person"]) {
      await request(h.t.http())
        .post("/api/v1/auth/sign-up")
        .set("X-Forwarded-For", newIp())
        .send({
          email: uniqueEmail(),
          password: GOOD_PASSWORD,
          displayName: name,
          invite: code.toLowerCase(),
        })
        .expect(202);
    }
    const list = (await inviter.call("get", "/friends/referrals").expect(200)).body;
    expect(list.map((r: { displayName: string }) => r.displayName)).toEqual([
      "Second Person",
      "First Person",
    ]);
    expect(list[0]).toEqual(
      expect.objectContaining({ username: null, joinedAt: expect.any(String) }),
    );
  });
});
