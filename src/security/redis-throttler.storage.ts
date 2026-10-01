import { Inject, Injectable } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";
import type { Redis } from "ioredis";
import { REDIS_CLIENT } from "../redis/redis.module.js";

/**
 * Fixed window per key with a block period, in one atomic Lua script so concurrent requests
 * on any number of API instances cannot slip past the limit. Durations in are milliseconds;
 * the record's times out are seconds, matching the built-in in-memory storage.
 */
const SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])

local blockedFor = redis.call('PTTL', blockKey)
if blockedFor > 0 then
  return { limit + 1, math.max(redis.call('PTTL', hitsKey), 0), 1, blockedFor }
end

local hits = redis.call('INCR', hitsKey)
if hits == 1 then
  redis.call('PEXPIRE', hitsKey, ttl)
end
local window = redis.call('PTTL', hitsKey)

if hits > limit then
  redis.call('SET', blockKey, '1', 'PX', block)
  return { hits, window, 1, block }
end
return { hits, window, 0, 0 }
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ) {
    const base = `throttle:${throttlerName}:${key}`;
    const [totalHits, windowMs, blocked, blockMs] = (await this.redis.eval(
      SCRIPT,
      2,
      `${base}:hits`,
      `${base}:block`,
      ttl,
      limit,
      blockDuration > 0 ? blockDuration : ttl,
    )) as [number, number, number, number];
    return {
      totalHits,
      timeToExpire: Math.ceil(windowMs / 1000),
      isBlocked: blocked === 1,
      timeToBlockExpire: Math.ceil(blockMs / 1000),
    };
  }
}
