import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Put,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { DataSource } from "typeorm";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { PinDto, UpdateProfileDto } from "./onboarding.dto.js";
import { PinService } from "./pin.service.js";

export class ProfileResponse {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() mfaEnabled!: boolean;
  @ApiProperty({ enum: ["NG", "GB"], nullable: true }) country!: string | null;
  @ApiProperty({ enum: ["solo", "circle", "both"], nullable: true }) goal!: string | null;
  @ApiProperty() hasPin!: boolean;
  @ApiProperty({ description: "Country, goal and PIN are all set" }) onboarded!: boolean;
}

@ApiTags("profile")
@ApiBearerAuth()
@Controller("me")
export class MeController {
  constructor(
    private readonly db: DataSource,
    private readonly pins: PinService,
  ) {}

  /** Only the caller's own record; the id comes from the session, never from the request. */
  @Get()
  @ApiOkResponse({ type: ProfileResponse })
  async me(@CurrentUser() auth: AccessClaims): Promise<ProfileResponse> {
    const [user] = await this.db.query(
      `SELECT id, email, display_name, country, goal, email_verified AS verified,
              EXISTS (SELECT 1 FROM transaction_pins p WHERE p.user_id = users.id) AS has_pin,
              EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = users.id AND m.confirmed_at IS NOT NULL) AS mfa_enabled
         FROM users WHERE id = $1`,
      [auth.userId],
    );
    if (!user) throw new NotFoundException();
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      emailVerified: user.verified,
      mfaEnabled: user.mfa_enabled,
      country: user.country,
      goal: user.goal,
      hasPin: user.has_pin,
      onboarded: Boolean(user.country && user.goal && user.has_pin),
    };
  }

  @Put("profile")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async updateProfile(
    @CurrentUser() auth: AccessClaims,
    @Body() body: UpdateProfileDto,
  ): Promise<void> {
    await this.db.query(
      `UPDATE users SET country = $2, goal = $3, updated_at = now() WHERE id = $1`,
      [auth.userId, body.country, body.goal],
    );
  }

  @Put("pin")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @ApiNoContentResponse()
  async setPin(@CurrentUser() auth: AccessClaims, @Body() body: PinDto): Promise<void> {
    await this.pins.set(auth.userId, body.pin);
  }

  @Post("pin/verify")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 20, ttl: 15 * 60 * 1000 } })
  @ApiNoContentResponse()
  async verifyPin(@CurrentUser() auth: AccessClaims, @Body() body: PinDto): Promise<void> {
    await this.pins.verify(auth.userId, body.pin);
  }
}
