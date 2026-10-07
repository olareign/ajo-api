import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { groupsHarness } from "../groups/support.js";
import { createTestApp } from "../support/test-app.js";
import { newIp } from "../support/users.js";
import { ADMIN_PASSWORD, adminHarness, type AdminMember } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof adminHarness>;
let g: ReturnType<typeof groupsHarness>;
let owner: AdminMember;
let support: AdminMember;
let compliance: AdminMember;
let finance: AdminMember;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  h = adminHarness(app);
  g = groupsHarness(app);
  [owner, support, compliance, finance] = [
    await h.member("owner"),
    await h.member("support"),
    await h.member("compliance"),
    await h.member("finance"),
  ];
});
afterAll(async () => {
  await app?.close();
});

const REASON = "Reported by the family as a stolen phone";
const act = async (who: AdminMember, path: string, body: Record<string, unknown> = {}) =>
  who.call("post", path).send({ code: await who.code(), reason: REASON, ...body });

describe("who may do what", () => {
  it("refuses a role the permission it lacks, says so plainly, and records the attempt", async () => {
    const person = await g.f.member();
    await support.call("get", `/kyc/${person.id}`).expect(403);
    await finance
      .call("post", `/users/${person.id}/suspend`)
      .send({ code: await finance.code(), reason: REASON })
      .expect(403);
    await compliance.call("post", `/cases/${randomUUID()}/notes`).send({ note: "x" }).expect(403);
    const denied = await h.audit("WHERE outcome = 'denied' AND admin_email = $1", [support.email]);
    expect(denied.map((r) => r.action)).toContain("denied:kyc:read");
    // A refusal never gets as far as the step-up code, so the person is untouched.
    const [row] = await h.t.db.query("SELECT status FROM users WHERE id = $1", [person.id]);
    expect(row.status).toBe("active");
  });

  it("shows each member only what their role can use", async () => {
    const perms = async (m: AdminMember) =>
      (await m.call("get", "/me").expect(200)).body.permissions as string[];
    expect(await perms(support)).not.toContain("audit:read");
    expect(await perms(finance)).toContain("cases:write");
    expect(await perms(compliance)).toContain("kyc:decide");
    expect(await perms(owner)).toContain("team:manage");
    await support.call("get", "/overview").expect(200);
  });
});

describe("looking people up", () => {
  it("finds by whole email or the start of a username, never by a wildcard, and records each look", async () => {
    const person = await g.f.member();
    const byEmail = await support
      .call("get", `/users/search?q=${encodeURIComponent(person.email)}`)
      .expect(200);
    expect(byEmail.body.map((p: { id: string }) => p.id)).toEqual([person.id]);
    const byName = await support
      .call("get", `/users/search?q=${person.username.slice(0, 8)}`)
      .expect(200);
    expect(byName.body.map((p: { id: string }) => p.id)).toContain(person.id);
    expect((await support.call("get", "/users/search?q=%25%25%25").expect(200)).body).toEqual([]);
    expect((await support.call("get", "/users/search?q=_____").expect(200)).body).toEqual([]);
    await support.call("get", "/users/search?q=ab").expect(400);
    const looks = await h.audit("WHERE action = 'user.search' AND admin_email = $1", [
      support.email,
    ]);
    expect(looks.length).toBeGreaterThanOrEqual(4);
  });

  it("shows a person's standing and what they hold, and records that it was looked at", async () => {
    const person = await g.person("2500000");
    const res = await support.call("get", `/users/${person.id}`).expect(200);
    expect(res.body).toMatchObject({ id: person.id, status: "active", country: "NG" });
    expect(res.body.balances.find((b: { kind: string }) => b.kind === "available").amount).toBe(
      "2500000",
    );
    expect(res.body).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(res.body)).not.toMatch(/password|secret|hash/i);
    await support.call("get", `/users/${randomUUID()}`).expect(404);
    await support.call("get", "/users/not-a-uuid").expect(400);
    const rows = await h.audit("WHERE action = 'user.view' AND target_id = $1", [person.id]);
    expect(rows).toHaveLength(1);
  });
});

describe("suspending and reinstating", () => {
  it("needs a fresh code and a reason, ends every session at once, and keeps the person out", async () => {
    const person = await g.f.member();
    await person.call("get", "/me").expect(200);
    await support.call("post", `/users/${person.id}/suspend`).send({ reason: REASON }).expect(400);
    await support
      .call("post", `/users/${person.id}/suspend`)
      .send({ code: "000000", reason: REASON })
      .expect(401);
    await support
      .call("post", `/users/${person.id}/suspend`)
      .send({ code: await support.code(), reason: "no" })
      .expect(400);
    await act(support, `/users/${person.id}/suspend`).then((r) => expect(r.status).toBe(204));
    await person.call("get", "/me").expect(401);
    const login = await request(g.t.http())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .send({ email: person.email, password: "correct horse battery staple" });
    expect(login.status).toBe(401);
    const [row] = await h.t.db.query("SELECT status, status_note FROM users WHERE id = $1", [
      person.id,
    ]);
    expect(row).toEqual({ status: "suspended", status_note: REASON });
    // Their money is untouched.
    const detail = await support.call("get", `/users/${person.id}`).expect(200);
    expect(detail.body.statusNote).toBe(REASON);
    const logged = await h.audit("WHERE action = 'user.suspend' AND target_id = $1", [person.id]);
    expect(logged[0]).toMatchObject({
      outcome: "ok",
      admin_email: support.email,
      detail: { reason: REASON },
    });
  });

  it("will not use the same code twice, and counts a wrong one toward a lock", async () => {
    const [a, b] = [await g.f.member(), await g.f.member()];
    const code = await support.code();
    await support.call("post", `/users/${a.id}/suspend`).send({ code, reason: REASON }).expect(204);
    await support.call("post", `/users/${b.id}/suspend`).send({ code, reason: REASON }).expect(401);
    const [row] = await h.t.db.query("SELECT status FROM users WHERE id = $1", [b.id]);
    expect(row.status).toBe("active");
  });

  it("lets only compliance and the owner reinstate, and only someone who is suspended", async () => {
    const person = await g.f.member();
    await act(support, `/users/${person.id}/suspend`).then((r) => expect(r.status).toBe(204));
    await act(support, `/users/${person.id}/reinstate`).then((r) => expect(r.status).toBe(403));
    await act(compliance, `/users/${person.id}/reinstate`).then((r) => expect(r.status).toBe(204));
    const again = await act(compliance, `/users/${person.id}/reinstate`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("not_suspended");
    await act(support, `/users/${person.id}/suspend`).then((r) => expect(r.status).toBe(204));
    await g.t.db.query("UPDATE users SET status = 'closed' WHERE id = $1", [person.id]);
    expect((await act(owner, `/users/${person.id}/reinstate`)).status).toBe(409);
    const closed = await g.f.member();
    await g.t.db.query("UPDATE users SET status = 'closed' WHERE id = $1", [closed.id]);
    expect((await act(support, `/users/${closed.id}/suspend`)).body.code).toBe("not_active");
  });
});

describe("the identity review queue", () => {
  it("lists people with a step waiting, and shows their steps with no documents (none are stored yet)", async () => {
    const person = await g.f.member({ kyc: false });
    await g.t.db.query(
      `INSERT INTO kyc_steps (user_id, step, status) VALUES ($1, 'id', 'pending'), ($1, 'selfie', 'approved')`,
      [person.id],
    );
    const queue = await compliance.call("get", "/kyc").expect(200);
    const mine = queue.body.find((q: { id: string }) => q.id === person.id);
    expect(mine).toMatchObject({ waitingSteps: 1 });
    const detail = await compliance.call("get", `/kyc/${person.id}`).expect(200);
    expect(detail.body.documents).toEqual([]);
    expect(detail.body.steps.find((s: { step: string }) => s.step === "id").status).toBe("pending");
    expect(detail.body.steps.find((s: { step: string }) => s.step === "address").status).toBe(
      "not_started",
    );
  });

  it("decides a waiting step once, with a reason, and not one already decided or never sent", async () => {
    const person = await g.f.member({ kyc: false });
    await g.t.db.query(
      `INSERT INTO kyc_steps (user_id, step, status) VALUES ($1, 'id', 'pending'), ($1, 'selfie', 'approved')`,
      [person.id],
    );
    expect(
      (
        await act(compliance, `/kyc/${person.id}/steps/id`, {
          decision: "rejected",
          reason: "Photo is cut off at the edge",
        })
      ).status,
    ).toBe(204);
    const [row] = await h.t.db.query(
      "SELECT status, reason FROM kyc_steps WHERE user_id = $1 AND step = 'id'",
      [person.id],
    );
    expect(row).toEqual({ status: "rejected", reason: "Photo is cut off at the edge" });
    expect(
      (await act(compliance, `/kyc/${person.id}/steps/id`, { decision: "approved" })).body.code,
    ).toBe("step_decided");
    expect(
      (await act(compliance, `/kyc/${person.id}/steps/selfie`, { decision: "rejected" })).body.code,
    ).toBe("step_decided");
    expect(
      (await act(compliance, `/kyc/${person.id}/steps/address`, { decision: "approved" })).body
        .code,
    ).toBe("step_not_found");
    expect(
      (await act(compliance, `/kyc/${person.id}/steps/passport`, { decision: "approved" })).body
        .code,
    ).toBe("step_not_found");
    expect(
      (await act(support, `/kyc/${person.id}/steps/id`, { decision: "approved" })).status,
    ).toBe(403);
  });

  it("approves or holds a person by hand, clears it, and keeps the database's own log as well as ours", async () => {
    const person = await g.f.member({ kyc: false });
    expect((await person.call("get", "/kyc").expect(200)).body.status).not.toBe("approved");
    await act(compliance, `/kyc/${person.id}/override`, { action: "approve" }).then((r) =>
      expect(r.status).toBe(204),
    );
    expect((await person.call("get", "/kyc").expect(200)).body).toMatchObject({
      status: "approved",
      via: "waived",
    });
    await act(compliance, `/kyc/${person.id}/override`, { action: "deny" }).then((r) =>
      expect(r.status).toBe(204),
    );
    expect((await person.call("get", "/kyc").expect(200)).body.via).toBe("hold");
    await act(owner, `/kyc/${person.id}/override`, { action: "clear" }).then((r) =>
      expect(r.status).toBe(204),
    );
    const log = await h.t.db.query(
      "SELECT previous_value, new_value FROM kyc_override_log WHERE user_id = $1 ORDER BY id",
      [person.id],
    );
    expect(log.map((l: { new_value: string | null }) => l.new_value)).toEqual([
      "approved",
      "denied",
      null,
    ]);
    const ours = await h.audit("WHERE action = 'kyc.override' AND target_id = $1", [person.id]);
    expect(ours.map((r) => (r.detail as { to: string | null }).to)).toEqual([
      "approved",
      "denied",
      null,
    ]);
  });
});

describe("recovery cases", () => {
  /** A circle whose member missed a payment: the case a person has to work. */
  async function aCase() {
    const maker = await g.person("10000000", { trust: true });
    const missed = await g.person("10000000", { name: "Tunde Missed" });
    const circle = await g.create(maker);
    const [row] = await g.t.db.query(
      `INSERT INTO recovery_cases (group_id, member_id, round_no, amount_owed, covered_by_deposit)
       VALUES ($1, $2, 1, 500000, 200000) RETURNING id`,
      [circle.id, missed.id],
    );
    return { id: row.id as string, missed, circle };
  }

  it("lists open cases and shows one with the missed amount, what the deposit covered and the member's details", async () => {
    const c = await aCase();
    const list = await finance.call("get", "/cases").expect(200);
    expect(list.body.map((x: { id: string }) => x.id)).toContain(c.id);
    const detail = await finance.call("get", `/cases/${c.id}`).expect(200);
    expect(detail.body).toMatchObject({
      status: "open",
      amountOwed: "500000",
      coveredByDeposit: "200000",
      stillOwed: "300000",
      member: { id: c.missed.id, name: "Tunde Missed" },
      memberDetails: { country: "NG", accountStatus: "active" },
    });
    expect(detail.body.memberDetails.kycStatus).toBeTruthy();
    await support.call("get", `/cases/${c.id}`).expect(200);
    await finance.call("get", "/cases?status=nonsense").expect(400);
  });

  it("keeps notes by name, closes a case once with an outcome and a reason, and moves no money", async () => {
    const c = await aCase();
    const before = await support.call("get", `/users/${c.missed.id}`).expect(200);
    await finance
      .call("post", `/cases/${c.id}/notes`)
      .send({ note: "Called, promised to pay on Friday." })
      .expect(204);
    expect(
      (
        await act(finance, `/cases/${c.id}/close`, {
          outcome: "resolved",
          reason: "Paid in full by bank transfer",
        })
      ).status,
    ).toBe(204);
    const detail = await finance.call("get", `/cases/${c.id}`).expect(200);
    expect(detail.body.status).toBe("resolved");
    expect(detail.body.notes.map((n: { note: string }) => n.note)).toEqual([
      "Called, promised to pay on Friday.",
      "Closed as resolved: Paid in full by bank transfer",
    ]);
    expect(detail.body.notes[0].by).toBe("Staff finance");
    const second = await act(finance, `/cases/${c.id}/close`, { outcome: "written_off" });
    expect(second.body.code).toBe("case_closed");
    const after = await support.call("get", `/users/${c.missed.id}`).expect(200);
    expect(after.body.balances).toEqual(before.body.balances);
    expect(
      (await finance.call("get", "/cases?status=resolved").expect(200)).body.map(
        (x: { id: string }) => x.id,
      ),
    ).toContain(c.id);
  });
});

describe("the audit log", () => {
  it("is for compliance and the owner, newest first, narrowed by who, what or which target, a page at a time", async () => {
    await finance.call("get", "/audit").expect(403);
    await support.call("get", "/audit").expect(403);
    const person = await g.f.member();
    await support.call("get", `/users/${person.id}`).expect(200);
    const page = await compliance.call("get", `/audit?target=${person.id}`).expect(200);
    expect(page.body.items.map((i: { action: string }) => i.action)).toEqual(["user.view"]);
    const mine = await owner.call("get", `/audit?admin=${support.email}&action=user.`).expect(200);
    expect(
      mine.body.items.every(
        (i: { admin_email: string; action: string }) =>
          i.admin_email === support.email && i.action.startsWith("user."),
      ),
    ).toBe(true);
    const first = await owner.call("get", "/audit").expect(200);
    expect(first.body.items.length).toBe(50);
    expect(first.body.next).toBeTruthy();
    const second = await owner.call("get", `/audit?before=${first.body.next}`).expect(200);
    expect(Number(second.body.items[0].id)).toBeLessThan(Number(first.body.next));
    // Reading the log is itself kept in it.
    const reads = await h.audit("WHERE action = 'audit.view' AND admin_email = $1", [owner.email]);
    expect(reads.length).toBeGreaterThanOrEqual(1);
  });

  it("cannot be changed or emptied by anyone, not even with direct access to the database", async () => {
    await expect(
      h.t.db.query(
        "UPDATE admin_audit SET outcome = 'ok' WHERE id = (SELECT min(id) FROM admin_audit)",
      ),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      h.t.db.query("DELETE FROM admin_audit WHERE id = (SELECT min(id) FROM admin_audit)"),
    ).rejects.toThrow(/cannot be changed/);
    await expect(h.t.db.query("TRUNCATE admin_audit")).rejects.toThrow(/cannot be changed/);
  });

  it("never holds a password, a code, a token or a secret", async () => {
    const rows = JSON.stringify(await h.audit());
    expect(rows).not.toContain(ADMIN_PASSWORD);
    for (const m of [owner, support, compliance, finance]) {
      expect(rows).not.toContain(m.secret);
      expect(rows).not.toContain(m.token);
    }
  });
});

describe("managing the team", () => {
  it("is the owner's alone, needs a fresh code, and hands back a setup code once", async () => {
    await support.call("get", "/team").expect(403);
    await support
      .call("post", "/team")
      .send({ email: "x@ajo.test", name: "X", role: "support", code: await support.code() })
      .expect(403);
    const email = `new-${randomUUID().slice(0, 8)}@ajo.test`;
    await owner
      .call("post", "/team")
      .send({ email, name: "New", role: "support", code: "000000" })
      .expect(401);
    const made = await owner
      .call("post", "/team")
      .send({ email, name: "New", role: "support", code: await owner.code() })
      .expect(201);
    expect(made.body.setupCode).toMatch(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
    const listed = (await owner.call("get", "/team").expect(200)).body;
    const row = listed.find((m: { email: string }) => m.email === email);
    expect(row).toMatchObject({ role: "support", status: "invited" });
    expect(JSON.stringify(listed)).not.toContain(made.body.setupCode);
    const dup = await owner
      .call("post", "/team")
      .send({ email, name: "New", role: "owner", code: await owner.code() });
    expect(dup.status).toBe(409);
    await owner
      .call("post", "/team")
      .send({ email: "bad@ajo.test", name: "X", role: "root", code: await owner.code() })
      .expect(400);
    const stored = await h.t.db.query("SELECT setup_token_hash FROM admin_users WHERE email = $1", [
      email,
    ]);
    expect(stored[0].setup_token_hash).not.toContain(made.body.setupCode.replaceAll("-", ""));
  });

  it("wipes a lost authenticator and password on reissue, ends their sessions, and the old details stop working", async () => {
    const lost = await h.member("support");
    const reissued = await owner
      .call("post", `/team/${lost.id}/reissue`)
      .send({ code: await owner.code() })
      .expect(201);
    await lost.call("get", "/me").expect(401);
    await h
      .api("post", "/auth/login")
      .send({ email: lost.email, password: ADMIN_PASSWORD, code: await lost.code() })
      .expect(401);
    const started = await h
      .api("post", "/auth/setup/start")
      .send({ email: lost.email, setupCode: reissued.body.setupCode, password: ADMIN_PASSWORD })
      .expect(200);
    expect(started.body.secret).not.toBe(lost.secret);
  });

  it("turns a member off at once, but never yourself or the last owner", async () => {
    const leaver = await h.member("finance");
    await owner
      .call("post", `/team/${leaver.id}/disable`)
      .send({ code: await owner.code() })
      .expect(204);
    await leaver.call("get", "/me").expect(401);
    await h
      .api("post", "/auth/login")
      .send({ email: leaver.email, password: ADMIN_PASSWORD, code: await leaver.code() })
      .expect(401);
    expect(
      (await owner.call("post", `/team/${owner.id}/disable`).send({ code: await owner.code() }))
        .body.code,
    ).toBe("admin_self");
    expect(
      (await owner.call("post", `/team/${owner.id}/reissue`).send({ code: await owner.code() }))
        .body.code,
    ).toBe("admin_self");
  });

  it("never leaves the team with no owner, even when two owners turn each other off at the same moment", async () => {
    const [a, b] = [await h.member("owner"), await h.member("owner")];
    await h.t.db.query(
      "UPDATE admin_users SET status = 'disabled' WHERE role = 'owner' AND id NOT IN ($1, $2)",
      [a.id, b.id],
    );
    const [codeA, codeB] = [await a.code(), await b.code()];
    const results = await Promise.all([
      a.call("post", `/team/${b.id}/disable`).send({ code: codeA }),
      b.call("post", `/team/${a.id}/disable`).send({ code: codeB }),
    ]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([204, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("admin_last_owner");
    const [left] = await h.t.db.query(
      "SELECT count(*)::int AS n FROM admin_users WHERE role = 'owner' AND status = 'active'",
    );
    expect(left.n).toBe(1);
  });
});
