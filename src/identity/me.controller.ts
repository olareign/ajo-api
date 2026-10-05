import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Put,
  Query,
  Req,
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
import type { Request } from "express";
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
import { IsString, Length } from "class-validator";
import { publicTrust } from "../groups/groups.service.js";
import { TrustService } from "../groups/trust.service.js";
import { KycService } from "../kyc/kyc.service.js";
import { sql } from "../database/sql.js";
import { normalizePhone } from "./phone.js";
import { recordSecurityEvent } from "./security-events.js";
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
  @ApiProperty({
    enum: ["checks", "waived", "hold"],
    description: "Whether kycStatus comes from the checks, an approval without them, or a hold",
  })
  kycVia!: string;
  @ApiProperty({ nullable: true, example: "+2348031234567", description: "International form" })
  phone!: string | null;
  @ApiProperty({ description: "False until SMS checks arrive" }) phoneVerified!: boolean;
  @ApiProperty({
    description: "Standing in circles: new, building or trusted, and a score out of 100",
    example: { level: "building", score: 25 },
  })
  trust!: { level: string; score: number };
}

export class PhoneDto {
  @ApiProperty({
    example: "0803 123 4567",
    description: "Local (read by the account's country) or international",
  })
  @IsString()
  @Length(5, 30)
  phone!: string;
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
    private readonly trust: TrustService,
  ) {}

  /** Only the caller's own record; the id comes from the session, never from the request. */
  @Get()
  @ApiOkResponse({ type: ProfileResponse })
  async me(@CurrentUser() auth: AccessClaims): Promise<ProfileResponse> {
    const [user] = await this.db.query(
      `SELECT id, email, display_name, username, country, goal, email_verified AS verified,
              phone, phone_verified_at IS NOT NULL AS phone_verified,
              EXISTS (SELECT 1 FROM transaction_pins p WHERE p.user_id = users.id) AS has_pin,
              EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = users.id AND m.confirmed_at IS NOT NULL) AS mfa_enabled
         FROM users WHERE id = $1`,
      [auth.userId],
    );
    if (!user) throw new NotFoundException();
    const [{ status, tier, via }, trust] = await Promise.all([
      this.kyc.summaryFor(auth.userId),
      this.trust.profile(auth.userId),
    ]);
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
      kycVia: via,
      phone: user.phone,
      phoneVerified: user.phone_verified,
      trust: publicTrust(trust),
    };
  }

  /**
   * Sets the phone number, read in the account's country when written locally. One account per
   * number. It stays "not verified" until SMS checks arrive; changing it clears any verification.
   */
  @Put("phone")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: 15 * 60 * 1000 } })
  @ApiNoContentResponse()
  @ApiConflictResponse({ description: "Another account has that number (`phone_taken`)" })
  async setPhone(
    @CurrentUser() auth: AccessClaims,
    @Body() body: PhoneDto,
    @Req() req: Request,
  ): Promise<void> {
    const [user] = await this.db.query<{ country: string | null; phone: string | null }[]>(
      `SELECT country, phone FROM users WHERE id = $1`,
      [auth.userId],
    );
    const phone = normalizePhone(body.phone, user?.country ?? null);
    if (!phone)
      throw new BadRequestException({
        message:
          "That doesn't look like a phone number. Include the country code if it's from abroad.",
        code: "phone_invalid",
      });
    if (user?.phone === phone) return;
    try {
      await this.db.transaction(async (tx) => {
        await sql(
          tx,
          `UPDATE users SET phone = $2, phone_verified_at = NULL, updated_at = now() WHERE id = $1`,
          [auth.userId, phone],
        );
        await recordSecurityEvent(tx, auth.userId, "phone_changed", {
          ip: req.ip,
          userAgent: req.header("user-agent"),
        });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new ConflictException({
          message: "Another account uses that number.",
          code: "phone_taken",
        });
      throw error;
    }
  }

  @Delete("phone")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async removePhone(@CurrentUser() auth: AccessClaims, @Req() req: Request): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await sql<{ id: string }>(
        tx,
        `UPDATE users SET phone = NULL, phone_verified_at = NULL, updated_at = now()
          WHERE id = $1 AND phone IS NOT NULL RETURNING id`,
        [auth.userId],
      );
      if (rows.length > 0)
        await recordSecurityEvent(tx, auth.userId, "phone_changed", {
          ip: req.ip,
          userAgent: req.header("user-agent"),
        });
    });
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
