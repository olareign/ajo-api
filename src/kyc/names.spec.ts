import { namesMatch } from "./names.js";

describe("namesMatch", () => {
  it("ignores capitals, punctuation and the order of names", () => {
    expect(namesMatch("ADA OLA", "Ada Ola")).toBe(true);
    expect(namesMatch("OLA, ADA", "Ada Ola")).toBe(true);
    expect(namesMatch("O'BRIEN-ADE ADA", "Ada Obrien Ade")).toBe(true);
  });
  it("accepts a bank that holds only some of the names, or more of them", () => {
    expect(namesMatch("ADA OLAMIDE OLA", "Ada Ola")).toBe(true);
    expect(namesMatch("ADA OLA", "Ada Olamide Ola")).toBe(true);
  });
  it("refuses another person, or a shared first name alone", () => {
    expect(namesMatch("CHIDI OKAFOR", "Ada Ola")).toBe(false);
    expect(namesMatch("ADA BELLO", "Ada Ola")).toBe(false);
  });
  it("accepts a one-word name only when it is the same word", () => {
    expect(namesMatch("ADA", "Ada")).toBe(true);
    expect(namesMatch("BOLA", "Ada")).toBe(false);
  });
  it("refuses nothing in common, and empty names", () => {
    expect(namesMatch("", "Ada Ola")).toBe(false);
    expect(namesMatch("Ada Ola", "")).toBe(false);
    expect(namesMatch("12345", "Ada Ola")).toBe(false);
  });
  it("handles accents the way people write them", () => {
    expect(namesMatch("ÀDÉ ÒLÁ", "Àdé Òlá")).toBe(true);
  });
});
