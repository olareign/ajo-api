import { Module } from "@nestjs/common";
import { SiteSettings } from "./site-settings.service.js";
import { SiteController } from "./site.controller.js";

/** Public facts about the service that staff keep up to date, such as the support email. */
@Module({ controllers: [SiteController], providers: [SiteSettings], exports: [SiteSettings] })
export class SiteModule {}
