import { isReservedUsername, isValidUsername, normalizeUsername } from "./username-policy.js";

describe("normalizeUsername", () => {
  it("trims, lowercases and drops a leading @, so what people type and what is stored agree", () => {
    expect(normalizeUsername("  Ada_Ola ")).toBe("ada_ola");
    expect(normalizeUsername("@Ada")).toBe("ada");
  });
});

describe("isValidUsername", () => {
  it.each(["ada", "ada_ola", "ada99", "a1b", "x".repeat(20)])("accepts %s", (name) => {
    expect(isValidUsername(name)).toBe(true);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "x".repeat(21)],
    ["starting with a digit", "1ada"],
    ["starting with an underscore", "_ada"],
    ["with a dot", "ada.ola"],
    ["with a space", "ada ola"],
    ["with an accent", "adé"],
    ["with an emoji", "ada😀"],
    ["with a path in it", "ada/../admin"],
    ["with capitals (names are stored lowercase)", "Ada"],
    ["empty", ""],
  ])("refuses a name %s", (_why, name) => {
    expect(isValidUsername(name)).toBe(false);
  });
});

describe("isReservedUsername", () => {
  it.each(["admin", "support", "ajo", "help", "root", "system", "security"])(
    "keeps %s for the company",
    (name) => {
      expect(isReservedUsername(name)).toBe(true);
    },
  );

  it("is not fooled by capitals", () => {
    expect(isReservedUsername("Admin")).toBe(true);
  });

  it("leaves ordinary names, including ones that merely start with a reserved word, to people", () => {
    expect(isReservedUsername("ajoke")).toBe(false);
    expect(isReservedUsername("helpful_ada")).toBe(false);
  });
});
