import { Module } from "@nestjs/common";
import { WalletController } from "./wallet.controller.js";

@Module({ controllers: [WalletController] })
export class WalletModule {}
