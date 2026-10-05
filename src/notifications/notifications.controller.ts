import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiTags } from "@nestjs/swagger";
import type { AccessClaims } from "../auth/access-tokens.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import {
  NotificationSettingsDto,
  NotificationSettingsResponse,
  NotificationsQuery,
  NotificationsResponse,
} from "./notifications.dto.js";
import { Notifications } from "./notifications.service.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

@ApiTags("notifications")
@ApiBearerAuth()
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: Notifications) {}

  /** Which optional emails the caller gets. */
  @Get("settings")
  @ApiOkResponse({ type: NotificationSettingsResponse })
  settings(@CurrentUser() auth: AccessClaims): Promise<NotificationSettingsResponse> {
    return this.notifications.settings(auth.userId);
  }

  @Put("settings")
  @ApiOkResponse({ type: NotificationSettingsResponse })
  updateSettings(
    @CurrentUser() auth: AccessClaims,
    @Body() body: NotificationSettingsDto,
  ): Promise<NotificationSettingsResponse> {
    return this.notifications.updateSettings(auth.userId, body);
  }

  /** The caller's own messages, newest first, a page at a time, with how many are unread. */
  @Get()
  @ApiOkResponse({ type: NotificationsResponse })
  async list(
    @CurrentUser() auth: AccessClaims,
    @Query() query: NotificationsQuery,
  ): Promise<NotificationsResponse> {
    const limit = Math.min(Number(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, MAX_LIMIT);
    const page = await this.notifications.list(auth.userId, limit, query.before);
    return {
      items: page.items.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        link: n.link,
        createdAt: n.created_at.toISOString(),
        readAt: n.read_at ? n.read_at.toISOString() : null,
      })),
      next: page.next,
      unread: page.unread,
    };
  }

  @Post("read-all")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async readAll(@CurrentUser() auth: AccessClaims): Promise<void> {
    await this.notifications.markAllRead(auth.userId);
  }

  @Post(":id/read")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async read(
    @CurrentUser() auth: AccessClaims,
    @Param("id", new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.notifications.markRead(auth.userId, id);
  }
}
