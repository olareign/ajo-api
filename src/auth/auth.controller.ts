import { Body, Controller, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import type { AccessClaims } from "./access-tokens.js";
import { LoginDto, RefreshDto, TokenPairResponse } from "./auth.dto.js";
import { CurrentUser } from "./current-user.decorator.js";
import { Public } from "./public.decorator.js";
import { SessionService } from "./session.service.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly sessions: SessionService) {}

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: FIFTEEN_MINUTES } })
  @ApiOkResponse({ type: TokenPairResponse })
  login(@Body() body: LoginDto, @Req() req: Request): Promise<TokenPairResponse> {
    return this.sessions.login(body.email, body.password, {
      ip: req.ip,
      userAgent: req.header("user-agent"),
    });
  }

  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: FIFTEEN_MINUTES } })
  @ApiOkResponse({ type: TokenPairResponse })
  refresh(@Body() body: RefreshDto): Promise<TokenPairResponse> {
    return this.sessions.refresh(body.refreshToken);
  }

  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiNoContentResponse()
  async logout(@CurrentUser() auth: AccessClaims): Promise<void> {
    await this.sessions.logout(auth.sessionId);
  }

  @Post("logout-all")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiNoContentResponse()
  async logoutAll(@CurrentUser() auth: AccessClaims): Promise<void> {
    await this.sessions.logoutAll(auth.userId);
  }
}
