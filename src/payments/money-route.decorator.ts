import { applyDecorators, SetMetadata, UseGuards } from "@nestjs/common";
import { ApiForbiddenResponse, ApiHeader, ApiUnauthorizedResponse } from "@nestjs/swagger";
import {
  MFA_CODE_HEADER,
  MONEY_ACTION,
  MoneyActionGuard,
  type MoneyActionOptions,
} from "../auth/money-action.guard.js";
import { RequiresKycGuard } from "../kyc/requires-kyc.guard.js";

/**
 * For routes where money moves: identity checks approved first (403 `kyc_required`), then the
 * authenticator app (403 `mfa_enrolment_required`, and for money going out a fresh code in
 * `X-Ajo-Mfa-Code`). One decorator, so the order of the two checks is the same everywhere.
 */
export const MoneyRoute = (options: MoneyActionOptions = {}) =>
  applyDecorators(
    SetMetadata(MONEY_ACTION, options),
    UseGuards(RequiresKycGuard, MoneyActionGuard),
    ...(options.code === false
      ? []
      : [
          ApiHeader({
            name: MFA_CODE_HEADER,
            required: true,
            description: "The current 6-digit code from the authenticator app",
          }),
        ]),
    ApiForbiddenResponse({ description: "`kyc_required` or `mfa_enrolment_required`" }),
    ApiUnauthorizedResponse({ description: "`mfa_code_required`, `mfa_code_wrong`, `mfa_locked`" }),
  );
