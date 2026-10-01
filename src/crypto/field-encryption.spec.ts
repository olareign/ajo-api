import { randomBytes } from "node:crypto";
import { FieldEncryption } from "./field-encryption.js";

const key = randomBytes(32).toString("base64");

describe("FieldEncryption", () => {
  const box = new FieldEncryption(key);

  it("round-trips a value", () => {
    expect(box.decrypt(box.encrypt("JBSWY3DPEHPK3PXP"))).toBe("JBSWY3DPEHPK3PXP");
  });

  it("produces different ciphertext each time (random IV)", () => {
    expect(box.encrypt("same")).not.toBe(box.encrypt("same"));
  });

  it("is versioned and never contains the plaintext", () => {
    const sealed = box.encrypt("JBSWY3DPEHPK3PXP");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
  });

  it("detects tampering", () => {
    const [v, iv, ct, tag] = box.encrypt("secret").split(".");
    const flipped = ct![0] === "A" ? `B${ct!.slice(1)}` : `A${ct!.slice(1)}`;
    expect(() => box.decrypt([v, iv, flipped, tag].join("."))).toThrow();
  });

  it("cannot be opened with another key", () => {
    const sealed = box.encrypt("secret");
    expect(() => new FieldEncryption(randomBytes(32).toString("base64")).decrypt(sealed)).toThrow();
  });

  it("binds ciphertext to its context, so a value cannot be moved to another record", () => {
    const sealed = box.encrypt("secret", "user:1");
    expect(box.decrypt(sealed, "user:1")).toBe("secret");
    expect(() => box.decrypt(sealed, "user:2")).toThrow();
  });

  it("needs a 256-bit key", () => {
    expect(() => new FieldEncryption(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("rejects malformed or unknown-version input", () => {
    expect(() => box.decrypt("v2.a.b.c")).toThrow();
    expect(() => box.decrypt("garbage")).toThrow();
  });
});
