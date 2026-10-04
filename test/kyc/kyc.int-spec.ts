import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import { KycProbeController } from "../support/kyc-probe.controller.js";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
const http = () => app.getHttpServer();

const authed = (method: "get" | "post" | "put", path: string, token: string) =>
  request(http())
    [method](path)
    .set("Authorization", `Bearer ${token}`)
    .set("X-Forwarded-For", newIp());

async function person(country?: "NG" | "GB") {
  const user = await createVerifiedUser(app);
  const { accessToken } = (
    await request(http())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .send({ email: user.email, password: user.password })
      .expect(200)
  ).body;
  if (country) {
    await authed("put", "/api/v1/me/profile", accessToken)
      .send({ country, goal: "both" })
      .expect(204);
  }
  return { ...user, token: accessToken as string };
}

async function decide(email: string, step: string, status: string, reason: string | null = null) {
  await db.query(
    `INSERT INTO kyc_steps (user_id, step, status, reason)
     VALUES ((SELECT id FROM users WHERE email = $1), $2, $3, $4)
     ON CONFLICT (user_id, step) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason`,
    [email, step, status, reason],
  );
}
const approveEverything = async (email: string) => {
  for (const step of ["id", "selfie", "address", "location", "bank"])
    await decide(email, step, "approved");
};

beforeAll(async () => {
  app = await createTestApp({}, [KycProbeController]);
  db = app.get(DataSource);
});
afterAll(async () => {
  await app?.close();
});

describe("GET /kyc", () => {
  it("needs a signed-in person", async () => {
    await request(http()).get("/api/v1/kyc").set("X-Forwarded-For", newIp()).expect(401);
  });

  it("starts empty, says which country's checks apply, and that no partner is connected yet", async () => {
    const ada = await person("NG");
    const res = await authed("get", "/api/v1/kyc", ada.token).expect(200);
    expect(res.body).toMatchObject({
      connected: false,
      country: "NG",
      status: "not_started",
      tier: 0,
    });
    expect(res.body.steps.map((s: { step: string }) => s.step)).toEqual([
      "id",
      "selfie",
      "address",
      "location",
      "bank",
      "national_check",
    ]);
  });

  it("has no country until one is chosen in setup", async () => {
    const res = await authed("get", "/api/v1/kyc", (await person()).token).expect(200);
    expect(res.body.country).toBeNull();
  });

  it("shows only the caller's own progress, with the reason for a refusal", async () => {
    const ada = await person("NG");
    const bola = await person("GB");
    await decide(ada.email, "id", "approved");
    await decide(ada.email, "selfie", "rejected", "The photo was too dark.");

    const mine = (await authed("get", "/api/v1/kyc", ada.token).expect(200)).body;
    expect(mine.status).toBe("rejected");
    expect(mine.steps.find((s: { step: string }) => s.step === "selfie")).toMatchObject({
      status: "rejected",
      reason: "The photo was too dark.",
    });
    const theirs = (await authed("get", "/api/v1/kyc", bola.token).expect(200)).body;
    expect(theirs).toMatchObject({ status: "not_started", country: "GB" });
  });

  it("reaches tier 2 with an approved national check on top of approval", async () => {
    const ada = await person("NG");
    await approveEverything(ada.email);
    await decide(ada.email, "national_check", "approved");
    expect((await authed("get", "/api/v1/kyc", ada.token).expect(200)).body).toMatchObject({
      status: "approved",
      tier: 2,
    });
  });
});

describe("the database keeps the records honest", () => {
  it("refuses a step or a status nobody defined, and a second row for the same step", async () => {
    const ada = await person("NG");
    const [{ id }] = await db.query("SELECT id FROM users WHERE email = $1", [ada.email]);
    const insert = (step: string, status: string) =>
      db.query(`INSERT INTO kyc_steps (user_id, step, status) VALUES ($1, $2, $3)`, [
        id,
        step,
        status,
      ]);
    await expect(insert("hair_colour", "approved")).rejects.toThrow();
    await expect(insert("id", "maybe")).rejects.toThrow();
    await insert("id", "approved");
    await expect(insert("id", "approved")).rejects.toThrow();
  });

  it("forgets a person's records with their account", async () => {
    const ada = await person("NG");
    await decide(ada.email, "id", "approved");
    await db.query(`DELETE FROM users WHERE email = $1`, [ada.email]);
    const left = await db.query(
      `SELECT 1 FROM kyc_steps WHERE user_id NOT IN (SELECT id FROM users)`,
    );
    expect(left).toHaveLength(0);
  });
});

describe("the gate in front of saving, joining and friends", () => {
  const act = (token: string) => authed("post", "/api/v1/test/kyc", token);

  it("is closed until every required step is approved, with a word the app can act on", async () => {
    const ada = await person("NG");
    const none = await act(ada.token).expect(403);
    expect(none.body.code).toBe("kyc_required");

    await decide(ada.email, "id", "approved");
    await decide(ada.email, "selfie", "pending");
    await act(ada.token).expect(403);

    await decide(ada.email, "selfie", "rejected", "Too dark");
    await act(ada.token).expect(403);
  });

  it("opens once everything is approved, and not before the last step", async () => {
    const ada = await person("NG");
    for (const step of ["id", "selfie", "address", "location"])
      await decide(ada.email, step, "approved");
    await act(ada.token).expect(403);
    await decide(ada.email, "bank", "approved");
    await act(ada.token).expect(200);
  });

  it("still needs a signed-in session first", async () => {
    await request(http()).post("/api/v1/test/kyc").set("X-Forwarded-For", newIp()).expect(401);
  });
});

describe("GET /wallet/rails", () => {
  it("says the currency for the person's country and that no payment partner is connected", async () => {
    const res = await authed("get", "/api/v1/wallet/rails", (await person("GB")).token).expect(200);
    expect(res.body).toEqual({
      country: "GB",
      currency: "GBP",
      kycApproved: false,
      connected: { fund: false, mandate: false, withdraw: false },
    });
    const ng = await authed("get", "/api/v1/wallet/rails", (await person("NG")).token).expect(200);
    expect(ng.body).toMatchObject({ country: "NG", currency: "NGN" });
  });

  it("has neither before a country is chosen, and reports approval when it comes", async () => {
    const none = await authed("get", "/api/v1/wallet/rails", (await person()).token).expect(200);
    expect(none.body).toMatchObject({ country: null, currency: null });

    const ada = await person("NG");
    await approveEverything(ada.email);
    const res = await authed("get", "/api/v1/wallet/rails", ada.token).expect(200);
    expect(res.body.kycApproved).toBe(true);
  });
});

describe("GET /me", () => {
  it("includes where the person is in verification", async () => {
    const ada = await person("NG");
    expect((await authed("get", "/api/v1/me", ada.token).expect(200)).body).toMatchObject({
      kycStatus: "not_started",
      kycTier: 0,
    });
    await approveEverything(ada.email);
    expect((await authed("get", "/api/v1/me", ada.token).expect(200)).body).toMatchObject({
      kycStatus: "approved",
      kycTier: 1,
    });
  });
});
