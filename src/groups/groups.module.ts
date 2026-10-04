import { Module } from "@nestjs/common";
import { KycModule } from "../kyc/kyc.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { GroupLifecycle } from "./group-lifecycle.js";
import { GroupPicks } from "./group-picks.js";
import { GroupRunner } from "./group-runner.js";
import { GroupsController } from "./groups.controller.js";
import { Groups } from "./groups.service.js";

@Module({
  imports: [LedgerModule, KycModule, PaymentsModule],
  controllers: [GroupsController],
  providers: [Groups, GroupLifecycle, GroupPicks, GroupRunner],
  exports: [Groups, GroupRunner],
})
export class GroupsModule {}
