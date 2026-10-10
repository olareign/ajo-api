import { ADMIN_ROLES, can, permissionsOf } from "./admin-roles.js";

describe("admin roles", () => {
  it("lets the owner do everything, and only the owner manage the team", () => {
    for (const p of permissionsOf("support")) expect(can("owner", p)).toBe(true);
    expect(can("owner", "team:manage")).toBe(true);
    expect(can("owner", "settings:manage")).toBe(true);
    for (const role of ADMIN_ROLES.filter((r) => r !== "owner")) {
      expect(can(role, "team:manage")).toBe(false);
      expect(can(role, "settings:manage")).toBe(false);
    }
  });

  it("keeps identity decisions and the audit log to compliance and the owner", () => {
    for (const role of ["support", "finance"] as const) {
      expect(can(role, "kyc:decide")).toBe(false);
      expect(can(role, "kyc:read")).toBe(false);
      expect(can(role, "audit:read")).toBe(false);
    }
    expect(can("compliance", "kyc:decide")).toBe(true);
    expect(can("compliance", "audit:read")).toBe(true);
  });

  it("lets only finance and the owner change a recovery case, and support cannot reinstate", () => {
    expect(can("finance", "cases:write")).toBe(true);
    expect(can("compliance", "cases:write")).toBe(false);
    expect(can("support", "cases:write")).toBe(false);
    expect(can("support", "users:reinstate")).toBe(false);
    expect(can("support", "users:suspend")).toBe(true);
  });

  it("gives nothing to a role it does not know, however it is spelled", () => {
    for (const role of ["", "admin", "OWNER", "__proto__", "constructor", "toString"]) {
      expect(permissionsOf(role)).toEqual([]);
      expect(can(role, "users:read")).toBe(false);
    }
  });
});
