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
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { IdempotencyKey } from "./idempotency-key.decorator.js";
import { MoneyRoute } from "./money-route.decorator.js";
import { FundDto, PaymentResponse } from "./payments.dto.js";
import { PaymentsService } from "./payments.service.js";

const MINUTE = 60 * 1000;

@ApiTags("payments")
@ApiBearerAuth()
@Controller("payments")
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** Starts adding money. Repeat it with the same Idempotency-Key and nothing is done twice. */
  @Post("fund")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @MoneyRoute({ code: false })
  @ApiOkResponse({ type: PaymentResponse })
  fund(
    @CurrentUser() auth: AccessClaims,
    @Body() body: FundDto,
    @IdempotencyKey() key: string,
  ): Promise<PaymentResponse> {
    return this.payments.fund(auth.userId, body, key);
  }

  /** One of the caller's own payments and where it has got to. */
  @Get(":id")
  @ApiOkResponse({ type: PaymentResponse })
  get(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<PaymentResponse> {
    return this.payments.get(auth.userId, id);
  }
}
