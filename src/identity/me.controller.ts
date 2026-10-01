import { Controller, Get, NotFoundException } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from "@nestjs/swagger";
import { DataSource } from "typeorm";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";

export class ProfileResponse {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() mfaEnabled!: boolean;
}

@ApiTags("profile")
@ApiBearerAuth()
@Controller("me")
export class MeController {
  constructor(private readonly db: DataSource) {}

  /** Only the caller's own record; the id comes from the session, never from the request. */
  @Get()
  @ApiOkResponse({ type: ProfileResponse })
  async me(@CurrentUser() auth: AccessClaims): Promise<ProfileResponse> {
    const [user] = await this.db.query(
      `SELECT id, email, display_name, email_verified_at IS NOT NULL AS verified,
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
    };
  }
}
