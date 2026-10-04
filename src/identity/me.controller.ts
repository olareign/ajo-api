import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { DataSource } from "typeorm";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  PinDto,
  SetUsernameDto,
  UpdateProfileDto,
  UsernameAvailableQuery,
  UsernameAvailableResponse,
} from "./onboarding.dto.js";
import { KycService } from "../kyc/kyc.service.js";
import { PinService } from "./pin.service.js";
import { UsernameService } from "./username.service.js";

export class ProfileResponse {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() mfaEnabled!: boolean;
  @ApiProperty({ nullable: true, example: "ada_ola", description: "Chosen during setup" })
  username!: string | null;
  @ApiProperty({ enum: ["NG", "GB"], nullable: true }) country!: string | null;
  @ApiProperty({ enum: ["solo", "circle", "both"], nullable: true }) goal!: string | null;
  @ApiProperty() hasPin!: boolean;
  @ApiProperty({ description: "Country, goal, username and PIN are all set" }) onboarded!: boolean;
  @ApiProperty({ enum: ["not_started", "in_progress", "pending", "approved", "rejected"] })
  kycStatus!: string;
  @ApiProperty({ enum: [0, 1, 2] }) kycTier!: number;
}

@ApiTags("profile")
@ApiBearerAuth()
@Controller("me")
export class MeController {
  constructor(
    private readonly db: DataSource,
    private readonly pins: PinService,
    private readonly usernames: UsernameService,
    private readonly kyc: KycService,
  ) {}

  /** Only the caller's own record; the id comes from the session, never from the request. */
  @Get()
  @ApiOkResponse({ type: ProfileResponse })
  async me(@CurrentUser() auth: AccessClaims): Promise<ProfileResponse> {
    const [user] = await this.db.query(
      `SELECT id, email, display_name, username, country, goal, email_verified AS verified,
              EXISTS (SELECT 1 FROM transaction_pins p WHERE p.user_id = users.id) AS has_pin,
              EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = users.id AND m.confirmed_at IS NOT NULL) AS mfa_enabled
         FROM users WHERE id = $1`,
      [auth.userId],
    );
    if (!user) throw new NotFoundException();
    const { status, tier } = await this.kyc.summaryFor(auth.userId);
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      username: user.username,
      emailVerified: user.verified,
      mfaEnabled: user.mfa_enabled,
      country: user.country,
      goal: user.goal,
      hasPin: user.has_pin,
      onboarded: Boolean(user.country && user.goal && user.username && user.has_pin),
      kycStatus: status,
      kycTier: tier,
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

  /** For the live check while typing; rate-limited so it cannot be used to list names. */
  @Get("username/available")
  @Throttle({ default: { limit: 40, ttl: 60 * 1000 } })
  @ApiOkResponse({ type: UsernameAvailableResponse })
  async usernameAvailable(
    @Query() query: UsernameAvailableQuery,
  ): Promise<UsernameAvailableResponse> {
    return { available: await this.usernames.isAvailable(query.username) };
  }

  /** Chosen once, during setup. The person comes from the session, never from the request. */
  @Put("username")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: "Taken or kept by the company, or you already have one" })
  async setUsername(
    @CurrentUser() auth: AccessClaims,
    @Body() body: SetUsernameDto,
  ): Promise<void> {
    await this.usernames.set(auth.userId, body.username);
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
