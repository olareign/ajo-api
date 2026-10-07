/* oxlint-disable no-console -- a command-line tool whose output is the console */
/**
 * Adds a staff member from the server side, which is how the first owner is made (and how an owner who
 * is locked out gets back in). It prints a one-time setup code, valid for a day, to give to the person;
 * they open the admin site, choose a password and connect their authenticator app. If the person is
 * already on the team, their password and authenticator are wiped and they start again.
 *
 *   pnpm build && pnpm admin:create you@example.com "Your Name" owner
 *   roles: owner, support, compliance, finance (default owner)
 *
 * Needs DATABASE_URL (the production one is the Neon connection string; add DATABASE_SSL=true for Neon). The change is recorded in the
 * audit log as made from the command line.
 */
import { userInfo } from "node:os";
import { createDataSource } from "./database/data-source.js";
import { hashSetupCode, makeSetupCode, SETUP_HOURS } from "./admin/admin-auth.service.js";
import { ADMIN_ROLES, type AdminRole } from "./admin/admin-roles.js";

const [email, name, roleArg = "owner"] = process.argv.slice(2);
const role = ADMIN_ROLES.find((r) => r === roleArg);
if (!email || !/^[^\s@]+@[^\s@]+$/.test(email) || !name || !role) {
  console.error('Usage: pnpm admin:create <email> "<name>" [owner|support|compliance|finance]');
  process.exit(2);
}

// Only the database is needed here; the settings check wants a Redis address too, so give it a stand-in.
const dataSource = await createDataSource({
  ...process.env,
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
}).initialize();
try {
  const code = makeSetupCode();
  const hash = hashSetupCode(code);
  const asRole: AdminRole = role;
  const rows = await dataSource.transaction(async (tx) => {
    const [existing] = (await tx.query(`SELECT id FROM admin_users WHERE email = $1 FOR UPDATE`, [
      email.toLowerCase(),
    ])) as { id: string }[];
    let id: string;
    if (existing) {
      id = existing.id;
      await tx.query(
        `UPDATE admin_users
            SET status = 'invited', display_name = $2, role = $3, password_hash = NULL, totp_secret = NULL,
                totp_confirmed_at = NULL, totp_last_step = NULL, failed_login_count = 0, locked_until = NULL,
                setup_token_hash = $4, setup_expires_at = now() + make_interval(hours => $5::int)
          WHERE id = $1`,
        [id, name, asRole, hash, SETUP_HOURS],
      );
      await tx.query(
        `UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL`,
        [id],
      );
    } else {
      const [created] = (await tx.query(
        `INSERT INTO admin_users (email, display_name, role, setup_token_hash, setup_expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5::int)) RETURNING id`,
        [email.toLowerCase(), name, asRole, hash, SETUP_HOURS],
      )) as { id: string }[];
      id = created!.id;
    }
    await tx.query(
      `INSERT INTO admin_audit (admin_id, admin_email, role, action, target_type, target_id, detail, outcome)
       VALUES (NULL, $1, 'owner', $2, 'admin', $3, $4::jsonb, 'ok')`,
      [
        `command-line:${userInfo().username}`,
        existing ? "team.reissue" : "team.invite",
        id,
        JSON.stringify({ email, role }),
      ],
    );
    return existing ? "reset" : "created";
  });
  console.log(`${email}: ${rows === "reset" ? "reset" : "added"} as ${role}.`);
  console.log(`Setup code (valid ${SETUP_HOURS} hours, shown only now): ${code}`);
  console.log(
    "Give it to them yourself. They open the admin site, choose a password and connect their authenticator app.",
  );
} finally {
  await dataSource.destroy();
}
