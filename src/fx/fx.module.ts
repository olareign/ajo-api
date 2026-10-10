import { Module } from "@nestjs/common";
import { FxController } from "./fx.controller.js";
import { FxService } from "./fx.service.js";

/** Exchange rates, for showing balances in other currencies. Nothing here moves money. */
@Module({ controllers: [FxController], providers: [FxService], exports: [FxService] })
export class FxModule {}
