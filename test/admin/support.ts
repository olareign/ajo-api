import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { AdminAuth } from "../../src/admin/admin-auth.service.js";
import type { AdminRole } from "../../src/admin/admin-roles.js";
import { codeAt, paymentsHarness } from "../payments/support.js";
import { newIp } from "../support/users.js";

export const ADMIN_PASSWORD = "harbour-lantern-quiet-orchard-77";

/** Staff, made the way real staff are: an invitation, a setup code, a password and an authenticator app. */
export function adminHarness(app: NestExpressApplication) {
  const t = paymentsHarness(app);
  const auth = app.get(AdminAuth);
  const api = (method: "get" | "post" | "put" | "delete", path: string, token?: string) => {
    const r = request(t.http())[method](`/api/v1/admin${path}`).set("X-Forwarded-For", newIp());
    return token ? r.set("Authorization", `Bearer ${token}`) : r;
  };

  async function member(role: AdminRole = "owner") {
    const email = `staff-${randomUUID().slice(0, 8)}@ajo.test`;
    const invited = await auth.invite(
      { id: null, email: "test-harness", role: "owner", ip: undefined },
      { email, name: `Staff ${role}`, role },
    );
    const started = await api("post", "/auth/setup/start")
      .send({ email, setupCode: invited.setupCode, password: ADMIN_PASSWORD })
      .expect(200);
    const secret = started.body.secret as string;
    const joined = await api("post", "/auth/setup/confirm")
      .send({ email, setupCode: invited.setupCode, code: codeAt(secret) })
      .expect(200);
    const id = joined.body.admin.id as string;
    /** A code that has not been used yet (the one used to sign in is spent until the next step). */
    const code = async () => {
      await t.db.query("UPDATE admin_users SET totp_last_step = NULL WHERE id = $1", [id]);
      return codeAt(secret);
    };
    const token = joined.body.token as string;
    return {
      id,
      email,
      role,
      secret,
      token,
      code,
      call: (method: "get" | "post" | "put" | "delete", path: string) => api(method, path, token),
    };
  }

  const audit = (where = "", params: unknown[] = []) =>
    t.db.query(
      `SELECT action, outcome, target_type, target_id, detail, admin_email FROM admin_audit ${where} ORDER BY id`,
      params,
    ) as Promise<
      {
        action: string;
        outcome: string;
        target_type: string | null;
        target_id: string | null;
        detail: Record<string, unknown>;
        admin_email: string;
      }[]
    >;

  return { t, auth, api, member, audit };
}
export type AdminMember = Awaited<ReturnType<ReturnType<typeof adminHarness>["member"]>>;
