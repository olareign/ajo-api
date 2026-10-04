import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { describeDevice } from "./device.js";
import { createOneTimeToken, hashToken } from "./tokens.js";

/** A remembered device is forgotten after this many days without being used. */
export const TRUSTED_DEVICE_DAYS = 30;
/** More than this and the least recently added is dropped, so a stolen password cannot pile them up. */
export const MAX_TRUSTED_DEVICES = 10;

type Tx = Parameters<typeof sql>[0];

/**
 * Devices that have proved themselves with an authenticator code and been asked to be remembered.
 * Trust is a random secret the device keeps, not a guess from its browser name (which anyone can
 * copy): without the secret, a sign-in is a new device and needs a code.
 */
@Injectable()
export class TrustedDevicesService {
  constructor(private readonly db: DataSource) {}

  /** True if this person has remembered this device. Using it keeps it remembered for another 30 days. */
  async isTrusted(tx: Tx, userId: string, deviceToken: string | undefined): Promise<boolean> {
    if (!deviceToken) return false;
    const rows = await sql(
      tx,
      `UPDATE trusted_devices
          SET last_used_at = now(), expires_at = now() + make_interval(days => $3)
        WHERE user_id = $1 AND token_hash = $2 AND expires_at > now()
        RETURNING id`,
      [userId, hashToken(deviceToken), TRUSTED_DEVICE_DAYS],
    );
    return rows.length > 0;
  }

  /** Remembers the device making this request and returns its secret, which is never stored. */
  async remember(tx: Tx, userId: string, userAgent: string | undefined): Promise<string> {
    const { token, hash } = createOneTimeToken();
    await sql(
      tx,
      `INSERT INTO trusted_devices (user_id, token_hash, label, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [userId, hash, describeDevice(userAgent).label, TRUSTED_DEVICE_DAYS],
    );
    await sql(
      tx,
      `DELETE FROM trusted_devices
        WHERE id IN (SELECT id FROM trusted_devices WHERE user_id = $1
                      ORDER BY created_at DESC, id DESC OFFSET $2)`,
      [userId, MAX_TRUSTED_DEVICES],
    );
    return token;
  }

  /** Inside a transaction, when something else (a new password, turning the app off) takes trust away. */
  async forgetAllIn(tx: Tx, userId: string): Promise<void> {
    await sql(tx, `DELETE FROM trusted_devices WHERE user_id = $1`, [userId]);
  }

  async forgetAll(userId: string): Promise<void> {
    await this.db.query(`DELETE FROM trusted_devices WHERE user_id = $1`, [userId]);
  }
}
