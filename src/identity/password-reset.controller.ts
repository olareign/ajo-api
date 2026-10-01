import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiAcceptedResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator.js";
import { ForgotPasswordDto, ResetPasswordDto } from "./password-reset.dto.js";
import { PasswordResetService } from "./password-reset.service.js";
import { MessageResponse } from "./sign-up.dto.js";

const MINUTE = 60 * 1000;

@ApiTags("auth")
@Controller("auth/password")
@Public()
export class PasswordResetController {
  constructor(private readonly resets: PasswordResetService) {}

  @Post("forgot")
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 5, ttl: 60 * MINUTE } })
  @ApiAcceptedResponse({ type: MessageResponse })
  async forgot(@Body() body: ForgotPasswordDto): Promise<MessageResponse> {
    await this.resets.request(body.email);
    return { message: "If that email has an account, we've sent a link to reset the password." };
  }

  @Post("reset")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 15 * MINUTE } })
  @ApiOkResponse({ type: MessageResponse })
  async reset(@Body() body: ResetPasswordDto): Promise<MessageResponse> {
    await this.resets.reset(body.token, body.password);
    return { message: "Your password has been changed. Sign in with the new one." };
  }
}
