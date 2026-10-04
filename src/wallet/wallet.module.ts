import { Module } from "@nestjs/common";
import { KycModule } from "../kyc/kyc.module.js";
import { WalletController } from "./wallet.controller.js";

@Module({ imports: [KycModule], controllers: [WalletController] })
export class WalletModule {}
