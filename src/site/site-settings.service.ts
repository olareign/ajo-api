import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";

type Tx = Parameters<typeof sql>[0];

/** Used until staff set one in the back office. */
export const DEFAULT_SUPPORT_EMAIL = "info@ajo.com";

/** How long one instance keeps the value before reading it again. A change shows within this. */
const CACHE_MS = 60_000;

export type SupportContact = Readonly<{
  supportEmail: string;
  updatedAt: string | null;
  updatedBy: string | null;
}>;

/**
 * Settings staff can change without a deploy: for now, the support email shown to customers. Read
 * on every Help and legal page, so it is cached briefly; a change made here clears this instance's
 * copy at once, and other instances pick it up within a minute.
 */
@Injectable()
export class SiteSettings {
  private cached: { value: SupportContact; until: number } | null = null;

  constructor(private readonly db: DataSource) {}

  async supportContact(now = Date.now()): Promise<SupportContact> {
    if (this.cached && this.cached.until > now) return this.cached.value;
    const [row] = await this.db.query<
      { value: string; updated_at: Date; updated_by: string | null }[]
    >(
      `SELECT s.value, s.updated_at, a.email AS updated_by
         FROM site_settings s LEFT JOIN admin_users a ON a.id = s.updated_by
        WHERE s.key = 'support_email'`,
    );
    const value: SupportContact = row
      ? {
          supportEmail: row.value,
          updatedAt: row.updated_at.toISOString(),
          updatedBy: row.updated_by,
        }
      : { supportEmail: DEFAULT_SUPPORT_EMAIL, updatedAt: null, updatedBy: null };
    this.cached = { value, until: now + CACHE_MS };
    return value;
  }

  /** Sets the support email inside the caller's transaction and answers with what it was before. */
  async setSupportEmail(tx: Tx, email: string, adminId: string): Promise<string> {
    const [before] = await sql<{ value: string }>(
      tx,
      `SELECT value FROM site_settings WHERE key = 'support_email' FOR UPDATE`,
    );
    await sql(
      tx,
      `INSERT INTO site_settings (key, value, updated_by) VALUES ('support_email', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [email, adminId],
    );
    this.cached = null;
    return before?.value ?? DEFAULT_SUPPORT_EMAIL;
  }
}
