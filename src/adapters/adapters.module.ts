import { Global, Module } from "@nestjs/common";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { BREACHED_PASSWORDS } from "./breached-passwords/breached-passwords.port.js";
import { BOT_CHECK } from "./bot-check/bot-check.port.js";
import { FakeBotCheck } from "./bot-check/fake.adapter.js";
import { TurnstileBotCheck } from "./bot-check/turnstile.adapter.js";
import { FakeBreachedPasswords } from "./breached-passwords/fake.adapter.js";
import { HibpBreachedPasswords } from "./breached-passwords/hibp.adapter.js";
import { FX_RATES } from "./fx/fx-rates.port.js";
import { OpenExchangeRates } from "./fx/openexchangerates.adapter.js";
import { SampleRates } from "./fx/sample.adapter.js";
import { FakeMailer } from "./mail/fake.adapter.js";
import { FakeObjectStore } from "./object-store/fake.adapter.js";
import { OBJECT_STORE } from "./object-store/object-store.port.js";
import { R2ObjectStore } from "./object-store/r2.adapter.js";
import { MAILER } from "./mail/mailer.port.js";
import { ResendMailer } from "./mail/resend.adapter.js";
import { SmtpMailer } from "./mail/smtp.adapter.js";
import { FakePushSender } from "./push/fake.adapter.js";
import { PUSH_SENDER } from "./push/push-sender.port.js";
import { WebPushSender } from "./push/web-push.adapter.js";

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
        env.MAIL_PROVIDER === "smtp"
          ? new SmtpMailer({
              host: env.SMTP_HOST!,
              port: env.SMTP_PORT,
              secure: env.SMTP_SECURE,
              user: env.SMTP_USER!,
              password: env.SMTP_PASSWORD!,
              from: env.SMTP_FROM!,
            })
          : env.MAIL_PROVIDER === "resend"
            ? new ResendMailer({
                apiKey: env.RESEND_API_KEY!,
                from: env.RESEND_FROM!,
              })
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
    {
      provide: BOT_CHECK,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.BOT_CHECK === "turnstile"
          ? new TurnstileBotCheck(env.TURNSTILE_SECRET_KEY!)
          : new FakeBotCheck(),
    },
    {
      provide: OBJECT_STORE,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
          ? new R2ObjectStore({
              accountId: env.R2_ACCOUNT_ID,
              accessKeyId: env.R2_ACCESS_KEY_ID,
              secretAccessKey: env.R2_SECRET_ACCESS_KEY,
              bucket: env.R2_BUCKET,
            })
          : env.NODE_ENV === "production"
            ? null
            : new FakeObjectStore(),
    },
    {
      provide: FX_RATES,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.OPEN_EXCHANGE_RATES_APP_ID
          ? new OpenExchangeRates(env.OPEN_EXCHANGE_RATES_APP_ID)
          : env.NODE_ENV === "production"
            ? null
            : new SampleRates(),
    },
    {
      provide: PUSH_SENDER,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
          ? new WebPushSender({
              publicKey: env.VAPID_PUBLIC_KEY,
              privateKey: env.VAPID_PRIVATE_KEY,
              subject: env.VAPID_SUBJECT,
            })
          : env.NODE_ENV === "production"
            ? null
            : new FakePushSender(),
    },
  ],
  exports: [MAILER, BREACHED_PASSWORDS, BOT_CHECK, OBJECT_STORE, PUSH_SENDER, FX_RATES],
})
export class AdaptersModule {}
