import { Global, Module } from "@nestjs/common";
import { TrustService } from "./trust.service.js";

/** Global: friends, groups and (later) the admin queue all read someone's trust. */
@Global()
@Module({ providers: [TrustService], exports: [TrustService] })
export class TrustModule {}
