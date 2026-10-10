import { Module } from "@nestjs/common";
import { KycModule } from "../kyc/kyc.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { WalletReports } from "./reports.service.js";
import { WalletController } from "./wallet.controller.js";

@Module({
  imports: [KycModule, PaymentsModule],
  controllers: [WalletController],
  providers: [WalletReports],
})
export class WalletModule {}
