import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AdminRole } from "./admin-roles.js";

/** The staff member and session behind a request, set by the admin guard. */
export type AdminPrincipal = Readonly<{
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  sessionId: string;
  ip: string | undefined;
  device: string;
}>;

export type AdminRequest = { admin?: AdminPrincipal };

export const CurrentAdmin = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const admin = ctx.switchToHttp().getRequest<AdminRequest>().admin;
  if (!admin) throw new Error("CurrentAdmin used on a route without the admin guard");
  return admin;
});
