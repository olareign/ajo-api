import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AccessClaims } from "./access-tokens.js";

export type AuthenticatedRequest = { auth?: AccessClaims };

/** The authenticated user and session, set by the auth guard. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const auth = ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth;
  if (!auth) throw new Error("CurrentUser used on a public route");
  return auth;
});
