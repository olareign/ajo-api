import { Module } from "@nestjs/common";
import { MeController } from "./me.controller.js";
import { PasswordHasher } from "./password-hasher.js";
import { SignUpController } from "./sign-up.controller.js";
import { SignUpService } from "./sign-up.service.js";

@Module({
  controllers: [SignUpController, MeController],
  providers: [PasswordHasher, SignUpService],
  exports: [PasswordHasher],
})
export class IdentityModule {}
