import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { RequiresKyc } from "../kyc/requires-kyc.decorator.js";
import { IdempotencyKey } from "../payments/idempotency-key.decorator.js";
import {
  EarlyWithdrawDto,
  PlanDetailResponse,
  PlanDto,
  PlansResponse,
  PreviewResponse,
  TopUpDto,
} from "./savings.dto.js";
import { Savings } from "./savings.service.js";

const MINUTE = 60 * 1000;

@ApiTags("savings")
@ApiBearerAuth()
@Controller("savings")
export class SavingsController {
  constructor(private readonly savings: Savings) {}

  /** The days and the total for a plan being thought about. Saves nothing. */
  @Post("preview")
  @HttpCode(HttpStatus.OK)
  @RequiresKyc()
  @ApiOkResponse({ type: PreviewResponse })
  preview(@CurrentUser() auth: AccessClaims, @Body() body: PlanDto): Promise<PreviewResponse> {
    return this.savings.preview(auth.userId, body);
  }

  /** Makes a plan. Repeat it with the same Idempotency-Key and only one plan is made. */
  @Post()
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @RequiresKyc()
  @ApiCreatedResponse({ type: PlanDetailResponse })
  create(
    @CurrentUser() auth: AccessClaims,
    @Body() body: PlanDto,
    @IdempotencyKey() key: string,
  ): Promise<PlanDetailResponse> {
    return this.savings.create(auth.userId, body, key);
  }

  @Get()
  @ApiOkResponse({ type: PlansResponse })
  async list(@CurrentUser() auth: AccessClaims): Promise<PlansResponse> {
    return { plans: await this.savings.list(auth.userId) };
  }

  @Get(":id")
  @ApiOkResponse({ type: PlanDetailResponse })
  detail(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<PlanDetailResponse> {
    return this.savings.detail(auth.userId, id);
  }

  @Post(":id/pause")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @RequiresKyc()
  @ApiOkResponse({ type: PlanDetailResponse })
  pause(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<PlanDetailResponse> {
    return this.savings.pause(auth.userId, id);
  }

  @Post(":id/resume")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @RequiresKyc()
  @ApiOkResponse({ type: PlanDetailResponse })
  resume(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<PlanDetailResponse> {
    return this.savings.resume(auth.userId, id);
  }

  /** Adds money from the wallet to the plan now. The same key twice adds it once. */
  @Post(":id/topup")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @RequiresKyc()
  @ApiOkResponse({ type: PlanDetailResponse })
  topUp(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: TopUpDto,
    @IdempotencyKey() key: string,
  ): Promise<PlanDetailResponse> {
    return this.savings.topUp(auth.userId, id, body.amount, key);
  }

  /** Ends the plan now and brings what is saved back to the wallet. Needs the PIN. */
  @Post(":id/withdraw")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @RequiresKyc()
  @ApiOkResponse({ type: PlanDetailResponse })
  withdraw(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: EarlyWithdrawDto,
  ): Promise<PlanDetailResponse> {
    return this.savings.withdrawEarly(auth.userId, id, body.pin);
  }
}
