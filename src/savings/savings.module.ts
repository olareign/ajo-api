import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { KycModule } from "../kyc/kyc.module.js";
import { LedgerModule } from "../ledger/ledger.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { SavingsController } from "./savings.controller.js";
import { SavingsRunner } from "./savings-runner.js";
import { Savings } from "./savings.service.js";

@Module({
  imports: [LedgerModule, KycModule, IdentityModule, PaymentsModule],
  controllers: [SavingsController],
  providers: [Savings, SavingsRunner],
  exports: [Savings, SavingsRunner],
})
export class SavingsModule {}
