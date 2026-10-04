export type TrustKind = "payment_on_time" | "payment_late" | "payment_missed" | "group_completed";

/** Points for each thing that has happened. Sample values until the owner sets the real ones. */
export const POINTS: Readonly<Record<TrustKind, number>> = {
  payment_on_time: 5,
  group_completed: 20,
  payment_late: -10,
  payment_missed: -40,
};
export const MAX_SCORE = 100;
/** A score at or above this, with no missed payment lately, makes someone trusted. */
export const TRUSTED_AT = 40;
export const RECENT_DAYS = 180;

export type TrustLevel = "new" | "building" | "trusted";

export type TrustCounts = Readonly<{
  onTime: number;
  late: number;
  missed: number;
  completed: number;
  missedRecently: number;
  blocked: boolean;
}>;

export type Trust = Readonly<{ score: number; level: TrustLevel; trusted: boolean } & TrustCounts>;

/** What someone's record adds up to. A person with nothing on record is "new", never "trusted". */
export function summarise(counts: TrustCounts): Trust {
  const raw =
    counts.onTime * POINTS.payment_on_time +
    counts.completed * POINTS.group_completed +
    counts.late * POINTS.payment_late +
    counts.missed * POINTS.payment_missed;
  const score = Math.min(MAX_SCORE, Math.max(0, raw));
  const events = counts.onTime + counts.late + counts.missed + counts.completed;
  const trusted = score >= TRUSTED_AT && counts.missedRecently === 0 && !counts.blocked;
  return {
    ...counts,
    score,
    trusted,
    level: trusted ? "trusted" : events === 0 ? "new" : "building",
  };
}
