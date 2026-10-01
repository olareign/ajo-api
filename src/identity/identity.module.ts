import { Module } from "@nestjs/common";
import { MeController } from "./me.controller.js";
import { PasswordHasher } from "./password-hasher.js";
import { PasswordResetController } from "./password-reset.controller.js";
import { PasswordResetService } from "./password-reset.service.js";
import { SignUpController } from "./sign-up.controller.js";
import { SignUpService } from "./sign-up.service.js";

@Module({
  controllers: [SignUpController, PasswordResetController, MeController],
  providers: [PasswordHasher, SignUpService, PasswordResetService],
  exports: [PasswordHasher],
})
export class IdentityModule {}
