import { Controller, HttpCode, Post } from "@nestjs/common";
import { MoneyAction } from "../../src/auth/money-action.decorator.js";

/** Stands in for the first real money route, so the gate is proven before that route exists. */
@Controller("test/money")
export class MoneyProbeController {
  @Post()
  @HttpCode(200)
  @MoneyAction()
  move(): { moved: true } {
    return { moved: true };
  }
}
