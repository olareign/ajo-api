import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import type { Redis } from "ioredis";
import { LoggerModule } from "nestjs-pino";
import type { Env } from "./config/env.js";
import { ENV, EnvModule } from "./config/env.module.js";
import { buildDataSourceOptions } from "./database/database-options.js";
import { buildLoggerOptions } from "./logging/logger-options.js";
import { REDIS_CLIENT, RedisModule } from "./redis/redis.module.js";

/**
 * Background worker: processes BullMQ queues (debits, retries, payouts, reminders,
 * reconciliation). Queues and processors are added by each phase's modules.
 */
@Module({
  imports: [
    EnvModule,
    LoggerModule.forRootAsync({ inject: [ENV], useFactory: (env: Env) => buildLoggerOptions(env) }),
    TypeOrmModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({ ...buildDataSourceOptions(env), autoLoadEntities: true }),
    }),
    RedisModule,
    BullModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => ({ connection: redis }),
    }),
  ],
})
export class WorkerModule {}
