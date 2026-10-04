import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { addDays, todayIn } from "../../src/savings/savings-rules.js";
import { createTestApp } from "../support/test-app.js";
import { groupsHarness, key } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof groupsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  h = groupsHarness(app);
});
afterAll(async () => {
  await app?.close();
});
afterEach(async () => h.t.expectBooksBalance());

const many = <T>(n: number, make: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => make(i)));

describe("making a circle", () => {
  it("shows the days, the pot and the deposits first, and saves nothing", async () => {
    const who = await h.person();
    const res = await who
      .call("post", "/groups/preview")
      .send(h.body({ size: 6, contribution: "1000000" }))
      .expect(200);
    expect(res.body.dates).toHaveLength(6);
    expect(res.body.pot).toEqual({ amount: "6000000", currency: "NGN" });
    expect(res.body.deposit).toEqual({ amount: "1000000", currency: "NGN" });
    expect(res.body.earlyDeposit).toEqual({ amount: "3000000", currency: "NGN" });
    expect(res.body.earlySpots).toBe(2);
    expect((await who.call("get", "/groups").expect(200)).body.groups).toEqual([]);
  });

  it("makes it with its maker as the first member, who locks a deposit unless they are trusted", async () => {
    const newcomer = await h.person();
    const g = await h.create(newcomer, { size: 4 });
    expect(g).toMatchObject({ status: "open", memberCount: 1, isCreator: true, size: 4 });
    expect(g.inviteCode).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(g.myDeposit).toEqual({ amount: "500000", currency: "NGN" });
    expect(await h.t.balance(newcomer.id)).toBe("9500000");

    const veteran = await h.person("10000000", { trust: true });
    const g2 = await h.create(veteran);
    expect(g2.myDeposit).toEqual({ amount: "0", currency: "NGN" });
    expect(await h.t.balance(veteran.id)).toBe("10000000");
  });

  it("makes one circle however many times the same request is sent, even together", async () => {
    const who = await h.person();
    const k = key();
    const sends = await many(8, () =>
      who.call("post", "/groups").set("Idempotency-Key", k).send(h.body()),
    );
    expect(sends.every((r) => r.status === 201)).toBe(true);
    expect(new Set(sends.map((r) => r.body.id)).size).toBe(1);
    expect((await who.call("get", "/groups").expect(200)).body.groups).toHaveLength(1);
    expect(await h.t.balance(who.id)).toBe("9500000");
    const clash = await who
      .call("post", "/groups")
      .set("Idempotency-Key", k)
      .send(h.body({ contribution: "600000" }));
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("idempotency_key_reused");
  });

  it.each([
    ["a start today", () => ({ startDate: todayIn("NGN") })],
    ["a start in the past", () => ({ startDate: "2020-01-01" })],
    ["too small a contribution", () => ({ contribution: "100" })],
    ["two people", () => ({ size: 2 })],
    ["a nameless circle", () => ({ name: "  " })],
    ["an order we do not have", () => ({ orderMethod: "auction" })],
    ["a stray field", () => ({ creatorId: "x" })],
  ])("refuses %s, and makes nothing", async (_n, over) => {
    const who = await h.person();
    const res = await who
      .call("post", "/groups")
      .set("Idempotency-Key", key())
      .send(h.body(over()));
    expect(res.status).toBe(400);
    expect((await who.call("get", "/groups").expect(200)).body.groups).toEqual([]);
    expect(await h.t.balance(who.id)).toBe("10000000");
  });

  it("asks for a key, verified identity and a signed-in person", async () => {
    const who = await h.person();
    expect((await who.call("post", "/groups").send(h.body())).body.code).toBe(
      "idempotency_key_required",
    );
    const unverified = await h.f.member({ kyc: false });
    const blocked = await unverified
      .call("post", "/groups")
      .set("Idempotency-Key", key())
      .send(h.body());
    expect([blocked.status, blocked.body.code]).toEqual([403, "kyc_required"]);
    await request(h.t.http()).post("/api/v1/groups").send(h.body()).expect(401);
    await request(h.t.http()).get("/api/v1/groups/discover").expect(401);
  });

  it("needs auto-debit, enough in the wallet for the deposit, and no recent default", async () => {
    const noMandate = await h.person("10000000", { mandate: false });
    const a = await noMandate.call("post", "/groups").set("Idempotency-Key", key()).send(h.body());
    expect([a.status, a.body.code]).toEqual([409, "no_mandate"]);

    const poor = await h.person("100000");
    const b = await poor.call("post", "/groups").set("Idempotency-Key", key()).send(h.body());
    expect([b.status, b.body.code]).toEqual([409, "deposit_needed"]);
    expect((await poor.call("get", "/groups").expect(200)).body.groups).toEqual([]);
    expect(await h.t.balance(poor.id)).toBe("100000");

    const defaulter = await h.person();
    await h.t.db.query(
      "INSERT INTO defaulter_blocks (user_id, blocked_until, reason) VALUES ($1, now() + interval '30 days', 'test')",
      [defaulter.id],
    );
    const c = await defaulter.call("post", "/groups").set("Idempotency-Key", key()).send(h.body());
    expect([c.status, c.body.code]).toEqual([403, "defaulter_blocked"]);
  });

  it("keeps a person to five circles, even when they are made together", async () => {
    const who = await h.person("100000000", { trust: true });
    const sends = await many(8, (i) =>
      who
        .call("post", "/groups")
        .set("Idempotency-Key", key())
        .send(h.body({ name: `Circle ${i}` })),
    );
    expect(sends.filter((r) => r.status === 201)).toHaveLength(5);
    expect(
      sends.filter((r) => r.status === 409).every((r) => r.body.code === "too_many_groups"),
    ).toBe(true);
  });

  it("keeps a private circle hidden from anyone not in it, and shows a member everything", async () => {
    const maker = await h.person();
    const outsider = await h.person();
    const g = await h.create(maker);
    await outsider.call("get", `/groups/${g.id}`).expect(404);
    await outsider.call("post", `/groups/${g.id}/join`).expect(404);
    const code = await outsider.call("get", `/groups/code/${g.inviteCode}`).expect(200);
    expect(code.body).toMatchObject({ id: g.id, isMember: false, inviteCode: null });
    expect(code.body.creator.displayName).toBeTruthy();
    const mine = await h.detail(maker, g.id);
    expect(mine.members).toHaveLength(1);
    await outsider.call("get", "/groups/code/ZZZZZZZZ").expect(404);
    await outsider.call("get", "/groups/not-a-uuid").expect(400);
  });

  it("shows a public circle to anyone, with its members hidden until they join", async () => {
    const maker = await h.person();
    const other = await h.person();
    const g = await h.create(maker, { visibility: "public" });
    const seen = (await other.call("get", `/groups/${g.id}`).expect(200)).body;
    expect(seen).toMatchObject({ isMember: false, inviteCode: null, members: [] });
    expect(seen.startDate).toBe(addDays(todayIn("NGN"), 5));
  });
});
