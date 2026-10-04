import { parseOverrideArgs } from "./override-command.js";

describe("parseOverrideArgs", () => {
  it("reads an email and one of approve, deny or clear", () => {
    expect(parseOverrideArgs(["ada@example.com", "approve"])).toEqual({
      kind: "set",
      email: "ada@example.com",
      value: "approved",
    });
    expect(parseOverrideArgs(["ada@example.com", "deny"])).toEqual({
      kind: "set",
      email: "ada@example.com",
      value: "denied",
    });
    expect(parseOverrideArgs(["ada@example.com", "clear"])).toEqual({
      kind: "set",
      email: "ada@example.com",
      value: null,
    });
  });

  it("lists who has been switched, with no other arguments", () => {
    expect(parseOverrideArgs(["list"])).toEqual({ kind: "list" });
  });

  it("is not case-sensitive about the word, and trims the email", () => {
    expect(parseOverrideArgs(["  ada@example.com ", "APPROVE"])).toMatchObject({
      email: "ada@example.com",
      value: "approved",
    });
  });

  it("explains itself instead of guessing when it is unsure", () => {
    for (const args of [
      [],
      ["ada@example.com"],
      ["ada@example.com", "yes"],
      ["not-an-email", "approve"],
      ["a@b.co", "approve", "extra"],
    ]) {
      expect(parseOverrideArgs(args)).toMatchObject({ kind: "usage" });
    }
  });
});
