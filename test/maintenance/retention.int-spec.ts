import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DataSource } from "typeorm";
import { RetentionService } from "../../src/maintenance/retention.service.js";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
let retention: RetentionService;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
  retention = new RetentionService(db);
});

afterAll(async () => {
  await app?.close();
});

async function newUserId(): Promise<string> {
  const { email } = await createVerifiedUser(app);
  const [row] = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  return row.id as string;
}

const hash = () => randomUUID().replaceAll("-", "").padEnd(64, "0");

/** Inserts a session whose clock fields are given as "N days ago" (negative = in the future). */
async function session(
  userId: string,
  opts: { expiredDaysAgo?: number; revokedDaysAgo?: number } = {},
): Promise<string> {
  const [row] = await db.query(
    `INSERT INTO sessions (user_id, expires_at, revoked_at, revoked_reason)
     VALUES ($1,
             now() - make_interval(days => $2),
             CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(days => $3::int) END,
             CASE WHEN $3::int IS NULL THEN NULL ELSE 'logout' END)
     RETURNING id`,
    [userId, opts.expiredDaysAgo ?? -30, opts.revokedDaysAgo ?? null],
  );
  return row.id as string;
}

async function refreshToken(
  sessionId: string,
  opts: { expiredDaysAgo: number; used?: boolean },
): Promise<string> {
  const [row] = await db.query(
    `INSERT INTO refresh_tokens (session_id, token_hash, expires_at, used_at)
     VALUES ($1, $2, now() - make_interval(days => $3), CASE WHEN $4 THEN now() ELSE NULL END)
     RETURNING id`,
    [sessionId, hash(), opts.expiredDaysAgo, opts.used ?? false],
  );
  return row.id as string;
}

const exists = async (table: string, id: string) =>
  (await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).length === 1;

describe("RetentionService.purge", () => {
  it("removes sessions that expired a week ago, with their refresh tokens", async () => {
    const userId = await newUserId();
    const old = await session(userId, { expiredDaysAgo: 8 });
    const oldToken = await refreshToken(old, { expiredDaysAgo: 8 });
    const justExpired = await session(userId, { expiredDaysAgo: 1 });
    const live = await session(userId);

    await retention.purge();

    expect(await exists("sessions", old)).toBe(false);
    expect(await exists("refresh_tokens", oldToken)).toBe(false);
    expect(await exists("sessions", justExpired)).toBe(true);
    expect(await exists("sessions", live)).toBe(true);
  });

  it("keeps revoked sessions for a month, then removes them", async () => {
    const userId = await newUserId();
    const recent = await session(userId, { revokedDaysAgo: 5 });
    const old = await session(userId, { revokedDaysAgo: 31 });

    await retention.purge();

    expect(await exists("sessions", recent)).toBe(true);
    expect(await exists("sessions", old)).toBe(false);
  });

  it("removes long-expired refresh tokens inside a live session, but keeps used ones that could still reveal a stolen copy", async () => {
    const userId = await newUserId();
    const live = await session(userId);
    const longExpired = await refreshToken(live, { expiredDaysAgo: 3, used: true });
    const usedButValid = await refreshToken(live, { expiredDaysAgo: -3, used: true });
    const current = await refreshToken(live, { expiredDaysAgo: -7 });

    await retention.purge();

    expect(await exists("refresh_tokens", longExpired)).toBe(false);
    expect(await exists("refresh_tokens", usedButValid)).toBe(true);
    expect(await exists("refresh_tokens", current)).toBe(true);
  });

  it("removes spent and expired email, password and second-step tokens, and keeps fresh ones", async () => {
    const userId = await newUserId();
    const insert = async (table: string, extra: string, expiredDaysAgo: number, used: boolean) => {
      const [row] = await db.query(
        `INSERT INTO ${table} (user_id, token_hash, expires_at, used_at ${extra ? ", attempts" : ""})
         VALUES ($1, $2, now() - make_interval(days => $3),
                 CASE WHEN $4 THEN now() - interval '10 days' ELSE NULL END ${extra ? ", 0" : ""})
         RETURNING id`,
        [userId, hash(), expiredDaysAgo, used],
      );
      return row.id as string;
    };

    for (const [table, extra] of [
      ["email_verification_tokens", ""],
      ["password_reset_tokens", ""],
      ["mfa_challenges", "attempts"],
    ] as const) {
      const expired = await insert(table, extra, 10, false);
      const spent = await insert(table, extra, 5, true);
      const fresh = await insert(table, extra, -1, false);

      await retention.purge();

      expect(await exists(table, expired), `${table}: expired`).toBe(false);
      expect(await exists(table, spent), `${table}: spent`).toBe(false);
      expect(await exists(table, fresh), `${table}: fresh`).toBe(true);
    }
  });

  it("never touches accounts", async () => {
    const userId = await newUserId();
    await retention.purge();
    expect(await exists("users", userId)).toBe(true);
  });

  it("works through a large backlog in small batches and reports what it removed", async () => {
    const userId = await newUserId();
    for (let i = 0; i < 5; i++) await session(userId, { expiredDaysAgo: 20 });

    const report = await retention.purge({ batchSize: 2 });

    expect(report.sessions).toBeGreaterThanOrEqual(5);
    const left = await db.query(
      "SELECT 1 FROM sessions WHERE user_id = $1 AND expires_at < now() - interval '7 days'",
      [userId],
    );
    expect(left).toHaveLength(0);
  });
});
