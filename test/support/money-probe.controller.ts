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

  /** Money coming in: the second lock must exist, but a fresh code is not asked for each time. */
  @Post("in")
  @HttpCode(200)
  @MoneyAction({ code: false })
  moveIn(): { moved: true } {
    return { moved: true };
  }
}
