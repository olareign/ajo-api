import { applyDecorators, UseGuards } from "@nestjs/common";
import { ApiForbiddenResponse } from "@nestjs/swagger";
import { RequiresKycGuard } from "./requires-kyc.guard.js";

/**
 * Put this on every route that saving, joining, creating groups or adding friends goes through.
 * Refused with 403 `kyc_required` until every required step is approved.
 */
export const RequiresKyc = () =>
  applyDecorators(
    UseGuards(RequiresKycGuard),
    ApiForbiddenResponse({ description: "`kyc_required`: identity checks are not approved yet" }),
  );
