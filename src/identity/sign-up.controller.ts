import { Public } from "../auth/public.decorator.js";
import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import {
  MessageResponse,
  ResendVerificationDto,
  SignUpDto,
  VerifiedResponse,
  VerifyEmailDto,
} from "./sign-up.dto.js";
import { SignUpService } from "./sign-up.service.js";

const HOUR = 60 * 60 * 1000;

@ApiTags("auth")
@Controller("auth")
@Public()
export class SignUpController {
  constructor(private readonly signUps: SignUpService) {}

  @Post("sign-up")
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: HOUR } })
  @ApiAcceptedResponse({ type: MessageResponse })
  async signUp(@Body() body: SignUpDto): Promise<MessageResponse> {
    await this.signUps.signUp(body);
    return { message: "Check your email to continue." };
  }

  @Post("email/resend")
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 15 * 60 * 1000 } })
  @ApiAcceptedResponse({
    type: MessageResponse,
    description: "Always the same answer, so it cannot be used to find out who has an account",
  })
  async resend(@Body() body: ResendVerificationDto): Promise<MessageResponse> {
    await this.signUps.resendVerification(body.email);
    return { message: "If that account still needs confirming, we've sent a new link." };
  }

  @Post("email/verify")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @ApiOkResponse({ type: VerifiedResponse })
  async verify(@Body() body: VerifyEmailDto): Promise<VerifiedResponse> {
    await this.signUps.verifyEmail(body.token);
    return { verified: true };
  }
}
