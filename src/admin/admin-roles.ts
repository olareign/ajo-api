export const ADMIN_ROLES = ["owner", "support", "compliance", "finance"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export type Permission =
  | "overview:read"
  | "users:read"
  | "users:suspend"
  | "users:reinstate"
  | "kyc:read"
  | "kyc:decide"
  | "cases:read"
  | "cases:write"
  | "audit:read"
  | "team:manage";

/**
 * What each role may do, and nothing more. A new permission is given to no one until it is listed
 * here, and a role that is not listed (or a value that is not a role) can do nothing at all.
 */
const GRANTS: Readonly<Record<AdminRole, readonly Permission[]>> = {
  owner: [
    "overview:read",
    "users:read",
    "users:suspend",
    "users:reinstate",
    "kyc:read",
    "kyc:decide",
    "cases:read",
    "cases:write",
    "audit:read",
    "team:manage",
  ],
  support: ["overview:read", "users:read", "users:suspend", "cases:read"],
  compliance: [
    "overview:read",
    "users:read",
    "users:suspend",
    "users:reinstate",
    "kyc:read",
    "kyc:decide",
    "cases:read",
    "audit:read",
  ],
  finance: ["overview:read", "users:read", "cases:read", "cases:write"],
};

export function can(role: string, permission: Permission): boolean {
  return Object.hasOwn(GRANTS, role) && GRANTS[role as AdminRole].includes(permission);
}

export const permissionsOf = (role: string): readonly Permission[] =>
  Object.hasOwn(GRANTS, role) ? GRANTS[role as AdminRole] : [];
