import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { AccessTokens } from "./access-tokens.js";
import { FieldEncryption } from "../crypto/field-encryption.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { MfaController } from "./mfa.controller.js";
import { MfaService } from "./mfa.service.js";
import { MoneyActionGuard } from "./money-action.guard.js";
import { SessionService } from "./session.service.js";
import { Totp } from "./totp.js";

@Module({
  imports: [IdentityModule],
  controllers: [AuthController, MfaController],
  providers: [
    {
      provide: AccessTokens,
      inject: [ENV],
      useFactory: (env: Env) => new AccessTokens(env.JWT_SECRET),
    },
    {
      provide: FieldEncryption,
      inject: [ENV],
      useFactory: (env: Env) => new FieldEncryption(env.FIELD_ENCRYPTION_KEY),
    },
    { provide: Totp, useValue: new Totp() },
    MfaService,
    MoneyActionGuard,
    SessionService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, AccessTokens, MfaService, MoneyActionGuard],
})
export class AuthModule {}
