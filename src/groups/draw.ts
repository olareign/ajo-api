import { createHmac, randomBytes } from "node:crypto";

/** A fresh secret seed. It is kept with the result, so anyone can check the draw was not fiddled with. */
export const newSeed = (): string => randomBytes(32).toString("hex");

/** A number from 0 up to (but not including) `below`, made from the seed and a label: the same inputs always give the same number. */
function pick(seed: string, label: string, below: number): number {
  const digest = createHmac("sha256", Buffer.from(seed, "hex")).update(label).digest();
  // 64 bits against a small range: the bias is smaller than one in a billion billion.
  return Number(digest.readBigUInt64BE(0) % BigInt(below));
}

/** Fisher-Yates, with every swap decided by the seed rather than by a hidden random number. */
export function seededShuffle<T>(items: readonly T[], seed: string, label = "shuffle"): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = pick(seed, `${label}:${i}`, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export type DrawMember = Readonly<{ id: string; trusted: boolean }>;

/**
 * Orders members into spots 1..n. The early spots go to trusted members first (an untrusted member in
 * an early spot has to lock a larger deposit), then everything left is shuffled together. Returns the
 * member ids in spot order. The same members and seed always give the same order.
 */
export function placeMembers(
  members: readonly DrawMember[],
  early: number,
  seed: string,
): string[] {
  const trusted = seededShuffle(
    members.filter((m) => m.trusted),
    seed,
    "trusted",
  ).map((m) => m.id);
  const untrusted = seededShuffle(
    members.filter((m) => !m.trusted),
    seed,
    "untrusted",
  ).map((m) => m.id);
  const front = trusted.slice(0, early);
  const spill = untrusted.slice(0, Math.max(0, early - front.length));
  const rest = seededShuffle(
    [...trusted.slice(front.length), ...untrusted.slice(spill.length)],
    seed,
    "rest",
  );
  return [...front, ...spill, ...rest];
}

/** The spots no one has taken, filled by the members who have none, in an order fixed by the seed. */
export function placeLeftovers(
  openSpots: readonly number[],
  waiting: readonly DrawMember[],
  early: number,
  seed: string,
): { spot: number; id: string }[] {
  const spots = [...openSpots].sort((a, b) => a - b);
  const earlySpotsOpen = spots.filter((s) => s <= early);
  const lateSpotsOpen = spots.filter((s) => s > early);
  const trusted = seededShuffle(
    waiting.filter((m) => m.trusted),
    seed,
    "trusted",
  ).map((m) => m.id);
  const untrusted = seededShuffle(
    waiting.filter((m) => !m.trusted),
    seed,
    "untrusted",
  ).map((m) => m.id);
  const out: { spot: number; id: string }[] = [];
  // Early spots first, to trusted members; untrusted only if there are not enough of them.
  const queue = [...trusted];
  for (const spot of earlySpotsOpen) {
    const id = queue.shift() ?? untrusted.shift();
    if (id) out.push({ spot, id });
  }
  const remaining = seededShuffle([...queue, ...untrusted], seed, "rest");
  for (const spot of lateSpotsOpen) {
    const id = remaining.shift();
    if (id) out.push({ spot, id });
  }
  return out.sort((a, b) => a.spot - b.spot);
}
