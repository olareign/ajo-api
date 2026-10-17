import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { createTestApp } from "../support/test-app.js";
import { adminHarness, type AdminMember } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof adminHarness>;
let owner: AdminMember;
let support: AdminMember;

beforeAll(async () => {
  app = await createTestApp();
  h = adminHarness(app);
  [owner, support] = [await h.member("owner"), await h.member("support")];
});
afterAll(async () => {
  await app?.close();
});

describe("the admin dashboard", () => {
  it("gives every role the totals, 30 days of trends and what is waiting", async () => {
    for (const who of [owner, support]) {
      const { body } = await who.call("get", "/dashboard").expect(200);
      expect(body.days).toBe(30);
      expect(body.people.signups).toHaveLength(30);
      expect(
        body.people.signups.every((d: { day: string }) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)),
      ).toBe(true);
      expect(body.people.total).toBeGreaterThanOrEqual(body.people.active);
      expect(Object.keys(body.work).sort()).toEqual(
        ["failedPayments", "openCases", "pendingKyc", "stuckPayments"].sort(),
      );
      expect(Object.keys(body.circles).sort()).toEqual(
        ["completed", "open", "picking", "running"].sort(),
      );
      expect(Array.isArray(body.money)).toBe(true);
      expect(Array.isArray(body.recent)).toBe(true);
    }
  });

  it("counts match the database, and the latest payments carry no name or email", async () => {
    const { body } = await owner.call("get", "/dashboard").expect(200);
    const [row] = await h.t.db.query(`SELECT count(*)::int AS n FROM users`);
    expect(body.people.total).toBe(row.n);
    for (const r of body.recent) {
      expect(Object.keys(r).sort()).toEqual(
        ["amount", "createdAt", "currency", "id", "kind", "status", "userId"].sort(),
      );
    }
  });

  it("is closed without a staff session", async () => {
    await request(app.getHttpServer()).get("/api/v1/admin/dashboard").expect(401);
  });
});
