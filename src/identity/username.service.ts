import { ConflictException, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { sql } from "../database/sql.js";
import { isReservedUsername } from "./username-policy.js";

/** One message for "taken" and "kept by the company", so it does not reveal which. */
export const USERNAME_UNAVAILABLE = "That username isn't available.";
export const USERNAME_ALREADY_SET = "You already have a username.";

const UNIQUE_VIOLATION = "23505";
const isUniqueViolation = (error: unknown): boolean =>
  (error as { driverError?: { code?: string } } | null)?.driverError?.code === UNIQUE_VIOLATION;

/** Names are shown to friends, so they are lowercase, unique, and chosen once during setup. */
@Injectable()
export class UsernameService {
  constructor(private readonly db: DataSource) {}

  /** For the live check while someone types. A name must still be claimed with `set`. */
  async isAvailable(username: string): Promise<boolean> {
    if (isReservedUsername(username)) return false;
    const rows: unknown[] = await this.db.query(`SELECT 1 FROM users WHERE username = $1`, [
      username,
    ]);
    return rows.length === 0;
  }

  /**
   * Claims the name for this person if they have none yet. The database's unique rule decides a
   * race between two people, so exactly one wins and the other is told it is unavailable.
   */
  async set(userId: string, username: string): Promise<void> {
    if (isReservedUsername(username)) throw new ConflictException(USERNAME_UNAVAILABLE);
    try {
      const rows = await this.db.transaction((tx) =>
        sql<{ id: string }>(
          tx,
          `UPDATE users SET username = $2, updated_at = now()
            WHERE id = $1 AND username IS NULL RETURNING id`,
          [userId, username],
        ),
      );
      if (rows.length === 0) throw new ConflictException(USERNAME_ALREADY_SET);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(USERNAME_UNAVAILABLE);
      throw error;
    }
  }
}
