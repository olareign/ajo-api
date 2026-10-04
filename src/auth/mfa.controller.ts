import { Body, Controller, Delete, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import { DataSource } from "typeorm";
import type { AccessClaims } from "./access-tokens.js";
import {
  ConfirmMfaDto,
  DisableMfaDto,
  EnrolMfaResponse,
  RecoveryCodesResponse,
} from "./auth.dto.js";
import { CurrentUser } from "./current-user.decorator.js";
import { MfaService } from "./mfa.service.js";

const FIFTEEN_MINUTES = 15 * 60 * 1000;

@ApiTags("auth")
@ApiBearerAuth()
@Controller("auth/mfa/totp")
export class MfaController {
  constructor(
    private readonly mfa: MfaService,
    private readonly db: DataSource,
  ) {}

  /** Begins setup: returns the secret and QR link. Nothing is turned on until a code is confirmed. */
  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: FIFTEEN_MINUTES } })
  @ApiOkResponse({ type: EnrolMfaResponse })
  @ApiConflictResponse({ description: "Already turned on" })
  async enrol(@CurrentUser() auth: AccessClaims): Promise<EnrolMfaResponse> {
    const [user] = await this.db.query<{ email: string }[]>(
      `SELECT email FROM users WHERE id = $1`,
      [auth.userId],
    );
    return this.mfa.enrol(auth.userId, user!.email);
  }

  @Post("confirm")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: FIFTEEN_MINUTES } })
  @ApiOkResponse({ type: RecoveryCodesResponse })
  async confirm(
    @CurrentUser() auth: AccessClaims,
    @Body() body: ConfirmMfaDto,
    @Req() req: Request,
  ): Promise<RecoveryCodesResponse> {
    return this.mfa.confirm(auth.userId, body.code, req.header("user-agent"));
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: FIFTEEN_MINUTES } })
  @ApiNoContentResponse()
  async disable(@CurrentUser() auth: AccessClaims, @Body() body: DisableMfaDto): Promise<void> {
    await this.mfa.disable(auth.userId, body.password, body.code);
  }
}
