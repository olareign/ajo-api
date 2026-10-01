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
      `SELECT id, email, display_name, email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1`,
      [auth.userId],
    );
    if (!user) throw new NotFoundException();
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      emailVerified: user.verified,
    };
  }
}
