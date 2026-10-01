import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  UnprocessableEntityException,
} from "@nestjs/common";
import { DataSource } from "typeorm";
import { isAcceptablePin } from "./pin-policy.js";
import { PasswordHasher } from "./password-hasher.js";

export const MAX_PIN_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

@Injectable()
export class PinService {
  constructor(
    private readonly db: DataSource,
    private readonly hasher: PasswordHasher,
  ) {}

  /** First PIN only; changing one needs the password and comes with account settings. */
  async set(userId: string, pin: string): Promise<void> {
    if (!isAcceptablePin(pin)) {
      throw new BadRequestException("Choose a PIN that isn't a repeat, a run of digits or a pair.");
    }
    const hash = await this.hasher.hash(pin);
    const rows = await this.db.query<unknown[]>(
      `INSERT INTO transaction_pins (user_id, pin_hash) VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
      [userId, hash],
    );
    if (rows.length === 0) throw new ConflictException("You already have a PIN.");
  }

  /** Throws unless the PIN is right; five wrong tries lock it for 15 minutes, right PIN included. */
  async verify(userId: string, pin: string): Promise<void> {
    const outcome = await this.db.transaction(async (tx) => {
      const [row] = await tx.query<
        { pin_hash: string; failed_attempts: number; locked: boolean; minutes_left: string }[]
      >(
        `SELECT pin_hash, failed_attempts, coalesce(locked_until > now(), false) AS locked,
                coalesce(ceil(extract(epoch FROM (locked_until - now())) / 60), 0)::text AS minutes_left
           FROM transaction_pins WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (!row) return { kind: "none" } as const;
      if (row.locked) return { kind: "locked", minutes: Number(row.minutes_left) } as const;
      if (await this.hasher.verify(row.pin_hash, pin)) {
        await tx.query(
          `UPDATE transaction_pins SET failed_attempts = 0, locked_until = NULL, updated_at = now() WHERE user_id = $1`,
          [userId],
        );
        return { kind: "ok" } as const;
      }
      const failed = row.failed_attempts + 1;
      const lock = failed >= MAX_PIN_ATTEMPTS;
      await tx.query(
        `UPDATE transaction_pins
            SET failed_attempts = $2,
                locked_until = CASE WHEN $3::boolean THEN now() + make_interval(mins => $4::int) END,
                updated_at = now()
          WHERE user_id = $1`,
        [userId, lock ? 0 : failed, lock, LOCK_MINUTES],
      );
      return { kind: "wrong" } as const;
    });
    if (outcome.kind === "ok") return;
    if (outcome.kind === "locked") {
      throw new HttpException(
        `Too many wrong PINs. Try again in ${outcome.minutes} minute${outcome.minutes === 1 ? "" : "s"}.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    throw new UnprocessableEntityException("That PIN isn't right.");
  }
}
