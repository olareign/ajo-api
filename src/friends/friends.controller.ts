import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { photoVersion } from "./people.js";
import { RequiresKyc } from "../kyc/requires-kyc.decorator.js";
import { Discovery } from "./discovery.service.js";
import {
  BlockedResponse,
  FriendsResponse,
  InviteCodeDto,
  InviteResponse,
  PersonResponse,
  ReferralResponse,
  RelationResponse,
  ReportDto,
  RequestsResponse,
  SearchQuery,
  SuggestionResponse,
  UsernameDto,
} from "./friends.dto.js";
import { Friends, type Relation } from "./friends.service.js";
import { publicTrust } from "../groups/groups.service.js";
import { TrustService } from "../groups/trust.service.js";
import { Invites } from "./invites.service.js";
import { Safety } from "./safety.service.js";

const MINUTE = 60 * 1000;
const tier = (national: boolean): 1 | 2 => (national ? 2 : 1);

@ApiTags("friends")
@ApiBearerAuth()
@RequiresKyc()
@Controller("friends")
export class FriendsController {
  constructor(
    private readonly friends: Friends,
    private readonly safety: Safety,
    private readonly discovery: Discovery,
    private readonly invites: Invites,
    private readonly trust: TrustService,
  ) {}

  /** Verified people whose username starts with what was typed. */
  @Get("search")
  @Throttle({ default: { limit: 40, ttl: MINUTE } })
  @ApiOkResponse({ type: [PersonResponse] })
  async search(
    @CurrentUser() auth: AccessClaims,
    @Query() query: SearchQuery,
  ): Promise<PersonResponse[]> {
    const found = await this.discovery.search(auth.userId, query.q);
    const trust = await this.trust.profiles(found.map((f) => f.id));
    return found.map((f) => ({
      trust: publicTrust(trust.get(f.id)),
      username: f.username,
      displayName: f.display_name,
      relation: f.relation,
      mutualFriends: f.mutual,
      tier: tier(f.national),
      // Pictures are shown only to people already connected, never in search.
      photoVersion: null,
    }));
  }

  @Get("people/:username")
  @Throttle({ default: { limit: 60, ttl: MINUTE } })
  @ApiOkResponse({ type: PersonResponse })
  async person(
    @CurrentUser() auth: AccessClaims,
    @Param("username") username: string,
  ): Promise<PersonResponse> {
    const f = await this.discovery.profile(auth.userId, username);
    if (!f)
      throw new NotFoundException({
        message: "We couldn't find that person.",
        code: "person_not_found",
      });
    return {
      trust: publicTrust((await this.trust.profiles([f.id])).get(f.id)),
      username: f.username,
      displayName: f.display_name,
      relation: f.relation,
      mutualFriends: f.mutual,
      tier: tier(f.national),
      photoVersion: f.relation === "none" ? null : photoVersion(f.photo_v),
    };
  }

  @Get()
  @ApiOkResponse({ type: FriendsResponse })
  async list(@CurrentUser() auth: AccessClaims): Promise<FriendsResponse> {
    const rows = await this.friends.list(auth.userId);
    const trust = await this.trust.profiles(rows.map((r) => r.id));
    return {
      friends: rows.map((r) => ({
        trust: publicTrust(trust.get(r.id)),
        username: r.username,
        displayName: r.display_name,
        since: r.since.toISOString(),
        tier: tier(r.national),
        photoVersion: photoVersion(r.photo_v),
      })),
    };
  }

  @Get("requests")
  @ApiOkResponse({ type: RequestsResponse })
  async requests(@CurrentUser() auth: AccessClaims): Promise<RequestsResponse> {
    const { incoming, outgoing } = await this.friends.requests(auth.userId);
    const shape = (r: (typeof incoming)[number]) => ({
      username: r.username,
      displayName: r.display_name,
      sentAt: r.created_at.toISOString(),
      tier: tier(r.national),
      photoVersion: photoVersion(r.photo_v),
    });
    return { incoming: incoming.map(shape), outgoing: outgoing.map(shape) };
  }

  @Get("suggestions")
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOkResponse({ type: [SuggestionResponse] })
  async suggestions(@CurrentUser() auth: AccessClaims): Promise<SuggestionResponse[]> {
    const rows = await this.discovery.suggestions(auth.userId);
    const trust = await this.trust.profiles(rows.map((r) => r.id));
    return rows.map((r) => ({
      trust: publicTrust(trust.get(r.id)),
      username: r.username,
      displayName: r.display_name,
      relation: r.relation,
      mutualFriends: r.mutual,
      tier: tier(r.national),
      photoVersion: null,
      reason: r.reason,
      mutualNames: r.names,
    }));
  }

  /** Your own invite link: share it, and whoever joins through it is suggested to you as a friend. */
  @Get("invite")
  @ApiOkResponse({ type: InviteResponse })
  invite(@CurrentUser() auth: AccessClaims): Promise<InviteResponse> {
    return this.invites.mine(auth.userId);
  }

  /** Chooses your own invite code; the old link stops working. */
  @Put("invite")
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOkResponse({ type: InviteResponse })
  setInvite(
    @CurrentUser() auth: AccessClaims,
    @Body() body: InviteCodeDto,
  ): Promise<InviteResponse> {
    return this.invites.setCode(auth.userId, body.code);
  }

  /** The people who joined through your invite. */
  @Get("referrals")
  @ApiOkResponse({ type: [ReferralResponse] })
  referrals(@CurrentUser() auth: AccessClaims): Promise<ReferralResponse[]> {
    return this.invites.referrals(auth.userId);
  }

  /** Asks someone to be friends; asking twice changes nothing, and if they had asked you this accepts. */
  @Post("requests")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOkResponse({ type: RelationResponse })
  request(
    @CurrentUser() auth: AccessClaims,
    @Body() body: UsernameDto,
  ): Promise<{ relation: Relation }> {
    return this.friends.request(auth.userId, body.username);
  }

  @Post("requests/:username/accept")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOkResponse({ type: RelationResponse })
  accept(
    @CurrentUser() auth: AccessClaims,
    @Param("username") username: string,
  ): Promise<{ relation: Relation }> {
    return this.friends.acceptFrom(auth.userId, username);
  }

  /** Says no to a request someone sent you. They are not told. */
  @Delete("requests/:username/received")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async decline(
    @CurrentUser() auth: AccessClaims,
    @Param("username") username: string,
  ): Promise<void> {
    await this.friends.decline(auth.userId, username);
  }

  /** Takes back a request you sent. */
  @Delete("requests/:username")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async cancel(
    @CurrentUser() auth: AccessClaims,
    @Param("username") username: string,
  ): Promise<void> {
    await this.friends.cancel(auth.userId, username);
  }

  @Get("blocks")
  @ApiOkResponse({ type: [BlockedResponse] })
  async blocks(@CurrentUser() auth: AccessClaims): Promise<BlockedResponse[]> {
    const rows = await this.safety.blocked(auth.userId);
    return rows.map((r) => ({
      username: r.username,
      displayName: r.display_name,
      blockedAt: r.created_at.toISOString(),
    }));
  }

  /** Blocks someone: any friendship or request between you ends, and neither sees the other. They are not told. */
  @Post("blocks")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiNoContentResponse()
  async block(@CurrentUser() auth: AccessClaims, @Body() body: UsernameDto): Promise<void> {
    await this.safety.block(auth.userId, body.username);
  }

  @Delete("blocks/:username")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async unblock(
    @CurrentUser() auth: AccessClaims,
    @Param("username") username: string,
  ): Promise<void> {
    await this.safety.unblock(auth.userId, username);
  }

  /** Tells the team about someone. One open report per person; it goes to the admin queue. */
  @Post("reports")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiNoContentResponse()
  async report(@CurrentUser() auth: AccessClaims, @Body() body: ReportDto): Promise<void> {
    await this.safety.report(auth.userId, body.username, body.reason, body.details);
  }

  /** Ends a friendship. */
  @Delete(":username")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() auth: AccessClaims,
    @Param("username") username: string,
  ): Promise<void> {
    await this.friends.remove(auth.userId, username);
  }
}
