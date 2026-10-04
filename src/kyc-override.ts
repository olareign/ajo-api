/* oxlint-disable no-console -- a command-line tool whose output is the console */
/**
 * Switches one person's identity approval on or off while the real identity checks are pended:
 *   pnpm build && pnpm kyc:override you@example.com approve   (approved without the checks)
 *   pnpm kyc:override you@example.com deny                    (held back, even if checks passed)
 *   pnpm kyc:override you@example.com clear                   (back to what the checks say)
 *   pnpm kyc:override list                                    (who is switched right now)
 * Every change is recorded in kyc_override_log by the database. To approve everyone at once, set
 * KYC_AUTO_APPROVE=true instead (test keys only).
 */
import { createDataSource } from "./database/data-source.js";
import { parseOverrideArgs } from "./kyc/override-command.js";

const command = parseOverrideArgs(process.argv.slice(2));
if (command.kind === "usage") {
  console.error("Usage: pnpm kyc:override <email> approve|deny|clear   |   pnpm kyc:override list");
  process.exit(2);
}

const dataSource = await createDataSource().initialize();
try {
  if (command.kind === "list") {
    const rows = await dataSource.query<{ email: string; kyc_override: string }[]>(
      `SELECT email, kyc_override FROM users WHERE kyc_override IS NOT NULL ORDER BY email`,
    );
    if (rows.length === 0) console.log("Nobody is switched by hand.");
    for (const row of rows) console.log(`${row.kyc_override.padEnd(9)} ${row.email}`);
  } else {
    // [rows, count]: TypeORM's raw UPDATE ... RETURNING answer.
    const [rows] = await dataSource.query<[{ email: string }[], number]>(
      `UPDATE users SET kyc_override = $2, updated_at = now() WHERE email = $1 RETURNING email`,
      [command.email, command.value],
    );
    if (rows.length === 0) {
      console.error(`No account with that email.`);
      process.exitCode = 1;
    } else {
      const now = command.value ?? "back to what the checks say";
      console.log(`${rows[0]!.email}: ${now}`);
    }
  }
} finally {
  await dataSource.destroy();
}
