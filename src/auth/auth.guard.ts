import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AccessTokens } from "./access-tokens.js";
import type { AuthenticatedRequest } from "./current-user.decorator.js";
import { IS_PUBLIC } from "./public.decorator.js";
import { SessionService } from "./session.service.js";

/** Deny by default: every route needs a valid access token for an active session unless @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AccessTokens) private readonly accessTokens: AccessTokens,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    const [scheme, token] = (req.header("authorization") ?? "").split(" ");
    if (scheme !== "Bearer" || !token) throw new UnauthorizedException();

    const claims = await this.accessTokens.verify(token);
    if (!claims || !(await this.sessions.isActive(claims.sessionId, claims.userId))) {
      throw new UnauthorizedException();
    }
    req.auth = claims;
    return true;
  }
}
