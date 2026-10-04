import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthenticatedRequest } from "../auth/current-user.decorator.js";
import { KycService } from "./kyc.service.js";

/** Runs after the global AuthGuard, so the person is already signed in. */
@Injectable()
export class RequiresKycGuard implements CanActivate {
  constructor(private readonly kyc: KycService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    if (!req.auth) throw new UnauthorizedException();
    if (!(await this.kyc.isApproved(req.auth.userId))) {
      throw new ForbiddenException({
        message: "Finish verifying your identity first.",
        code: "kyc_required",
      });
    }
    return true;
  }
}
