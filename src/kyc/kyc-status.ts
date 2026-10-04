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

export type KycSummary = Readonly<{
  status: KycStatus;
  tier: KycTier;
  steps: StepSummary[];
}>;

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
  return { status, tier, steps };
}
