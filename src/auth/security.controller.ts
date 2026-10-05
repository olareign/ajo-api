import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import type { AccessClaims } from "./access-tokens.js";
import { AccountSecurity } from "./account-security.service.js";
import { CurrentUser } from "./current-user.decorator.js";
import { MfaService } from "./mfa.service.js";
import {
  ChangePasswordDto,
  ChangePinDto,
  CloseAccountDto,
  IdParam,
  RecoveryCodesOnlyResponse,
  ResetPinDto,
  SecurityEventResponse,
  SessionResponse,
  StepUpDto,
  TrustedDeviceResponse,
} from "./security.dto.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const client = (req: Request) => ({ ip: req.ip, userAgent: req.header("user-agent") });

/** Looking after the account from Me: password, PIN, devices, recovery codes and the security record. */
@ApiTags("security")
@ApiBearerAuth()
@Controller("me/security")
export class SecurityController {
  constructor(
    private readonly security: AccountSecurity,
    private readonly mfa: MfaService,
  ) {}

  /** Needs the current password, and the authenticator code when it is on. Signs other devices out. */
  @Post("password")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: FIFTEEN_MINUTES } })
  @ApiNoContentResponse()
  async changePassword(
    @CurrentUser() auth: AccessClaims,
    @Body() body: ChangePasswordDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.security.changePassword(auth.userId, auth.sessionId, body, client(req));
  }

  @Post("pin")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: FIFTEEN_MINUTES } })
  @ApiNoContentResponse()
  async changePin(
    @CurrentUser() auth: AccessClaims,
    @Body() body: ChangePinDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.security.changePin(auth.userId, body, client(req));
  }

  /** A forgotten PIN: password and authenticator code. */
  @Post("pin/reset")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: FIFTEEN_MINUTES } })
  @ApiNoContentResponse()
  async resetPin(
    @CurrentUser() auth: AccessClaims,
    @Body() body: ResetPinDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.security.resetPin(auth.userId, body, client(req));
  }

  @Post("recovery-codes")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: FIFTEEN_MINUTES } })
  @ApiOkResponse({ type: RecoveryCodesOnlyResponse })
  async renewRecoveryCodes(
    @CurrentUser() auth: AccessClaims,
    @Body() body: StepUpDto,
    @Req() req: Request,
  ): Promise<RecoveryCodesOnlyResponse> {
    return {
      recoveryCodes: await this.mfa.renewRecoveryCodes(
        auth.userId,
        body.password,
        body.code,
        client(req),
      ),
    };
  }

  @Get("sessions")
  @ApiOkResponse({ type: [SessionResponse] })
  sessions(@CurrentUser() auth: AccessClaims): Promise<SessionResponse[]> {
    return this.security.sessions(auth.userId, auth.sessionId);
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: FIFTEEN_MINUTES } })
  @ApiNoContentResponse()
  async signOutDevice(
    @CurrentUser() auth: AccessClaims,
    @Param() params: IdParam,
    @Req() req: Request,
  ): Promise<void> {
    await this.security.signOutDevice(auth.userId, params.id, client(req));
  }

  @Get("trusted-devices")
  @ApiOkResponse({ type: [TrustedDeviceResponse] })
  trustedDevices(@CurrentUser() auth: AccessClaims): Promise<TrustedDeviceResponse[]> {
    return this.security.trustedDevices(auth.userId);
  }

  @Delete("trusted-devices/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: FIFTEEN_MINUTES } })
  @ApiNoContentResponse()
  async forgetDevice(
    @CurrentUser() auth: AccessClaims,
    @Param() params: IdParam,
    @Req() req: Request,
  ): Promise<void> {
    await this.security.forgetDevice(auth.userId, params.id, client(req));
  }

  /** Closes the account once nothing is left in it. Password, and the code when the authenticator is on. */
  @Post("close")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: FIFTEEN_MINUTES } })
  @ApiNoContentResponse()
  async close(
    @CurrentUser() auth: AccessClaims,
    @Body() body: CloseAccountDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.security.close(auth.userId, body, client(req));
  }

  @Get("events")
  @ApiOkResponse({ type: [SecurityEventResponse] })
  events(@CurrentUser() auth: AccessClaims): Promise<SecurityEventResponse[]> {
    return this.security.events(auth.userId);
  }
}
