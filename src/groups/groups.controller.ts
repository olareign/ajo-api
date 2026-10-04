import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { RequiresKyc } from "../kyc/requires-kyc.decorator.js";
import { IdempotencyKey } from "../payments/idempotency-key.decorator.js";
import { GroupPicks } from "./group-picks.js";
import {
  AnswerDto,
  DiscoverListResponse,
  GroupDetailResponse,
  GroupDto,
  GroupPreviewResponse,
  GroupsResponse,
  GroupSummaryResponse,
  JoinDto,
  PickDto,
  SwapResponse,
  UsernameBody,
} from "./groups.dto.js";
import { Groups } from "./groups.service.js";

const MINUTE = 60 * 1000;

@ApiTags("groups")
@ApiBearerAuth()
@RequiresKyc()
@Controller("groups")
export class GroupsController {
  constructor(
    private readonly groups: Groups,
    private readonly picks: GroupPicks,
  ) {}

  /** What a circle would be: its round days, pot and deposits. Saves nothing. */
  @Post("preview")
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: GroupPreviewResponse })
  preview(@CurrentUser() auth: AccessClaims, @Body() body: GroupDto) {
    return this.groups.preview(auth.userId, body);
  }

  /** Starts a circle, with you as its first member. Repeat it with the same Idempotency-Key and only one is made. */
  @Post()
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @ApiCreatedResponse({ type: GroupDetailResponse })
  create(@CurrentUser() auth: AccessClaims, @Body() body: GroupDto, @IdempotencyKey() key: string) {
    return this.groups.create(auth.userId, body, key);
  }

  @Get()
  @ApiOkResponse({ type: GroupsResponse })
  async mine(@CurrentUser() auth: AccessClaims): Promise<{ groups: unknown[] }> {
    return { groups: await this.groups.mine(auth.userId) };
  }

  /** Public circles still open, best fit first: friends in them, friends of friends, then your own savings. */
  @Get("discover")
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOkResponse({ type: DiscoverListResponse })
  async discover(@CurrentUser() auth: AccessClaims): Promise<{ groups: unknown[] }> {
    return { groups: await this.groups.discover(auth.userId) };
  }

  /** A circle by invite code, as someone about to join sees it. */
  @Get("code/:code")
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOkResponse({ type: GroupSummaryResponse })
  byCode(@CurrentUser() auth: AccessClaims, @Param("code") code: string) {
    return this.groups.byCode(auth.userId, code);
  }

  @Post("join")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @ApiOkResponse({ type: GroupDetailResponse })
  join(@CurrentUser() auth: AccessClaims, @Body() body: JoinDto) {
    return this.groups.join(auth.userId, { code: body.code });
  }

  @Get(":id")
  @ApiOkResponse({ type: GroupDetailResponse })
  detail(@CurrentUser() auth: AccessClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.groups.detail(auth.userId, id);
  }

  /** Joins a public circle. A private one needs its invite code. */
  @Post(":id/join")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @ApiOkResponse({ type: GroupDetailResponse })
  joinPublic(@CurrentUser() auth: AccessClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.groups.join(auth.userId, { id });
  }

  @Post(":id/leave")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @ApiOkResponse({ type: GroupDetailResponse })
  leave(@CurrentUser() auth: AccessClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.groups.leave(auth.userId, id);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: MINUTE } })
  @ApiOkResponse({ type: GroupDetailResponse })
  cancel(@CurrentUser() auth: AccessClaims, @Param("id", new ParseUUIDPipe()) id: string) {
    return this.groups.cancel(auth.userId, id);
  }

  /** Tells one of your friends about the circle. */
  @Post(":id/invite")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiNoContentResponse()
  async invite(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: UsernameBody,
  ): Promise<void> {
    await this.groups.inviteFriend(auth.userId, id, body.username);
  }

  /** Takes a turn, while picking is open. */
  @Post(":id/pick")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: MINUTE } })
  @ApiOkResponse({ type: GroupDetailResponse })
  pick(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: PickDto,
  ) {
    return this.picks.pick(auth.userId, id, body.spot);
  }

  @Get(":id/swaps")
  @ApiOkResponse({ type: [SwapResponse] })
  async swaps(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<SwapResponse[]> {
    const rows = await this.picks.pendingSwaps(auth.userId, id);
    return rows.map((r) => ({
      id: r.id,
      fromUsername: r.from_username,
      fromName: r.from_name,
      toUsername: r.to_username,
      toName: r.to_name,
      incoming: r.incoming,
    }));
  }

  /** Asks another member to trade turns, before the first round. */
  @Post(":id/swaps")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @ApiOkResponse({ type: GroupDetailResponse })
  proposeSwap(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: UsernameBody,
  ) {
    return this.picks.proposeSwap(auth.userId, id, body.username);
  }

  @Post(":id/swaps/:swapId/answer")
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: MINUTE } })
  @ApiOkResponse({ type: GroupDetailResponse })
  answerSwap(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Param("swapId", new ParseUUIDPipe()) swapId: string,
    @Body() body: AnswerDto,
  ) {
    return this.picks.answerSwap(auth.userId, id, swapId, body.accept);
  }
}
