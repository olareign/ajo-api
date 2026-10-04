import { Module } from "@nestjs/common";
import { KycModule } from "../kyc/kyc.module.js";
import { DevicesService } from "./devices.service.js";
import { EmailVerification } from "./email-verification.service.js";
import { MeController } from "./me.controller.js";
import { PinService } from "./pin.service.js";
import { PasswordHasher } from "./password-hasher.js";
import { PasswordResetController } from "./password-reset.controller.js";
import { PasswordResetService } from "./password-reset.service.js";
import { SignUpController } from "./sign-up.controller.js";
import { SignUpService } from "./sign-up.service.js";
import { TrustedDevicesService } from "./trusted-devices.service.js";
import { UsernameService } from "./username.service.js";

@Module({
  imports: [KycModule],
  controllers: [SignUpController, PasswordResetController, MeController],
  providers: [
    PasswordHasher,
    EmailVerification,
    SignUpService,
    PasswordResetService,
    PinService,
    UsernameService,
    DevicesService,
    TrustedDevicesService,
  ],
  exports: [PasswordHasher, EmailVerification, DevicesService, TrustedDevicesService],
})
export class IdentityModule {}
