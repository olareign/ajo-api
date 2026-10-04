import type { NestExpressApplication } from "@nestjs/platform-express";
import { placeMembers } from "../../src/groups/draw.js";
import { createTestApp } from "../support/test-app.js";
import { groupsHarness, type Member } from "./support.js";

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
const people = (n: number, options: Parameters<typeof h.person>[1] = {}) =>
  many(n, () => h.person("10000000", options));

describe("joining", () => {
  it("joins with a code, locking the deposit of someone not yet trusted, and tells the maker", async () => {
    const maker = await h.person();
    const joiner = await h.person();
    const g = await h.create(maker, { size: 4 });
    const res = await h.join(joiner, g.inviteCode!).expect(200);
    expect(res.body).toMatchObject({ memberCount: 2, isMember: true });
    expect(res.body.myDeposit.amount).toBe("500000");
    expect(await h.t.balance(joiner.id)).toBe("9500000");
    expect(
      (await h.notices(maker.id)).some((n: { kind: string }) => n.kind === "group.joined"),
    ).toBe(true);
  });

  it("joining twice is joining once", async () => {
    const maker = await h.person();
    const joiner = await h.person();
    const g = await h.create(maker, { size: 4 });
    await many(5, () => h.join(joiner, g.inviteCode!));
    expect(
      (await h.members(g.id)).filter((m: { status: string }) => m.status === "active"),
    ).toHaveLength(2);
    expect(await h.t.balance(joiner.id)).toBe("9500000");
  });

  it("joins a public circle by id, and a private one only with its code", async () => {
    const maker = await h.person();
    const joiner = await h.person();
    const pub = await h.create(maker, { visibility: "public", size: 4 });
    await joiner.call("post", `/groups/${pub.id}/join`).expect(200);
    const priv = await h.create(maker, { size: 4, name: "Private" });
    await joiner.call("post", `/groups/${priv.id}/join`).expect(404);
  });

  it("will not take someone with no auto-debit, too little for the deposit, or a recent default", async () => {
    const maker = await h.person();
    const g = await h.create(maker, { size: 5 });
    const noMandate = await h.person("10000000", { mandate: false });
    expect((await h.join(noMandate, g.inviteCode!)).body.code).toBe("no_mandate");
    const poor = await h.person("1000");
    expect((await h.join(poor, g.inviteCode!)).body.code).toBe("deposit_needed");
    const defaulter = await h.person();
    await h.t.db.query(
      "INSERT INTO defaulter_blocks (user_id, blocked_until, reason) VALUES ($1, now() + interval '30 days', 'x')",
      [defaulter.id],
    );
    expect((await h.join(defaulter, g.inviteCode!)).body.code).toBe("defaulter_blocked");
    expect(await h.t.balance(poor.id)).toBe("1000");
    expect((await h.members(g.id)).length).toBe(1);
  });

  it("will not put someone in a circle with a person who blocked them, or whom they blocked", async () => {
    const maker = await h.person();
    const a = await h.person();
    const b = await h.person();
    const g = await h.create(maker, { size: 5 });
    await h.join(a, g.inviteCode!).expect(200);
    await b.call("post", "/friends/blocks").send({ username: a.username }).expect(204);
    const res = await h.join(b, g.inviteCode!);
    expect([res.status, res.body.code]).toEqual([409, "cannot_join"]);
  });

  it("never takes more people than there are places, however many join at once", async () => {
    for (let round = 0; round < 3; round += 1) {
      const maker = await h.person("100000000");
      const crowd = await people(7);
      const g = await h.create(maker, { size: 3 });
      const results = await many(crowd.length, (i) => h.join(crowd[i]!, g.inviteCode!));
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      expect(
        results
          .filter((r) => r.status === 409)
          .every((r) => ["group_full", "group_locked"].includes(r.body.code)),
      ).toBe(true);
      expect(
        (await h.members(g.id)).filter((m: { status: string }) => m.status === "active"),
      ).toHaveLength(3);
      expect((await h.row(g.id)).status).toBe("running");
      // Those turned away have all their money.
      for (let i = 0; i < crowd.length; i += 1) {
        const inside = results[i]!.status === 200;
        expect(await h.t.balance(crowd[i]!.id)).toBe(inside ? "9500000" : "10000000");
      }
    }
  });
});

describe("a circle that fills in the order people joined", () => {
  it("gives turns in the order of joining, and starts the rounds: one per turn, everyone's payment scheduled", async () => {
    const [maker, b, c, d] = [
      await h.person(),
      await h.person(),
      await h.person(),
      await h.person(),
    ];
    const g = await h.filled(maker, [b, c, d]);
    const detail = await h.detail(maker, g.id);
    expect(detail.status).toBe("running");
    expect(detail.members.map((m) => [m.username, m.spot])).toEqual(
      [maker, b, c, d].map((p, i) => [p.username, i + 1]),
    );
    const rounds = await h.rounds(g.id);
    expect(rounds).toHaveLength(4);
    expect(rounds.map((r: { recipient_id: string }) => r.recipient_id)).toEqual(
      [maker, b, c, d].map((p) => p.id),
    );
    expect((await h.contributions(g.id)).length).toBe(16);
    expect(
      (await h.contributions(g.id)).every((x: { status: string }) => x.status === "scheduled"),
    ).toBe(true);
    expect(
      (await h.notices(c.id)).filter((n: { kind: string }) => n.kind === "group.started"),
    ).toHaveLength(1);
    // Nobody can join or leave now.
    await h.join(await h.person(), g.inviteCode!).expect(409);
    const left = await b.call("post", `/groups/${g.id}/leave`);
    expect(left.body.code).toBe("group_locked");
  });

  it("asks an untrusted member in an early turn for the larger deposit, and gives trusted members none", async () => {
    const maker = await h.person("10000000", { trust: true });
    const [b, c, d, e, f] = (await people(5)) as [Member, Member, Member, Member, Member];
    const g = await h.filled(maker, [b, c, d, e, f], { size: 6 });
    // Six turns: the first two are early. The maker is trusted (turn 1, no deposit); b is untrusted in turn 2.
    const rows = await h.members(g.id);
    expect(rows[0].deposit_required).toBe("0");
    expect(rows[1].deposit_required).toBe("1500000");
    expect(await h.locked(b.id, g.id)).toBe("1500000");
    expect(await h.t.balance(b.id)).toBe("8500000");
    for (const later of [c, d, e, f]) expect(await h.locked(later.id, g.id)).toBe("500000");
  });

  it("swaps an untrusted early member who cannot cover the larger deposit with the first later member who can", async () => {
    const maker = await h.person("10000000", { trust: true });
    const broke = await h.person("600000");
    const [c, d] = (await people(2)) as [Member, Member];
    const g = await h.filled(maker, [broke, c, d], { size: 4 });
    // Four turns: the first two are early. `broke` joined 2nd but cannot afford 1,500,000, so trades with turn 3.
    const spots = new Map(
      (await h.members(g.id)).map((m: { user_id: string; spot: number }) => [m.user_id, m.spot]),
    );
    expect(spots.get(maker.id)).toBe(1);
    expect(spots.get(broke.id)).toBeGreaterThan(2);
    expect([c.id, d.id]).toContain([...spots].find(([, spot]) => spot === 2)![0]);
    expect(await h.locked(broke.id, g.id)).toBe("500000");
  });
});

describe("a circle drawn by lot", () => {
  it("draws once, logs the seed and the result for everyone to see, and the same seed gives the same order", async () => {
    const maker = await h.person("10000000", { trust: true });
    const [b, c, d, e] = (await people(4)) as [Member, Member, Member, Member];
    const g = await h.filled(maker, [b, c, d, e], { orderMethod: "random" });
    const detail = await h.detail(b, g.id);
    expect(detail.status).toBe("running");
    expect(detail.draws).toHaveLength(1);
    const draw = detail.draws[0]!;
    expect(draw.kind).toBe("random");
    expect(draw.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(detail.members.map((m) => m.spot)).size).toBe(5);

    // Anyone can check it: the logged input and seed give the logged order.
    const [logged] = await h.t.db.query(
      "SELECT seed, input, result FROM group_draws WHERE group_id = $1",
      [g.id],
    );
    const again = placeMembers(logged.input.members, logged.input.early, logged.seed);
    expect(again).toEqual(logged.result);
    expect(again.slice(0, logged.input.early)).toContain(maker.id);
    // And the recipient of each round is whoever the draw put in that turn.
    const rounds = await h.rounds(g.id);
    expect(rounds.map((r: { recipient_id: string }) => r.recipient_id)).toEqual(logged.result);
  });
});

describe("a circle where everyone picks", () => {
  async function pickingCircle(size = 4) {
    const maker = await h.person("10000000", { trust: true });
    const others: Member[] = [];
    for (let i = 0; i < size - 1; i += 1) others.push(await h.person("10000000", { trust: true }));
    const g = await h.filled(maker, others, { orderMethod: "pick", size });
    return { maker, others, all: [maker, ...others], g };
  }

  it("opens picking for everyone at once when the circle fills, with a deadline", async () => {
    const { g, all } = await pickingCircle();
    const detail = await h.detail(all[0]!, g.id);
    expect(detail.status).toBe("picking");
    expect(new Date(detail.pickDeadline!).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(detail.members.every((m) => m.spot === null)).toBe(true);
    expect(
      (await h.notices(all[2]!.id)).some((n: { kind: string }) => n.kind === "group.picking"),
    ).toBe(true);
  });

  it("gives each turn to one person, even when everyone reaches for the same one at once", async () => {
    for (let round = 0; round < 3; round += 1) {
      const { g, all } = await pickingCircle(5);
      const results = await many(all.length, (i) =>
        all[i]!.call("post", `/groups/${g.id}/pick`).send({ spot: 3 }),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(
        results.filter((r) => r.status === 409).every((r) => ["spot_taken"].includes(r.body.code)),
      ).toBe(true);
      const taken = (await h.members(g.id)).filter((m: { spot: number | null }) => m.spot === 3);
      expect(taken).toHaveLength(1);
    }
  });

  it("lets each person take one turn only, refuses nonsense, and starts the rounds when the last has picked", async () => {
    const { g, all } = await pickingCircle(4);
    await all[0]!.call("post", `/groups/${g.id}/pick`).send({ spot: 2 }).expect(200);
    expect((await all[0]!.call("post", `/groups/${g.id}/pick`).send({ spot: 3 })).body.code).toBe(
      "already_picked",
    );
    await all[1]!.call("post", `/groups/${g.id}/pick`).send({ spot: 9 }).expect(400);
    await all[1]!.call("post", `/groups/${g.id}/pick`).send({ spot: 0 }).expect(400);
    expect((await all[1]!.call("post", `/groups/${g.id}/pick`).send({ spot: 2 })).body.code).toBe(
      "spot_taken",
    );
    await all[1]!.call("post", `/groups/${g.id}/pick`).send({ spot: 1 }).expect(200);
    await all[2]!.call("post", `/groups/${g.id}/pick`).send({ spot: 4 }).expect(200);
    expect((await h.row(g.id)).status).toBe("picking");
    const last = await all[3]!.call("post", `/groups/${g.id}/pick`).send({ spot: 3 }).expect(200);
    expect(last.body.status).toBe("running");
    expect((await h.rounds(g.id)).map((r: { recipient_id: string }) => r.recipient_id)).toEqual(
      [all[1]!, all[0]!, all[3]!, all[2]!].map((p) => p.id),
    );
    // Picking is over once the rounds begin, for members and outsiders alike.
    const outsider = await h.person();
    expect((await outsider.call("post", `/groups/${g.id}/pick`).send({ spot: 1 })).body.code).toBe(
      "picking_closed",
    );
  });

  it("gives whoever has not picked a turn that is left when time is up, drawn and logged", async () => {
    const { g, all } = await pickingCircle(4);
    await all[0]!.call("post", `/groups/${g.id}/pick`).send({ spot: 4 }).expect(200);
    await h.t.db.query(
      "UPDATE groups SET pick_deadline = now() - interval '1 minute' WHERE id = $1",
      [g.id],
    );
    expect((await all[1]!.call("post", `/groups/${g.id}/pick`).send({ spot: 1 })).body.code).toBe(
      "picking_closed",
    );
    await many(4, () => h.runner.closePicking());
    expect((await h.row(g.id)).status).toBe("running");
    const rows = await h.members(g.id);
    expect(rows.map((m: { spot: number }) => m.spot).sort((a: number, b: number) => a - b)).toEqual(
      [1, 2, 3, 4],
    );
    expect(rows.find((m: { user_id: string }) => m.user_id === all[0]!.id).spot).toBe(4);
    const [leftover] = await h.t.db.query(
      "SELECT kind, result FROM group_draws WHERE group_id = $1",
      [g.id],
    );
    expect(leftover.kind).toBe("pick_leftover");
    expect(await h.rounds(g.id)).toHaveLength(4);
  });

  it("asks an untrusted member taking an early turn for the larger deposit, and leaves the turn free if they cannot", async () => {
    const maker = await h.person("10000000", { trust: true });
    const rich = await h.person("10000000");
    const poor = await h.person("700000");
    const g = await h.filled(maker, [rich, poor], { orderMethod: "pick", size: 3 });
    // Three turns: only turn 1 is early.
    const denied = await poor.call("post", `/groups/${g.id}/pick`).send({ spot: 1 });
    expect([denied.status, denied.body.code]).toEqual([409, "deposit_needed"]);
    expect(
      (await h.members(g.id)).filter((m: { spot: number | null }) => m.spot === 1),
    ).toHaveLength(0);
    await rich.call("post", `/groups/${g.id}/pick`).send({ spot: 1 }).expect(200);
    expect(await h.locked(rich.id, g.id)).toBe("1500000");
    await poor.call("post", `/groups/${g.id}/pick`).send({ spot: 3 }).expect(200);
  });
});
