import { REQUIRED_STEPS, summarise, type StepRow } from "./kyc-status.js";

const row = (step: StepRow["step"], status: StepRow["status"], reason: string | null = null) => ({
  step,
  status,
  reason,
});
const allApproved = REQUIRED_STEPS.map((step) => row(step, "approved"));

describe("summarise", () => {
  it("is not started when nothing has been submitted, and lists every step", () => {
    const summary = summarise([]);
    expect(summary).toMatchObject({ status: "not_started", tier: 0 });
    expect(summary.steps.map((s) => [s.step, s.required, s.status])).toEqual([
      ["id", true, "not_started"],
      ["selfie", true, "not_started"],
      ["address", true, "not_started"],
      ["location", true, "not_started"],
      ["bank", true, "not_started"],
      ["national_check", false, "not_started"],
    ]);
  });

  it("is in progress while steps are approved and others are still to do", () => {
    expect(summarise([row("id", "approved"), row("selfie", "approved")]).status).toBe(
      "in_progress",
    );
  });

  it("is pending while any required step is waiting on a decision", () => {
    expect(summarise([row("id", "approved"), row("selfie", "pending")]).status).toBe("pending");
  });

  it("is approved only when every required step is approved, at tier 1", () => {
    expect(summarise(allApproved)).toMatchObject({ status: "approved", tier: 1 });
    expect(summarise(allApproved.slice(0, 4)).status).not.toBe("approved");
  });

  it("is rejected when any required step is, and says why", () => {
    const summary = summarise([...allApproved.slice(0, 2), row("address", "rejected", "Blurry")]);
    expect(summary.status).toBe("rejected");
    expect(summary.steps.find((s) => s.step === "address")).toMatchObject({
      status: "rejected",
      reason: "Blurry",
    });
  });

  it("puts rejection before pending, so a person sees what to fix first", () => {
    expect(summarise([row("id", "rejected", "No match"), row("selfie", "pending")]).status).toBe(
      "rejected",
    );
  });

  it("raises the tier to 2 with an approved national check, but never without KYC approval", () => {
    expect(summarise([...allApproved, row("national_check", "approved")]).tier).toBe(2);
    expect(summarise([row("national_check", "approved")])).toMatchObject({
      status: "not_started",
      tier: 0,
    });
  });

  it("does not let the optional national check change the status", () => {
    expect(
      summarise([...allApproved, row("national_check", "rejected", "No match")]),
    ).toMatchObject({
      status: "approved",
      tier: 1,
    });
  });
});
