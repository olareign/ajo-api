import { Global, Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller.js";
import { Notifications } from "./notifications.service.js";
import { PushController } from "./push.controller.js";
import { PushService } from "./push.service.js";

/** Global: any feature can tell a person something without importing this. */
@Global()
@Module({
  controllers: [NotificationsController, PushController],
  providers: [Notifications, PushService],
  exports: [Notifications],
})
export class NotificationsModule {}
