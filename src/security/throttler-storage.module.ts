import { Module } from "@nestjs/common";
import { RedisThrottlerStorage } from "./redis-throttler.storage.js";

@Module({ providers: [RedisThrottlerStorage], exports: [RedisThrottlerStorage] })
export class ThrottlerStorageModule {}
