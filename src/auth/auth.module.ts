import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { AccessTokens } from "./access-tokens.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { SessionService } from "./session.service.js";

@Module({
  imports: [IdentityModule],
  controllers: [AuthController],
  providers: [
    {
      provide: AccessTokens,
      inject: [ENV],
      useFactory: (env: Env) => new AccessTokens(env.JWT_SECRET),
    },
    SessionService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [SessionService, AccessTokens],
})
export class AuthModule {}
