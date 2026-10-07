import {
  applyDecorators,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ApiBearerAuth } from "@nestjs/swagger";
import type { Request } from "express";
import { Public } from "../auth/public.decorator.js";
import { AdminAudit } from "./admin-audit.service.js";
import { AdminAuth } from "./admin-auth.service.js";
import type { AdminRequest } from "./admin-principal.js";
import { can, type Permission } from "./admin-roles.js";

const PERMISSION = "adminPermission";

/**
 * Staff sign in separately from customers, so these routes are outside the customer guard (Public) and
 * behind this one instead: a customer's token means nothing here, and a staff token means nothing on a
 * customer route. A route that names a permission needs the role to hold it; one that names none
 * needs only to be signed in. A refusal is written to the audit log.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AdminAuth,
    private readonly audit: AdminAudit,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & AdminRequest>();
    const [scheme, token] = (req.header("authorization") ?? "").split(" ");
    if (scheme !== "Bearer" || !token) throw new UnauthorizedException();
    const admin = await this.auth.authenticate(token, {
      ip: req.ip,
      userAgent: req.header("user-agent"),
    });
    if (!admin) throw new UnauthorizedException();
    const permission = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (permission && !can(admin.role, permission)) {
      await this.audit.record(admin, `denied:${permission}`.slice(0, 60), "denied", undefined, {
        route: `${req.method} ${req.path}`.slice(0, 120),
      });
      throw new ForbiddenException({
        message: "Your role can't do this.",
        code: "admin_forbidden",
      });
    }
    req.admin = admin;
    return true;
  }
}

/** A staff route; with a permission, only roles that hold it. */
export const AdminRoute = (permission?: Permission) =>
  applyDecorators(
    Public(),
    UseGuards(AdminGuard),
    SetMetadata(PERMISSION, permission),
    ApiBearerAuth(),
  );
