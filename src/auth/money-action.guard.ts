import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { AuthenticatedRequest } from "./current-user.decorator.js";
import { MfaService } from "./mfa.service.js";

export const MFA_CODE_HEADER = "x-ajo-mfa-code";
export const MONEY_ACTION = "moneyAction";
export type MoneyActionOptions = Readonly<{ code?: boolean }>;

/**
 * Runs after the global AuthGuard, so a signed-in session is already established. The code travels
 * in a header so every money route asks for it the same way, whatever its body looks like.
 */
@Injectable()
export class MoneyActionGuard implements CanActivate {
  constructor(
    private readonly mfa: MfaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & AuthenticatedRequest>();
    if (!req.auth) throw new UnauthorizedException();
    const options = this.reflector.get<MoneyActionOptions | undefined>(
      MONEY_ACTION,
      context.getHandler(),
    );
    if (options?.code === false) {
      await this.mfa.requireEnrolled(req.auth.userId);
    } else {
      await this.mfa.requireForMoney(req.auth.userId, req.header(MFA_CODE_HEADER)?.trim());
    }
    return true;
  }
}
