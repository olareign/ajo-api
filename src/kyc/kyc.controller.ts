import { Controller, Get } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { DataSource } from "typeorm";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { KycResponse } from "./kyc.dto.js";
import { KycService } from "./kyc.service.js";
import { CONNECTED } from "./partners.js";

@ApiTags("kyc")
@ApiBearerAuth()
@Controller("kyc")
export class KycController {
  constructor(
    private readonly kyc: KycService,
    private readonly db: DataSource,
  ) {}

  /** Only the caller's own progress; the person comes from the session, never from the request. */
  @Get()
  @ApiOkResponse({ type: KycResponse })
  async status(@CurrentUser() auth: AccessClaims): Promise<KycResponse> {
    const [user] = await this.db.query<{ country: string | null }[]>(
      `SELECT country FROM users WHERE id = $1`,
      [auth.userId],
    );
    const summary = await this.kyc.summaryFor(auth.userId);
    return { connected: CONNECTED.identity, country: user?.country ?? null, ...summary };
  }
}
