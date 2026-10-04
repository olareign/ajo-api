import { Global, Module } from "@nestjs/common";
import { NotificationsController } from "./notifications.controller.js";
import { Notifications } from "./notifications.service.js";

/** Global: any feature can tell a person something without importing this. */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [Notifications],
  exports: [Notifications],
})
export class NotificationsModule {}
