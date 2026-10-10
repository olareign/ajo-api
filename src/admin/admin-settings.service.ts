import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { SiteSettings, type SupportContact } from "../site/site-settings.service.js";
import { AdminAudit } from "./admin-audit.service.js";
import type { AdminPrincipal } from "./admin-principal.js";

/** Back-office changes to what customers see, each one kept in the audit log with before and after. */
@Injectable()
export class AdminSettings {
  constructor(
    private readonly db: DataSource,
    private readonly site: SiteSettings,
    private readonly audit: AdminAudit,
  ) {}

  read(): Promise<SupportContact> {
    return this.site.supportContact(0);
  }

  async setSupportEmail(by: AdminPrincipal, email: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const from = await this.site.setSupportEmail(tx, email, by.id);
      await this.audit.record(
        by,
        "settings.support_email",
        "ok",
        { type: "setting", id: "support_email" },
        { from, to: email, reason },
        tx,
      );
    });
  }
}
