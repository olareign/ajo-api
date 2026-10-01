import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  getSchemaPath,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import type { AccessClaims } from "./access-tokens.js";
import {
  LoginDto,
  LoginMfaDto,
  MfaChallengeResponse,
  RefreshDto,
  TokenPairResponse,
} from "./auth.dto.js";
import { CurrentUser } from "./current-user.decorator.js";
import { Public } from "./public.decorator.js";
import { SessionService, type LoginResult } from "./session.service.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

@ApiTags("auth")
@ApiExtraModels(TokenPairResponse, MfaChallengeResponse)
@Controller("auth")
export class AuthController {
  constructor(private readonly sessions: SessionService) {}

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: FIFTEEN_MINUTES } })
  @ApiOkResponse({
    description:
      "Tokens, or a challenge to finish with POST /auth/login/mfa when a second step is on",
    schema: {
      oneOf: [
        { $ref: getSchemaPath(TokenPairResponse) },
        { $ref: getSchemaPath(MfaChallengeResponse) },
      ],
    },
  })
  login(@Body() body: LoginDto, @Req() req: Request): Promise<LoginResult> {
    return this.sessions.login(body.email, body.password, {
      ip: req.ip,
      userAgent: req.header("user-agent"),
    });
  }

  @Public()
  @Post("login/mfa")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: FIFTEEN_MINUTES } })
  @ApiOkResponse({ type: TokenPairResponse })
  loginMfa(@Body() body: LoginMfaDto, @Req() req: Request): Promise<TokenPairResponse> {
    if ((body.code === undefined) === (body.recoveryCode === undefined)) {
      throw new BadRequestException("Send either a code or a recovery code.");
    }
    return this.sessions.loginWithMfa(
      body.mfaToken,
      { code: body.code, recoveryCode: body.recoveryCode },
      { ip: req.ip, userAgent: req.header("user-agent") },
    );
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
