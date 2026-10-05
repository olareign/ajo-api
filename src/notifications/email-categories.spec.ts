import { emailCategory } from "./email-categories.js";

describe("which emails a person can turn off", () => {
  it("never lets money or account messages be turned off", () => {
    for (const kind of [
      "plan.debit_missed",
      "plan.debit_short",
      "plan.debit_paid",
      "group.payout",
      "group.contribution_short",
      "group.payment_missed",
      "group.member_defaulted",
      "funding.succeeded",
      "payout.failed",
      "payout.reversed",
      "mandate.active",
    ]) {
      expect(emailCategory(kind)).toBeNull();
    }
  });

  it("sorts the rest into reminders, savings, circles and friends", () => {
    expect(emailCategory("plan.debit_soon")).toBe("reminders");
    expect(emailCategory("group.your_turn_soon")).toBe("reminders");
    expect(emailCategory("plan.created")).toBe("savings");
    expect(emailCategory("group.invite")).toBe("circles");
    expect(emailCategory("group.started")).toBe("circles");
    expect(emailCategory("friend.request")).toBe("friends");
    expect(emailCategory("something.new")).toBeNull();
  });
});
