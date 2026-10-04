import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import type { Redis } from "ioredis";
import { LoggerModule } from "nestjs-pino";
import type { Env } from "./config/env.js";
import { ENV, EnvModule } from "./config/env.module.js";
import { buildDataSourceOptions } from "./database/database-options.js";
import { AdaptersModule } from "./adapters/adapters.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { FriendsModule } from "./friends/friends.module.js";
import { GroupsModule } from "./groups/groups.module.js";
import { TrustModule } from "./groups/trust.module.js";
import { HealthModule } from "./health/health.module.js";
import { IdentityModule } from "./identity/identity.module.js";
import { KycModule } from "./kyc/kyc.module.js";
import { LedgerModule } from "./ledger/ledger.module.js";
import { buildLoggerOptions } from "./logging/logger-options.js";
import { REDIS_CLIENT, RedisModule } from "./redis/redis.module.js";
import { RedisThrottlerStorage } from "./security/redis-throttler.storage.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { SchedulerModule } from "./scheduler/scheduler.module.js";
import { SavingsModule } from "./savings/savings.module.js";
import { WalletModule } from "./wallet/wallet.module.js";
import { ThrottlerStorageModule } from "./security/throttler-storage.module.js";

/** Default limit for every route; sensitive endpoints (login, OTP, PIN) set stricter ones. */
export const DEFAULT_RATE_LIMIT = { name: "default", ttl: 60_000, limit: 120 };

@Module({
  imports: [
    EnvModule,
    LoggerModule.forRootAsync({ inject: [ENV], useFactory: (env: Env) => buildLoggerOptions(env) }),
    TypeOrmModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ ...buildDataSourceOptions(env), autoLoadEntities: true }),
    }),
    RedisModule,
    SchedulerModule,
    // BullMQ shares the app's Redis client (duplicating it for blocking commands).
    BullModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => ({ connection: redis }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ThrottlerStorageModule],
      inject: [RedisThrottlerStorage],
      useFactory: (storage: RedisThrottlerStorage) => ({
        throttlers: [DEFAULT_RATE_LIMIT],
        storage,
      }),
    }),
    AdaptersModule,
    HealthModule,
    IdentityModule,
    AuthModule,
    KycModule,
    TrustModule,
    FriendsModule,
    GroupsModule,
    LedgerModule,
    NotificationsModule,
    PaymentsModule,
    SavingsModule,
    WalletModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
