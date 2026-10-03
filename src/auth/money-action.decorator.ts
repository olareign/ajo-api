import { applyDecorators, UseGuards } from "@nestjs/common";
import { ApiForbiddenResponse, ApiHeader, ApiUnauthorizedResponse } from "@nestjs/swagger";
import { MFA_CODE_HEADER, MoneyActionGuard } from "./money-action.guard.js";

/**
 * Put this on every route that moves money. It needs the authenticator app to be turned on (403
 * `mfa_enrolment_required` if not) and a current code in `X-Ajo-Mfa-Code` (401 `mfa_code_required`,
 * `mfa_code_wrong` or `mfa_locked`).
 */
export const MoneyAction = () =>
  applyDecorators(
    UseGuards(MoneyActionGuard),
    ApiHeader({
      name: MFA_CODE_HEADER,
      required: true,
      description: "The current 6-digit code from the authenticator app",
    }),
    ApiForbiddenResponse({ description: "`mfa_enrolment_required`: the authenticator app is off" }),
    ApiUnauthorizedResponse({ description: "`mfa_code_required`, `mfa_code_wrong`, `mfa_locked`" }),
  );
