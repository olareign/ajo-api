import { Global, Module } from "@nestjs/common";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { BREACHED_PASSWORDS } from "./breached-passwords/breached-passwords.port.js";
import { FakeBreachedPasswords } from "./breached-passwords/fake.adapter.js";
import { HibpBreachedPasswords } from "./breached-passwords/hibp.adapter.js";
import { FakeMailer } from "./mail/fake.adapter.js";
import { MAILER } from "./mail/mailer.port.js";
import { ResendMailer } from "./mail/resend.adapter.js";

/**
 * Partner adapters, chosen by configuration. Stand-ins are for development and tests;
 * the environment schema refuses them in production.
 */
@Global()
@Module({
  providers: [
    {
      provide: MAILER,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.MAIL_PROVIDER === "resend"
          ? new ResendMailer(env.RESEND_API_KEY!, env.MAIL_FROM!)
          : new FakeMailer(),
    },
    {
      provide: BREACHED_PASSWORDS,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.BREACHED_PASSWORD_CHECK === "hibp"
          ? new HibpBreachedPasswords()
          : new FakeBreachedPasswords(),
    },
  ],
  exports: [MAILER, BREACHED_PASSWORDS],
})
export class AdaptersModule {}
