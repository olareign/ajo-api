export type Frequency = "daily" | "weekly" | "monthly";
export const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "monthly"];

/** Most debits one plan may have, so a plan stays short enough to understand and to run. */
export const MAX_DEBITS: Readonly<Record<Frequency, number>> = {
  daily: 366,
  weekly: 104,
  monthly: 60,
};
export const MAX_OPEN_PLANS = 10;
/** A plan may start today or up to this many days from now. */
export const MAX_START_DAYS_AHEAD = 90;

/** Smallest and largest single debit, in kobo or pence. Sample numbers until the owner sets real ones. */
export const AMOUNT_LIMITS: Readonly<Record<string, { min: bigint; max: bigint }>> = {
  NGN: { min: 10_000n, max: 500_000_000n }, // ₦100 to ₦5,000,000
  GBP: { min: 100n, max: 1_000_000n }, // £1 to £10,000
};

/** A debit is taken at this hour, local time, on its day. */
export const DEBIT_HOUR = 8;
export const TIMEZONE: Readonly<Record<string, string>> = {
  NGN: "Africa/Lagos",
  GBP: "Europe/London",
};
const FALLBACK_ZONE = "UTC";
export const zoneFor = (currency: string): string => TIMEZONE[currency] ?? FALLBACK_ZONE;

/** When a debit cannot be taken: try again this often, up to this many failed passes. */
export const RETRY_EVERY_HOURS = 24;
export const MAX_FAILED_PASSES = 3;
/** While the bank is collecting the shortfall, look again this often (a status check, not a failure). */
export const WAIT_FOR_BANK_MINUTES = 15;
/** However it goes, a debit is given up on this many days after its day. */
export const GIVE_UP_AFTER_DAYS = 5;
/** The reminder goes out when a debit is due within this many hours. */
export const REMIND_HOURS_BEFORE = 24;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date where the person is, as YYYY-MM-DD. */
export function todayIn(currency: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zoneFor(currency),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export const isDate = (value: string): boolean => {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The same day of a later month, or its last day when that month is shorter (31 January + 1 month = 28 February). */
export function addMonths(date: string, months: number): string {
  const [y, m, day] = date.split("-").map(Number) as [number, number, number];
  const index = m - 1 + months;
  const year = y + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/** The day of every debit, counted from the start: never from the previous one, so a short month does not drag later ones. */
export function scheduleDates(start: string, frequency: Frequency, count: number): string[] {
  return Array.from({ length: count }, (_, n) =>
    frequency === "daily"
      ? addDays(start, n)
      : frequency === "weekly"
        ? addDays(start, 7 * n)
        : addMonths(start, n),
  );
}

export type PlanInput = Readonly<{
  name: string;
  amount: string;
  frequency: Frequency;
  totalDebits: number;
  startDate: string;
}>;

/** The first thing wrong with a plan, in words, or null. */
export function planProblem(input: PlanInput, currency: string, today: string): string | null {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 60) return "Give your plan a name of up to 60 characters.";
  const limits = AMOUNT_LIMITS[currency];
  if (!limits) return "Saving plans aren't available in your currency yet.";
  if (!/^[1-9]\d{0,14}$/.test(input.amount)) return "Enter how much to save each time.";
  const amount = BigInt(input.amount);
  if (amount < limits.min) return "That's below the smallest amount a plan can save at a time.";
  if (amount > limits.max) return "That's above the largest amount a plan can save at a time.";
  if (!Number.isInteger(input.totalDebits) || input.totalDebits < 2) {
    return "A plan needs at least two debits.";
  }
  if (input.totalDebits > MAX_DEBITS[input.frequency]) {
    return `A ${input.frequency} plan can have at most ${MAX_DEBITS[input.frequency]} debits.`;
  }
  if (!isDate(input.startDate)) return "Choose a start date.";
  if (input.startDate < today) return "The start date can't be in the past.";
  if (daysBetween(today, input.startDate) > MAX_START_DAYS_AHEAD) {
    return `A plan can start at most ${MAX_START_DAYS_AHEAD} days from now.`;
  }
  return null;
}
