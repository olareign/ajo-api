import {
  addDays,
  addMonths,
  daysBetween,
  isDate,
  MAX_START_DAYS_AHEAD,
  zoneFor,
} from "../savings/savings-rules.js";

export type GroupFrequency = "weekly" | "biweekly" | "monthly";
export type OrderMethod = "random" | "pick" | "join_order";
export type Visibility = "private" | "public";

export const SIZE = { min: 3, max: 30 } as const;
export const MAX_OPEN_GROUPS = 5;
/** Each person may be in this many groups that are still open or running. */
export const MAX_NAME = 60;

/** Smallest and largest single contribution, in kobo or pence. Sample numbers until the owner sets real ones. */
export const CONTRIBUTION_LIMITS: Readonly<Record<string, { min: bigint; max: bigint }>> = {
  NGN: { min: 100_000n, max: 100_000_000n }, // ₦1,000 to ₦1,000,000
  GBP: { min: 1_000n, max: 1_000_000n }, // £10 to £10,000
};

export const COLLECT_HOUR = 8;
export { zoneFor };

/** How long after its day a contribution is tried again before the deposit covers it, and how often. */
export const RETRY_EVERY_HOURS = 24;
export const WAIT_FOR_BANK_MINUTES = 15;
export const REMIND_HOURS_BEFORE = 24;
/** Picking stays open this long after a group fills. */
export const PICK_WINDOW_HOURS = 24;
/** Someone who defaults cannot join or start a group for this long. */
export const DEFAULTER_BLOCK_DAYS = 90;

/** The first third of the turns: the ones that take the pot before most of it has been paid in. */
export const earlySpots = (size: number): number => Math.ceil(size / 3);
export const isEarly = (spot: number, size: number): boolean =>
  spot >= 1 && spot <= earlySpots(size);

/** The day each round is collected, counted from the start (never from the previous one). */
export function roundDates(start: string, frequency: GroupFrequency, size: number): string[] {
  return Array.from({ length: size }, (_, n) =>
    frequency === "weekly"
      ? addDays(start, 7 * n)
      : frequency === "biweekly"
        ? addDays(start, 14 * n)
        : addMonths(start, n),
  );
}

/** What a member of a group of this size gets when it is their turn: everyone's contribution, before any fee. */
export const potOf = (contribution: bigint, size: number): bigint => contribution * BigInt(size);

export type GroupInput = Readonly<{
  name: string;
  community?: string | undefined;
  contribution: string;
  frequency: GroupFrequency;
  size: number;
  startDate: string;
  orderMethod: OrderMethod;
  visibility: Visibility;
}>;

/** The first thing wrong with a group, in words, or null. */
export function groupProblem(input: GroupInput, currency: string, today: string): string | null {
  const name = input.name.trim();
  if (name.length < 1 || name.length > MAX_NAME)
    return "Give your circle a name of up to 60 characters.";
  if (
    input.community !== undefined &&
    (input.community.trim().length < 1 || input.community.trim().length > 40)
  ) {
    return "A community name is 1 to 40 characters.";
  }
  const limits = CONTRIBUTION_LIMITS[currency];
  if (!limits) return "Circles aren't available in your currency yet.";
  if (!/^[1-9]\d{0,14}$/.test(input.contribution))
    return "Enter how much each person pays each round.";
  const amount = BigInt(input.contribution);
  if (amount < limits.min) return "That's below the smallest contribution a circle can have.";
  if (amount > limits.max) return "That's above the largest contribution a circle can have.";
  if (!Number.isInteger(input.size) || input.size < SIZE.min || input.size > SIZE.max) {
    return `A circle has ${SIZE.min} to ${SIZE.max} people.`;
  }
  if (!isDate(input.startDate)) return "Choose the day the first round is collected.";
  if (input.startDate <= today)
    return "The first round must be after today, so there is time to fill the circle.";
  if (daysBetween(today, input.startDate) > MAX_START_DAYS_AHEAD) {
    return `The first round can be at most ${MAX_START_DAYS_AHEAD} days from now.`;
  }
  return null;
}
