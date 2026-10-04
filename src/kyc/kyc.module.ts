import { Module } from "@nestjs/common";
import { KycController } from "./kyc.controller.js";
import { KycService } from "./kyc.service.js";
import { RequiresKycGuard } from "./requires-kyc.guard.js";

@Module({
  controllers: [KycController],
  providers: [KycService, RequiresKycGuard],
  exports: [KycService, RequiresKycGuard],
})
export class KycModule {}
