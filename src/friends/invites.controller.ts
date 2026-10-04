import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator.js";
import { InviterResponse } from "./friends.dto.js";
import { Invites } from "./invites.service.js";

@ApiTags("friends")
@Controller("invites")
export class InvitesController {
  constructor(private readonly invites: Invites) {}

  /**
   * Who an invite link is from, for the page the link opens before anyone has an account. Gives a first
   * name and handle only, and the same "not found" for a wrong code as for a closed account.
   */
  @Get(":code")
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOkResponse({ type: InviterResponse })
  async whose(@Param("code") code: string): Promise<InviterResponse> {
    const inviter = await this.invites.whose(code);
    if (!inviter)
      throw new NotFoundException({
        message: "That invite isn't valid.",
        code: "invite_not_found",
      });
    return inviter;
  }
}
