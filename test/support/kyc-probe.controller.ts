import { Controller, HttpCode, Post } from "@nestjs/common";
import { RequiresKyc } from "../../src/kyc/requires-kyc.decorator.js";

/** Stands in for the first route that needs an approved person (saving, joining, groups, friends). */
@Controller("test/kyc")
export class KycProbeController {
  @Post()
  @HttpCode(200)
  @RequiresKyc()
  act(): { ok: true } {
    return { ok: true };
  }
}
