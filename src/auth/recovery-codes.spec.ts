import { generateRecoveryCodes, hashRecoveryCode, RECOVERY_CODE_COUNT } from "./recovery-codes.js";

describe("recovery codes", () => {
  it(`issues ${RECOVERY_CODE_COUNT} distinct, readable codes`, () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
  });

  it("hashes codes so they can be checked but not recovered", () => {
    const [code] = generateRecoveryCodes();
    expect(hashRecoveryCode(code!)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRecoveryCode(code!)).not.toContain(code!);
  });

  it("ignores case, spaces and dashes the user types", () => {
    const [code] = generateRecoveryCodes();
    const typed = ` ${code!.toUpperCase().replace("-", " ")} `;
    expect(hashRecoveryCode(typed)).toBe(hashRecoveryCode(code!));
  });
});
