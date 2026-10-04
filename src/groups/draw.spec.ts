import { newSeed, placeLeftovers, placeMembers, seededShuffle } from "./draw.js";

const people = (n: number, trusted: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `m${i}`, trusted: i < trusted }));

describe("a draw anyone can check", () => {
  it("gives the same order for the same seed, and a different one for another", () => {
    const seed = newSeed();
    const a = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], seed);
    expect(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], seed)).toEqual(a);
    expect(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], newSeed())).not.toEqual(a);
    expect([...a].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("makes seeds that look like a 64-character secret, and never repeats one", () => {
    const seeds = new Set(Array.from({ length: 200 }, newSeed));
    expect(seeds.size).toBe(200);
    expect([...seeds].every((s) => /^[0-9a-f]{64}$/.test(s))).toBe(true);
  });

  it("does not favour any place: each member lands in each spot about as often as any other", () => {
    const n = 5;
    const counts = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
    const rounds = 3000;
    for (let r = 0; r < rounds; r += 1) {
      const order = seededShuffle([0, 1, 2, 3, 4], newSeed());
      order.forEach((member, spot) => (counts[member]![spot]! += 1));
    }
    const expected = rounds / n;
    for (const row of counts)
      for (const c of row) expect(Math.abs(c - expected)).toBeLessThan(expected * 0.2);
  });

  it("changes nothing about the input list", () => {
    const input = [3, 1, 2];
    seededShuffle(input, newSeed());
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("placing members in spots", () => {
  it("puts trusted members in the early spots when there are enough of them", () => {
    for (let i = 0; i < 50; i += 1) {
      const order = placeMembers(people(9, 5), 3, newSeed());
      expect(order).toHaveLength(9);
      expect(new Set(order).size).toBe(9);
      for (const id of order.slice(0, 3)) expect(Number(id.slice(1))).toBeLessThan(5);
    }
  });

  it("lets untrusted members into early spots only when there are not enough trusted ones", () => {
    const order = placeMembers(people(9, 1), 3, newSeed());
    expect(order[0]).toBe("m0");
    expect(order.slice(1, 3).every((id) => Number(id.slice(1)) >= 1)).toBe(true);
    const none = placeMembers(people(6, 0), 2, newSeed());
    expect(new Set(none).size).toBe(6);
  });

  it("is repeatable from the seed and the members", () => {
    const seed = newSeed();
    expect(placeMembers(people(10, 4), 4, seed)).toEqual(placeMembers(people(10, 4), 4, seed));
  });

  it("fills only the spots left, early ones from the trusted, and never uses anyone twice", () => {
    const seed = newSeed();
    const waiting = [
      { id: "t1", trusted: true },
      { id: "t2", trusted: true },
      { id: "u1", trusted: false },
      { id: "u2", trusted: false },
    ];
    const placed = placeLeftovers([2, 5, 6, 8], waiting, 3, seed);
    expect(placed.map((p) => p.spot)).toEqual([2, 5, 6, 8]);
    expect(new Set(placed.map((p) => p.id)).size).toBe(4);
    expect(["t1", "t2"]).toContain(placed[0]!.id);
    expect(placeLeftovers([2, 5, 6, 8], waiting, 3, seed)).toEqual(placed);
  });

  it("copes with fewer waiting members than spots, and none at all", () => {
    expect(placeLeftovers([1, 2], [{ id: "a", trusted: false }], 1, newSeed())).toHaveLength(1);
    expect(placeLeftovers([1, 2], [], 1, newSeed())).toEqual([]);
  });
});
