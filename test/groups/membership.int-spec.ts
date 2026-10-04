import type { NestExpressApplication } from "@nestjs/platform-express";
import { addDays, todayIn } from "../../src/savings/savings-rules.js";
import { createTestApp } from "../support/test-app.js";
import { groupsHarness, key, type Member } from "./support.js";

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

describe("leaving and calling off", () => {
  it("lets a member leave before it fills, returns their deposit, frees the place and tells the maker; they can come back", async () => {
    const maker = await h.person();
    const leaver = await h.person();
    const g = await h.create(maker, { size: 4 });
    await h.join(leaver, g.inviteCode!).expect(200);
    expect(await h.t.balance(leaver.id)).toBe("9500000");
    const left = await leaver.call("post", `/groups/${g.id}/leave`).expect(200);
    expect(left.body.isMember).toBe(false);
    expect(await h.t.balance(leaver.id)).toBe("10000000");
    expect(await h.locked(leaver.id, g.id)).toBe("0");
    expect((await h.detail(maker, g.id)).memberCount).toBe(1);
    expect((await h.notices(maker.id)).some((n: { kind: string }) => n.kind === "group.left")).toBe(
      true,
    );
    // Leaving twice changes nothing, and they can rejoin.
    await leaver.call("post", `/groups/${g.id}/leave`).expect(200);
    await h.join(leaver, g.inviteCode!).expect(200);
    expect(await h.t.balance(leaver.id)).toBe("9500000");
    expect((await h.detail(maker, g.id)).memberCount).toBe(2);
  });

  it("returns a deposit once when leaving is sent many times at once", async () => {
    const maker = await h.person();
    const leaver = await h.person();
    const g = await h.create(maker, { size: 4 });
    await h.join(leaver, g.inviteCode!).expect(200);
    await many(6, () => leaver.call("post", `/groups/${g.id}/leave`));
    expect(await h.t.balance(leaver.id)).toBe("10000000");
  });

  it("will not let the maker leave, or anyone once it is full", async () => {
    const maker = await h.person();
    const other = await h.person();
    const g = await h.create(maker, { size: 3 });
    expect((await maker.call("post", `/groups/${g.id}/leave`)).body.code).toBe(
      "creator_cannot_leave",
    );
    await h.join(other, g.inviteCode!).expect(200);
    await h.join(await h.person(), g.inviteCode!).expect(200);
    expect((await other.call("post", `/groups/${g.id}/leave`)).body.code).toBe("group_locked");
  });

  it("lets the maker call it off while open: everyone is told and every deposit is returned, once", async () => {
    const maker = await h.person();
    const [a, b] = [await h.person(), await h.person()];
    const g = await h.create(maker, { size: 5 });
    await h.join(a, g.inviteCode!).expect(200);
    await h.join(b, g.inviteCode!).expect(200);
    const sends = await many(5, () => maker.call("post", `/groups/${g.id}/cancel`));
    expect(sends.every((r) => r.status === 200)).toBe(true);
    expect((await h.row(g.id)).status).toBe("cancelled");
    for (const p of [maker, a, b]) {
      expect(await h.t.balance(p.id)).toBe("10000000");
      expect(await h.locked(p.id, g.id)).toBe("0");
      expect(
        (await h.notices(p.id)).filter((n: { kind: string }) => n.kind === "group.cancelled"),
      ).toHaveLength(1);
    }
    expect((await a.call("post", `/groups/${g.id}/cancel`)).status).toBe(404);
    await h.join(await h.person(), g.inviteCode!).expect(409);
  });

  it("never loses a deposit when people join, leave and the maker calls it off all at once", async () => {
    for (let round = 0; round < 3; round += 1) {
      const maker = await h.person();
      const crowd = await many(5, () => h.person());
      const g = await h.create(maker, { size: 8 });
      await Promise.all([
        ...crowd.map((p) => h.join(p, g.inviteCode!)),
        ...crowd.slice(0, 2).map((p) => p.call("post", `/groups/${g.id}/leave`)),
        maker.call("post", `/groups/${g.id}/cancel`),
      ]);
      // However it interleaved, everyone's money is all accounted for: wallet plus deposit is what they started with.
      for (const p of [maker, ...crowd]) {
        expect(BigInt(await h.t.balance(p.id)) + BigInt(await h.locked(p.id, g.id))).toBe(
          10_000_000n,
        );
      }
      const row = await h.row(g.id);
      if (row.status === "cancelled") {
        for (const p of [maker, ...crowd]) expect(await h.locked(p.id, g.id)).toBe("0");
      }
    }
  });

  it("will not call off a circle that is full", async () => {
    const maker = await h.person();
    const g = await h.filled(maker, [await h.person(), await h.person()]);
    expect((await maker.call("post", `/groups/${g.id}/cancel`)).body.code).toBe("group_locked");
  });

  it("calls off a circle that has not filled by its first round, returning every deposit", async () => {
    const maker = await h.person();
    const joiner = await h.person();
    const g = await h.create(maker, { size: 4 });
    await h.join(joiner, g.inviteCode!).expect(200);
    await h.t.db.query("UPDATE groups SET start_date = $2 WHERE id = $1", [g.id, todayIn("NGN")]);
    await many(4, () => h.runner.expireUnfilled());
    expect((await h.row(g.id)).status).toBe("cancelled");
    expect(await h.t.balance(maker.id)).toBe("10000000");
    expect(await h.t.balance(joiner.id)).toBe("10000000");
    expect(
      (await h.notices(joiner.id)).filter((n: { kind: string }) => n.kind === "group.cancelled"),
    ).toHaveLength(1);
  });

  it("keeps the auto-debit from being cancelled while in a circle, and frees it when the circle is over", async () => {
    const maker = await h.person();
    const g = await h.create(maker, { size: 3 });
    const blocked = await maker.call("delete", "/payments/mandate");
    expect([blocked.status, blocked.body.code]).toEqual([409, "active_commitments"]);
    await maker.call("post", `/groups/${g.id}/cancel`).expect(200);
    await maker.call("delete", "/payments/mandate").expect(200);
  });
});

describe("inviting a friend", () => {
  it("tells only a friend, with a way in, and only about a circle still open, from a member", async () => {
    const maker = await h.person();
    const friend = await h.person();
    const stranger = await h.person();
    await h.f.befriend(maker, friend);
    const g = await h.create(maker, { size: 4, name: "Cousins" });
    await maker
      .call("post", `/groups/${g.id}/invite`)
      .send({ username: friend.username })
      .expect(204);
    await maker
      .call("post", `/groups/${g.id}/invite`)
      .send({ username: friend.username })
      .expect(204);
    const sent = (await h.notices(friend.id)).filter(
      (n: { kind: string }) => n.kind === "group.invite",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toMatch(/invited you to Cousins/);
    const [{ link }] = await h.t.db.query(
      "SELECT link FROM notifications WHERE user_id = $1 AND kind = 'group.invite'",
      [friend.id],
    );
    expect(link).toBe(`/circles/join/${g.inviteCode}`);
    expect(
      (await maker.call("post", `/groups/${g.id}/invite`).send({ username: stranger.username }))
        .body.code,
    ).toBe("not_a_friend");
    expect(
      (await stranger.call("post", `/groups/${g.id}/invite`).send({ username: friend.username }))
        .status,
    ).toBe(404);
    await maker.call("post", `/groups/${g.id}/invite`).send({ username: "x" }).expect(400);
  });
});

describe("swapping turns", () => {
  async function running() {
    const [maker, b, c] = [
      await h.person("10000000", { trust: true }),
      await h.person("10000000", { trust: true }),
      await h.person("10000000", { trust: true }),
    ];
    const g = await h.filled(maker, [b, c], { size: 3 });
    return { g, maker, b, c };
  }
  const spotOf = async (id: string, who: Member) =>
    (await h.members(id)).find((m: { user_id: string }) => m.user_id === who.id).spot as number;

  it("swaps two members' turns, and who is paid in each round, when the other says yes", async () => {
    const { g, maker, b, c } = await running();
    await maker.call("post", `/groups/${g.id}/swaps`).send({ username: c.username }).expect(200);
    expect((await c.call("get", `/groups/${g.id}/swaps`).expect(200)).body).toMatchObject([
      { fromUsername: maker.username, incoming: true },
    ]);
    expect((await maker.call("get", `/groups/${g.id}/swaps`).expect(200)).body[0].incoming).toBe(
      false,
    );
    const [swap] = (await c.call("get", `/groups/${g.id}/swaps`)).body;
    await b
      .call("post", `/groups/${g.id}/swaps/${swap.id}/answer`)
      .send({ accept: true })
      .expect(404);
    await c
      .call("post", `/groups/${g.id}/swaps/${swap.id}/answer`)
      .send({ accept: true })
      .expect(200);
    expect(await spotOf(g.id, maker)).toBe(3);
    expect(await spotOf(g.id, c)).toBe(1);
    const rounds = await h.rounds(g.id);
    expect(rounds.map((r: { recipient_id: string }) => r.recipient_id)).toEqual([
      c.id,
      b.id,
      maker.id,
    ]);
    expect((await maker.call("get", `/groups/${g.id}/swaps`)).body).toEqual([]);
  });

  it("does nothing when the answer is no, or the answer is sent twice at once", async () => {
    const { g, maker, b, c } = await running();
    await maker.call("post", `/groups/${g.id}/swaps`).send({ username: b.username }).expect(200);
    const [no] = (await b.call("get", `/groups/${g.id}/swaps`)).body;
    await b
      .call("post", `/groups/${g.id}/swaps/${no.id}/answer`)
      .send({ accept: false })
      .expect(200);
    expect(await spotOf(g.id, maker)).toBe(1);
    await maker.call("post", `/groups/${g.id}/swaps`).send({ username: c.username }).expect(200);
    const [yes] = (await c.call("get", `/groups/${g.id}/swaps`)).body;
    await many(5, () =>
      c.call("post", `/groups/${g.id}/swaps/${yes.id}/answer`).send({ accept: true }),
    );
    expect(await spotOf(g.id, maker)).toBe(3);
    expect(await spotOf(g.id, c)).toBe(1);
  });

  it("is closed once the first round has begun, and to people outside the circle", async () => {
    const { g, maker, b } = await running();
    await h.dueRound(g.id, 1);
    const late = await maker.call("post", `/groups/${g.id}/swaps`).send({ username: b.username });
    expect([late.status, late.body.code]).toEqual([409, "swap_unavailable"]);
    const outsider = await h.person();
    expect(
      (await outsider.call("post", `/groups/${g.id}/swaps`).send({ username: b.username })).status,
    ).toBe(404);
    expect(
      (await maker.call("post", `/groups/${g.id}/swaps`).send({ username: outsider.username })).body
        .code,
    ).toBe("not_a_member");
  });

  it("asks an untrusted member moving into an early turn for the larger deposit, and refuses if their wallet cannot", async () => {
    const maker = await h.person("10000000", { trust: true });
    const poor = await h.person("700000");
    const c = await h.person("10000000", { trust: true });
    const g = await h.filled(maker, [poor, c], { size: 3 });
    // Three turns: turn 1 is early and held by the (trusted) maker. `poor` holds a late turn.
    expect(await spotOf(g.id, poor)).toBeGreaterThan(1);
    await poor.call("post", `/groups/${g.id}/swaps`).send({ username: maker.username }).expect(200);
    const [swap] = (await maker.call("get", `/groups/${g.id}/swaps`)).body;
    const res = await maker
      .call("post", `/groups/${g.id}/swaps/${swap.id}/answer`)
      .send({ accept: true });
    expect([res.status, res.body.code]).toEqual([409, "deposit_needed"]);
    expect(await spotOf(g.id, maker)).toBe(1);
  });
});

describe("finding a circle to join", () => {
  it("lists open public circles, those with your friends in them first, and never private, full, joined or blocked ones", async () => {
    const me = await h.person("10000000", { trust: true });
    const friend = await h.person();
    await h.f.befriend(me, friend);
    const maker = await h.person();
    const stranger = await h.person();
    const mk = (who: Member, over: Record<string, unknown> = {}) =>
      h.create(who, { visibility: "public", size: 5, ...over });
    const plain = await mk(maker, { name: "Plain" });
    const withFriend = await mk(stranger, { name: "With a friend" });
    await h.join(friend, withFriend.inviteCode!).expect(200);
    const priv = await mk(maker, { name: "Hidden", visibility: "private" });
    const joined = await mk(maker, { name: "Already in" });
    await h.join(me, joined.inviteCode!).expect(200);
    const nope = await h.person();
    const blockedMaker = await h.person();
    await me.call("post", "/friends/blocks").send({ username: blockedMaker.username }).expect(204);
    const blockedGroup = await mk(blockedMaker, { name: "Blocked" });
    void nope;
    const full = await h.filled(maker, [await h.person(), await h.person()], {
      visibility: "public",
      name: "Full",
      size: 3,
    });

    const found = (await me.call("get", "/groups/discover").expect(200)).body.groups as {
      id: string;
      name: string;
      score: number;
      friendsIn: number;
    }[];
    const names = found.map((g) => g.name);
    expect(names[0]).toBe("With a friend");
    expect(found[0]).toMatchObject({ friendsIn: 1 });
    expect(found[0]!.score).toBeGreaterThanOrEqual(10);
    expect(names).toContain("Plain");
    for (const hidden of [priv.id, joined.id, blockedGroup.id, full.id])
      expect(found.map((g) => g.id)).not.toContain(hidden);
    expect(found.map((g) => g.id)).toContain(plain.id);
  });

  it("ranks a circle that fits your own saving, then one with a friend of a friend, above a stranger's", async () => {
    const me = await h.person("10000000", { trust: true });
    const friend = await h.person();
    const friendOfFriend = await h.person();
    await h.f.befriend(me, friend);
    await h.f.befriend(friend, friendOfFriend);
    const [a, b] = [
      await h.person("10000000", { trust: true }),
      await h.person("10000000", { trust: true }),
    ];
    const viaFof = await h.create(a, {
      visibility: "public",
      name: "Via fof",
      size: 6,
      contribution: "9000000",
    });
    await h.join(friendOfFriend, viaFof.inviteCode!).expect(200);
    const fits = await h.create(b, {
      visibility: "public",
      name: "Fits my saving",
      size: 6,
      contribution: "3000000",
    });
    const neither = await h.create(a, {
      visibility: "public",
      startDate: addDays(todayIn("NGN"), 1),
      name: "Neither",
      size: 6,
      contribution: "9000000",
    });
    // A saving plan of 2,000,000 a time fits a 3,000,000 circle (between half and double).
    await me
      .call("post", "/savings")
      .set("Idempotency-Key", key())
      .send({
        name: "Rent",
        amount: "2000000",
        frequency: "weekly",
        totalDebits: 4,
        startDate: addDays(todayIn("NGN"), 1),
      })
      .expect(201);
    const found = (await me.call("get", "/groups/discover").expect(200)).body.groups as {
      id: string;
      name: string;
      score: number;
    }[];
    const order = found.map((g) => g.id);
    expect(order.indexOf(fits.id)).toBeLessThan(order.indexOf(viaFof.id));
    expect(found.find((g) => g.id === viaFof.id)!.score).toBeGreaterThan(0);
    for (const g of found.filter((x) => x.id === neither.id)) expect(g.score).toBe(0);
    expect(found.find((g) => g.id === fits.id)!.score).toBe(3);
    expect(found.find((g) => g.id === viaFof.id)!.score).toBe(2);
  });

  it("only offers circles in your own currency", async () => {
    const uk = await h.person("10000000");
    await h.t.db.query("UPDATE users SET country = 'GB' WHERE id = $1", [uk.id]);
    const found = (await uk.call("get", "/groups/discover").expect(200)).body.groups as {
      currency: string;
    }[];
    expect(found.every((g) => g.currency === "GBP")).toBe(true);
  });
});
