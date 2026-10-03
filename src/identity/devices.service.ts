import { Inject, Injectable, Logger } from "@nestjs/common";
import { DataSource } from "typeorm";
import { MAILER, type Mailer } from "../adapters/mail/mailer.port.js";
import type { Env } from "../config/env.js";
import { ENV } from "../config/env.module.js";
import { sql } from "../database/sql.js";
import { describeDevice } from "./device.js";
import { newDeviceEmail } from "./emails.js";

/** However many new kinds of device sign in, no more than this many emails a day for one person. */
export const MAX_DEVICE_ALERTS_PER_DAY = 5;

type Tx = Parameters<typeof sql>[0];

export type DeviceSighting = Readonly<{ label: string; alert: boolean }>;

/**
 * Remembers which kinds of device each person signs in from, and points out a new one. The very first
 * device is recorded quietly (there is nothing to compare it with); a repeat is never new.
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Inside the sign-in's transaction, which already holds the person's row, so two sign-ins queue. */
  async record(
    tx: Tx,
    userId: string,
    userAgent: string | undefined,
    ip: string | undefined,
  ): Promise<DeviceSighting & { id: string }> {
    const { key, label } = describeDevice(userAgent);
    const [seen] = await sql<{ total: number; alerts_today: number }>(
      tx,
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE alerted_at > now() - interval '24 hours')::int AS alerts_today
         FROM login_devices WHERE user_id = $1`,
      [userId],
    );
    const [row] = await sql<{ id: string; inserted: boolean }>(
      tx,
      `INSERT INTO login_devices (user_id, device_key, label, last_ip) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, device_key) DO UPDATE SET last_seen_at = now(), last_ip = EXCLUDED.last_ip
       RETURNING id, (xmax = 0) AS inserted`,
      [userId, key, label, ip ?? null],
    );
    const alert =
      row!.inserted && seen!.total > 0 && seen!.alerts_today < MAX_DEVICE_ALERTS_PER_DAY;
    if (alert)
      await sql(tx, `UPDATE login_devices SET alerted_at = now() WHERE id = $1`, [row!.id]);
    return { id: row!.id, label, alert };
  }

  /** After the sign-in has committed. Never throws: a failed email must not undo a sign-in. */
  async alert(userId: string, sighting: DeviceSighting & { id: string }): Promise<void> {
    if (!sighting.alert) return;
    try {
      const [user] = await this.db.query<{ email: string; display_name: string }[]>(
        `SELECT email, display_name FROM users WHERE id = $1`,
        [userId],
      );
      if (!user) return;
      await this.mailer.send({
        to: user.email,
        idempotencyKey: `new-device-${sighting.id}`,
        ...newDeviceEmail({
          to: user.email,
          name: user.display_name,
          device: sighting.label,
          when: new Date(),
          resetLink: `${this.env.WEB_APP_URL}/forgot-password`,
        }),
      });
    } catch (error) {
      this.logger.error({ err: error }, "Could not send the new-device email");
    }
  }
}
