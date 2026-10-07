import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { describeDevice } from "../identity/device.js";
import { PushStatusResponse, SubscribeDto, UnsubscribeDto } from "./push.dto.js";
import { PushService } from "./push.service.js";
import { Notifications } from "./notifications.service.js";

const HOUR = 60 * 60 * 1000;

@ApiTags("notifications")
@ApiBearerAuth()
@Controller("push")
export class PushController {
  constructor(
    private readonly push: PushService,
    private readonly notifications: Notifications,
  ) {}

  /** Whether push is on, the key a browser needs to subscribe, and how many of the caller's browsers have. */
  @Get()
  @ApiOkResponse({ type: PushStatusResponse })
  status(@CurrentUser() auth: AccessClaims): Promise<PushStatusResponse> {
    return this.push.status(auth.userId);
  }

  @Post("subscriptions")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 20, ttl: HOUR } })
  @ApiNoContentResponse()
  async subscribe(
    @CurrentUser() auth: AccessClaims,
    @Body() body: SubscribeDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.push.subscribe(
      auth.userId,
      { endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth },
      describeDevice(req.header("user-agent")).label,
    );
  }

  @Delete("subscriptions")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async unsubscribe(
    @CurrentUser() auth: AccessClaims,
    @Body() body: UnsubscribeDto,
  ): Promise<void> {
    await this.push.unsubscribe(auth.userId, body.endpoint);
  }

  /** A message to the caller's own browsers, to prove it works. A few an hour. */
  @Post("test")
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 5, ttl: HOUR } })
  @ApiNoContentResponse()
  async test(@CurrentUser() auth: AccessClaims): Promise<void> {
    if (!this.push.enabled)
      throw new ServiceUnavailableException({
        message: "Push notifications aren't switched on yet.",
        code: "push_off",
      });
    await this.notifications.notify(auth.userId, {
      kind: "push.test",
      title: "Notifications are on",
      body: "You'll get messages like this one.",
      link: "/notifications",
      dedupeKey: `push-test-${Date.now()}`,
    });
  }
}
