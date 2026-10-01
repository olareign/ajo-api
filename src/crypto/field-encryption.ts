import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

/**
 * AES-256-GCM encryption for sensitive columns (TOTP secrets, ID numbers, BVN, exact
 * location). Output is "v1.<iv>.<ciphertext>.<tag>" in base64url. An optional context
 * (e.g. "user:<id>") is bound as additional data, so a value copied to another record
 * will not decrypt.
 */
export class FieldEncryption {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32) throw new Error("Field encryption key must be 32 bytes");
  }

  encrypt(plaintext: string, context = ""): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return [VERSION, iv, ciphertext, cipher.getAuthTag()]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".");
  }

  decrypt(sealed: string, context = ""): string {
    const [version, iv, ciphertext, tag] = sealed.split(".");
    if (version !== VERSION || !iv || !ciphertext || !tag) {
      throw new Error("Unsupported or malformed encrypted value");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
