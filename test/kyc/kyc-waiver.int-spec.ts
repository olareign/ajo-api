import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import { KycProbeController } from "../support/kyc-probe.controller.js";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

/**
 * While the identity checks are pended the owner can approve people without them: one person at a
 * time (users.kyc_override) or everyone (KYC_AUTO_APPROVE). Both are switchable and both leave the
 * real checks untouched.
 */
let app: NestExpressApplication;
let db: DataSource;
const http = () => app.getHttpServer();

const authed = (method: "get" | "post" | "put", path: string, token: string) =>
  request(http())
    [method](path)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Forwarded-For", newIp());

async function person() {
  const user = await createVerifiedUser(app);
  const { accessToken } = (
    await request(http())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .send({ email: user.email, password: user.password })
      .expect(200)
  ).body;
  return { ...user, token: accessToken as string };
}

const setOverride = (email: string, value: "approved" | "denied" | null) =>
  db.query(`UPDATE users SET kyc_override = $2 WHERE email = $1`, [email, value]);

async function approveEveryStep(email: string, withNationalCheck = false) {
  const steps = ["id", "selfie", "address", "location", "bank"];
  if (withNationalCheck) steps.push("national_check");
  for (const step of steps) {
    await db.query(
      `INSERT INTO kyc_steps (user_id, step, status)
       VALUES ((SELECT id FROM users WHERE email = $1), $2, 'approved')`,
      [email, step],
    );
  }
}

const act = (token: string) => authed("post", "/api/v1/test/kyc", token);
const kyc = async (token: string) => (await authed("get", "/api/v1/kyc", token).expect(200)).body;

describe("with the automatic switch off (the default)", () => {
  beforeAll(async () => {
    app = await createTestApp({ KYC_AUTO_APPROVE: "false" }, [KycProbeController]);
    db = app.get(DataSource);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("changes nothing for someone with no override: still closed", async () => {
    const ada = await person();
    await act(ada.token).expect(403);
    expect(await kyc(ada.token)).toMatchObject({ status: "not_started", tier: 0, via: "checks" });
  });

  it("opens the gate for one person approved by hand, and closes it again when cleared", async () => {
    const ada = await person();
    const bola = await person();

    await setOverride(ada.email, "approved");
    await act(ada.token).expect(200);
    await act(bola.token).expect(403); // nobody else is affected

    await setOverride(ada.email, null);
    const closed = await act(ada.token).expect(403);
    expect(closed.body.code).toBe("kyc_required");
  });

  it("tells the app what it sees everywhere it asks: the passport, the profile and the wallet", async () => {
    const ada = await person();
    await setOverride(ada.email, "approved");

    expect(await kyc(ada.token)).toMatchObject({ status: "approved", tier: 1, via: "waived" });
    expect((await kyc(ada.token)).note).toMatch(/without the identity checks/i);
    expect((await authed("get", "/api/v1/me", ada.token).expect(200)).body).toMatchObject({
      kycStatus: "approved",
      kycTier: 1,
      kycVia: "waived",
    });
    expect(
      (await authed("get", "/api/v1/wallet/rails", ada.token).expect(200)).body.kycApproved,
    ).toBe(true);
  });

  it("writes no verification steps for the person: the passport still shows what was really done", async () => {
    const ada = await person();
    await setOverride(ada.email, "approved");
    await kyc(ada.token);
    const rows = await db.query(
      `SELECT 1 FROM kyc_steps WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [ada.email],
    );
    expect(rows).toHaveLength(0);
  });

  it("holds someone back even when every real check approved them", async () => {
    const ada = await person();
    await approveEveryStep(ada.email);
    await act(ada.token).expect(200);

    await setOverride(ada.email, "denied");
    await act(ada.token).expect(403);
    const held = await kyc(ada.token);
    expect(held).toMatchObject({ status: "rejected", tier: 0, via: "hold" });
    expect(held.note).toMatch(/on hold/i);

    await setOverride(ada.email, null);
    await act(ada.token).expect(200);
  });

  it("keeps the real tier once real checks approve, whatever the override", async () => {
    const ada = await person();
    await approveEveryStep(ada.email, true);
    await setOverride(ada.email, "approved");
    expect(await kyc(ada.token)).toMatchObject({ status: "approved", tier: 2, via: "checks" });
  });

  it("only allows the two words, so a typo cannot quietly approve or block someone", async () => {
    const ada = await person();
    await expect(
      db.query(`UPDATE users SET kyc_override = 'yes' WHERE email = $1`, [ada.email]),
    ).rejects.toThrow();
  });

  it("is only ever set by the owner: there is no way for a person to approve themselves", async () => {
    const ada = await person();
    await authed("put", "/api/v1/me/profile", ada.token)
      .send({ country: "NG", goal: "both", kycOverride: "approved" })
      .expect(400);
    await act(ada.token).expect(403);
  });

  it("keeps a record of every change: what it was, what it became, and who changed it", async () => {
    const ada = await person();
    await setOverride(ada.email, "approved");
    await setOverride(ada.email, "approved"); // nothing changed: nothing recorded
    await setOverride(ada.email, "denied");
    await setOverride(ada.email, null);

    const log = await db.query(
      `SELECT previous_value, new_value, changed_by FROM kyc_override_log
        WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY id`,
      [ada.email],
    );
    expect(
      log.map((r: { previous_value: string | null; new_value: string | null }) => [
        r.previous_value,
        r.new_value,
      ]),
    ).toEqual([
      [null, "approved"],
      ["approved", "denied"],
      ["denied", null],
    ]);
    expect(log.every((r: { changed_by: string }) => r.changed_by.length > 0)).toBe(true);
  });
});

describe("with the automatic switch on", () => {
  beforeAll(async () => {
    app = await createTestApp({ KYC_AUTO_APPROVE: "true" }, [KycProbeController]);
    db = app.get(DataSource);
  });
  afterAll(async () => {
    await app?.close();
  });

  it("approves everyone at tier 1 without a single step, and says so", async () => {
    const ada = await person();
    await act(ada.token).expect(200);
    expect(await kyc(ada.token)).toMatchObject({ status: "approved", tier: 1, via: "waived" });
    expect(
      (await authed("get", "/api/v1/wallet/rails", ada.token).expect(200)).body.kycApproved,
    ).toBe(true);
    const rows = await db.query(
      `SELECT 1 FROM kyc_steps WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      [ada.email],
    );
    expect(rows).toHaveLength(0);
  });

  it("still lets the owner hold one person back", async () => {
    const ada = await person();
    const bola = await person();
    await setOverride(ada.email, "denied");
    await act(ada.token).expect(403);
    await act(bola.token).expect(200);
  });

  it("trusts real checks over the switch for anyone they have approved", async () => {
    const ada = await person();
    await approveEveryStep(ada.email, true);
    expect(await kyc(ada.token)).toMatchObject({ status: "approved", tier: 2, via: "checks" });
  });
});
