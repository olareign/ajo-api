import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { IdempotencyKey } from "./idempotency-key.decorator.js";
import { MoneyRoute } from "./money-route.decorator.js";
import {
  FundDto,
  PayoutAccountDto,
  PayoutAccountResponse,
  PaymentResponse,
  WithdrawDto,
} from "./payments.dto.js";
import { PayoutAccounts } from "./payout-accounts.service.js";
import { Withdrawals } from "./withdrawals.service.js";
import { PaymentsService } from "./payments.service.js";

const MINUTE = 60 * 1000;

@ApiTags("payments")
@ApiBearerAuth()
@Controller("payments")
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly withdrawals: Withdrawals,
    private readonly accounts: PayoutAccounts,
  ) {}

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

  /**
   * Takes money out to the person's bank account. Needs the PIN and a fresh authenticator code. The
   * money is held at once and is only released or returned when the bank has said what happened.
   */
  @Post("withdraw")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @MoneyRoute()
  @ApiOkResponse({ type: PaymentResponse })
  withdraw(
    @CurrentUser() auth: AccessClaims,
    @Body() body: WithdrawDto,
    @IdempotencyKey() key: string,
  ): Promise<PaymentResponse> {
    return this.withdrawals.start(auth.userId, body, key);
  }

  /** Where withdrawals go, if the person has chosen. */
  @Get("payout-account")
  @ApiOkResponse({ type: PayoutAccountResponse, description: "Null when none is set" })
  payoutAccount(@CurrentUser() auth: AccessClaims): Promise<PayoutAccountResponse | null> {
    return this.accounts.get(auth.userId);
  }

  /** Sets the account withdrawals go to. The bank must say it is in the person's own name. */
  @Put("payout-account")
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @MoneyRoute()
  @ApiOkResponse({ type: PayoutAccountResponse })
  setPayoutAccount(
    @CurrentUser() auth: AccessClaims,
    @Body() body: PayoutAccountDto,
  ): Promise<PayoutAccountResponse> {
    return this.accounts.set(auth.userId, body);
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
