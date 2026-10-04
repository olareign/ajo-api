import { Module } from "@nestjs/common";
import { KycModule } from "../kyc/kyc.module.js";
import { Discovery } from "./discovery.service.js";
import { FriendsController } from "./friends.controller.js";
import { Friends } from "./friends.service.js";
import { InvitesController } from "./invites.controller.js";
import { Invites } from "./invites.service.js";
import { Safety } from "./safety.service.js";

@Module({
  imports: [KycModule],
  controllers: [FriendsController, InvitesController],
  providers: [Friends, Safety, Discovery, Invites],
  exports: [Friends, Safety, Discovery, Invites],
})
export class FriendsModule {}
