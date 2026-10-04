import { REQUIRED_STEPS, resolveKyc, summarise, type StepRow } from "./kyc-status.js";

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

describe("resolveKyc: approval switched on by hand while the real checks are pended", () => {
  const nothing = summarise([]);
  const real = summarise([...allApproved, row("national_check", "approved")]);

  it("leaves the real result alone when nothing is switched on", () => {
    expect(resolveKyc(nothing, { override: null, autoApprove: false })).toMatchObject({
      status: "not_started",
      tier: 0,
      via: "checks",
      note: null,
    });
  });

  it("approves one person at tier 1 when the owner says so, and says it was without the checks", () => {
    const result = resolveKyc(nothing, { override: "approved", autoApprove: false });
    expect(result).toMatchObject({ status: "approved", tier: 1, via: "waived" });
    expect(result.note).toMatch(/without the identity checks/i);
  });

  it("approves everyone at tier 1 when the automatic switch is on", () => {
    expect(resolveKyc(nothing, { override: null, autoApprove: true })).toMatchObject({
      status: "approved",
      tier: 1,
      via: "waived",
    });
  });

  it("keeps the person's steps as they are, so the passport still shows the truth", () => {
    const result = resolveKyc(nothing, { override: "approved", autoApprove: true });
    expect(result.steps.every((s) => s.status === "not_started")).toBe(true);
  });

  it("puts a hold ahead of everything: the switch, an approval by hand, even real approval", () => {
    for (const autoApprove of [false, true]) {
      for (const base of [nothing, real]) {
        expect(resolveKyc(base, { override: "denied", autoApprove })).toMatchObject({
          status: "rejected",
          tier: 0,
          via: "hold",
        });
      }
    }
    expect(resolveKyc(nothing, { override: "denied", autoApprove: false }).note).toMatch(
      /on hold/i,
    );
  });

  it("trusts real checks once they approve someone, keeping their own tier", () => {
    for (const override of [null, "approved"] as const) {
      expect(resolveKyc(real, { override, autoApprove: true })).toMatchObject({
        status: "approved",
        tier: 2,
        via: "checks",
        note: null,
      });
    }
  });

  it("lets the owner approve someone the checks refused, because the owner decides while checks are pended", () => {
    const refused = summarise([row("id", "rejected", "No match")]);
    expect(resolveKyc(refused, { override: "approved", autoApprove: false })).toMatchObject({
      status: "approved",
      via: "waived",
    });
  });
});
