import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { isPushEndpoint, PUSH_SENDER, type PushSender } from "../adapters/push/push-sender.port.js";
import { sql } from "../database/sql.js";

/** More than this and the oldest is dropped: a person has a phone or two, not fifty. */
export const MAX_SUBSCRIPTIONS = 10;

@Injectable()
export class PushService {
  constructor(
    private readonly db: DataSource,
    @Inject(PUSH_SENDER) private readonly sender: PushSender | null,
  ) {}

  get enabled(): boolean {
    return this.sender !== null;
  }

  async status(userId: string) {
    const [row] = await this.db.query<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM push_subscriptions WHERE user_id = $1`,
      [userId],
    );
    return {
      enabled: this.enabled,
      publicKey: this.sender?.publicKey ?? null,
      devices: Number(row?.n ?? 0),
    };
  }

  /**
   * Remembers a browser. The same browser subscribing again is one subscription, and one that used
   * to belong to someone else on a shared phone moves to whoever is signed in now.
   */
  async subscribe(
    userId: string,
    input: { endpoint: string; p256dh: string; auth: string },
    device: string,
  ): Promise<void> {
    if (!this.enabled)
      throw new ServiceUnavailableException({
        message: "Push notifications aren't switched on yet.",
        code: "push_off",
      });
    if (!isPushEndpoint(input.endpoint))
      throw new BadRequestException({
        message: "That browser's push address isn't one we can use.",
        code: "push_endpoint_invalid",
      });
    await this.db.transaction(async (tx) => {
      await sql(
        tx,
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (endpoint) DO UPDATE
            SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
                device = EXCLUDED.device, created_at = now()`,
        [userId, input.endpoint, input.p256dh, input.auth, device.slice(0, 100)],
      );
      await sql(
        tx,
        `DELETE FROM push_subscriptions WHERE user_id = $1 AND id NOT IN (
           SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`,
        [userId, MAX_SUBSCRIPTIONS],
      );
    });
  }

  /** Only the caller's own subscription can be removed; anyone else's address is simply not found. */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.db.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [
      userId,
      endpoint,
    ]);
  }
}
