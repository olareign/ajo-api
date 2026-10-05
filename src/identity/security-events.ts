import { sql } from "../database/sql.js";
import { describeDevice } from "./device.js";

export type SecurityEventKind =
  | "signed_in"
  | "new_device"
  | "password_changed"
  | "password_reset"
  | "pin_changed"
  | "pin_reset"
  | "mfa_on"
  | "mfa_off"
  | "recovery_codes_renewed"
  | "device_signed_out"
  | "signed_out_everywhere"
  | "device_forgotten"
  | "phone_changed"
  | "account_closed";

type Tx = Parameters<typeof sql>[0];

/**
 * Writes one line in the person's security activity, inside the caller's transaction so it is kept
 * exactly when the change is. The device is stored as its plain description ("Chrome on Android"),
 * never the raw browser string.
 */
export async function recordSecurityEvent(
  tx: Tx,
  userId: string,
  kind: SecurityEventKind,
  client: Readonly<{ ip?: string | null; userAgent?: string | null }> = {},
): Promise<void> {
  await sql(tx, `INSERT INTO security_events (user_id, kind, device, ip) VALUES ($1, $2, $3, $4)`, [
    userId,
    kind,
    client.userAgent ? describeDevice(client.userAgent).label.slice(0, 100) : null,
    client.ip ?? null,
  ]);
}
