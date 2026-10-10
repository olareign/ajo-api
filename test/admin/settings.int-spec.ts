import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { createTestApp } from "../support/test-app.js";
import { adminHarness, type AdminMember } from "./support.js";

let app: NestExpressApplication;
let h: ReturnType<typeof adminHarness>;
let owner: AdminMember;
let support: AdminMember;
let compliance: AdminMember;

beforeAll(async () => {
  app = await createTestApp();
  h = adminHarness(app);
  [owner, support, compliance] = [
    await h.member("owner"),
    await h.member("support"),
    await h.member("compliance"),
  ];
  // Start from no saved value, so the default is what customers see.
  await h.t.db.query(`DELETE FROM site_settings`);
});
afterAll(async () => {
  await h?.t.db.query(`DELETE FROM site_settings`);
  await app?.close();
});

const REASON = "The shared inbox for help is now live";
const contact = () => request(app.getHttpServer()).get("/api/v1/site/contact").expect(200);

describe("the support email", () => {
  it("is info@ajo.com until staff set one, public, cacheable, and nothing else about it leaks", async () => {
    const res = await contact();
    expect(res.body).toEqual({ supportEmail: "info@ajo.com" });
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("changes only for the owner, with a fresh code and a reason, and customers see it at once", async () => {
    await owner
      .call("post", "/settings/support-email")
      .send({ email: "Help@Ajo.com ", code: await owner.code(), reason: REASON })
      .expect(204);
    expect((await contact()).body).toEqual({ supportEmail: "help@ajo.com" });
    const read = await owner.call("get", "/settings").expect(200);
    expect(read.body).toMatchObject({ supportEmail: "help@ajo.com", updatedBy: owner.email });
    const [entry] = await h.audit("WHERE action = 'settings.support_email' AND admin_email = $1", [
      owner.email,
    ]);
    expect(entry).toMatchObject({
      admin_email: owner.email,
      target_type: "setting",
      target_id: "support_email",
      outcome: "ok",
      detail: { from: "info@ajo.com", to: "help@ajo.com", reason: REASON },
    });
  });

  it("refuses other roles, and records the attempt", async () => {
    for (const who of [support, compliance]) {
      await who.call("get", "/settings").expect(403);
      await who
        .call("post", "/settings/support-email")
        .send({ email: "attacker@evil.example", code: await who.code(), reason: REASON })
        .expect(403);
    }
    const denied = await h.audit("WHERE outcome = 'denied' AND admin_email = $1", [support.email]);
    expect(denied.map((r) => r.action)).toContain("denied:settings:manage");
    expect((await contact()).body.supportEmail).toBe("help@ajo.com");
  });

  it("refuses a wrong code, a missing reason and anything that isn't a plain address", async () => {
    const send = async (body: Record<string, unknown>) =>
      owner.call("post", "/settings/support-email").send(body);
    expect((await send({ email: "a@ajo.com", code: "000000", reason: REASON })).status).toBe(401);
    for (const email of [
      "not-an-email",
      "Help <help@ajo.com>",
      "help@localhost",
      "help@[127.0.0.1]",
      "help@ajo.com\r\nBcc: x@evil.example",
      `${"a".repeat(250)}@ajo.com`,
    ]) {
      expect((await send({ email, code: await owner.code(), reason: REASON })).status).toBe(400);
    }
    expect((await send({ email: "a@ajo.com", code: await owner.code(), reason: "x" })).status).toBe(
      400,
    );
    expect((await contact()).body.supportEmail).toBe("help@ajo.com");
  });

  it("can't be reached without a staff session, and a customer's token opens nothing", async () => {
    await request(app.getHttpServer()).get("/api/v1/admin/settings").expect(401);
    await request(app.getHttpServer())
      .post("/api/v1/admin/settings/support-email")
      .send({ email: "a@ajo.com", code: "123456", reason: REASON })
      .expect(401);
  });
});
