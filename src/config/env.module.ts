import { Global, Module } from "@nestjs/common";
import { loadEnv } from "./env.js";

export const ENV = Symbol("ENV");

/** Validated environment, loaded once at startup; the app fails fast if it is invalid. */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv(process.env) }],
  exports: [ENV],
})
export class EnvModule {}
