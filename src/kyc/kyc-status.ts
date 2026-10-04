export const KYC_STEPS = ["id", "selfie", "address", "location", "bank", "national_check"] as const;
export type KycStep = (typeof KYC_STEPS)[number];

/** What approval needs. The national check (BVN in Nigeria) is optional and only raises the tier. */
export const REQUIRED_STEPS = ["id", "selfie", "address", "location", "bank"] as const;

export type DecisionStatus = "pending" | "approved" | "rejected";
export type StepStatus = DecisionStatus | "not_started";
export type KycStatus = "not_started" | "in_progress" | "pending" | "approved" | "rejected";
export type KycTier = 0 | 1 | 2;

export type StepRow = Readonly<{
  step: KycStep;
  status: DecisionStatus;
  reason: string | null;
}>;

export type StepSummary = Readonly<{
  step: KycStep;
  required: boolean;
  status: StepStatus;
  reason: string | null;
}>;

/**
 * Where the answer comes from: the real checks, an approval given without them while they are
 * pended (`waived`), or a hold the owner put on the account (`hold`).
 */
export type KycVia = "checks" | "waived" | "hold";

export type KycSummary = Readonly<{
  status: KycStatus;
  tier: KycTier;
  steps: StepSummary[];
  via: KycVia;
  /** A sentence for the person when the answer is not from the checks; null otherwise. */
  note: string | null;
}>;

/** Set by the owner on one account (`users.kyc_override`). */
export type KycOverride = "approved" | "denied";

const isRequired = (step: KycStep) => (REQUIRED_STEPS as readonly string[]).includes(step);

/**
 * One person's progress from their submitted steps. A rejection wins over a wait, so the first thing
 * shown is what to fix; and only the required steps decide the status.
 */
export function summarise(rows: readonly StepRow[]): KycSummary {
  const byStep = new Map(rows.map((row) => [row.step, row]));
  const steps = KYC_STEPS.map((step): StepSummary => {
    const found = byStep.get(step);
    return {
      step,
      required: isRequired(step),
      status: found?.status ?? "not_started",
      reason: found?.reason ?? null,
    };
  });
  const required = steps.filter((s) => s.required);

  let status: KycStatus;
  if (required.some((s) => s.status === "rejected")) status = "rejected";
  else if (required.every((s) => s.status === "approved")) status = "approved";
  else if (required.some((s) => s.status === "pending")) status = "pending";
  else if (required.some((s) => s.status === "approved")) status = "in_progress";
  else status = "not_started";

  const national = steps.find((s) => s.step === "national_check");
  const tier: KycTier = status !== "approved" ? 0 : national?.status === "approved" ? 2 : 1;
  return { status, tier, steps, via: "checks", note: null };
}

export const WAIVED_NOTE =
  "Your account was approved without the identity checks, which are not switched on yet.";
export const HOLD_NOTE = "Your verification is on hold. Please contact support.";

/**
 * Applies the owner's switches to what the real checks say, while those checks are pended:
 * a hold beats everything; real approval is always trusted (and keeps its own tier); otherwise an
 * approval for this person, or for everyone, approves at tier 1. The steps are left as they are,
 * so the passport keeps showing what was really done.
 */
export function resolveKyc(
  derived: KycSummary,
  switches: Readonly<{ override: KycOverride | null; autoApprove: boolean }>,
): KycSummary {
  if (switches.override === "denied") {
    return { ...derived, status: "rejected", tier: 0, via: "hold", note: HOLD_NOTE };
  }
  if (derived.status === "approved") return derived;
  if (switches.override === "approved" || switches.autoApprove) {
    return { ...derived, status: "approved", tier: 1, via: "waived", note: WAIVED_NOTE };
  }
  return derived;
}
