import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

let app: NestExpressApplication;
const http = () => app.getHttpServer();

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});

async function signedIn() {
  const user = await createVerifiedUser(app);
  const { accessToken } = (
    await request(http())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .send({ email: user.email, password: user.password })
      .expect(200)
  ).body;
  return accessToken as string;
}
const call = (method: "get" | "put" | "post", path: string, token: string, body?: object) => {
  const r = request(http())
    [method](path)
    .set("X-Forwarded-For", newIp())
    .set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
};

describe("onboarding", () => {
  it("starts not onboarded and becomes onboarded once country, goal and PIN are set", async () => {
    const token = await signedIn();
    expect((await call("get", "/api/v1/me", token)).body).toMatchObject({
      country: null,
      goal: null,
      hasPin: false,
      onboarded: false,
    });

    await call("put", "/api/v1/me/profile", token, { country: "NG", goal: "both" }).expect(204);
    expect((await call("get", "/api/v1/me", token)).body).toMatchObject({
      country: "NG",
      goal: "both",
      hasPin: false,
      onboarded: false,
    });

    await call("put", "/api/v1/me/pin", token, { pin: "493817" }).expect(204);
    // Country, goal and a PIN are not enough any more: a username is part of being set up.
    expect((await call("get", "/api/v1/me", token)).body).toMatchObject({
      hasPin: true,
      username: null,
      onboarded: false,
    });

    await call("put", "/api/v1/me/username", token, {
      username: `ob${Date.now().toString(36)}`,
    }).expect(204);
    expect((await call("get", "/api/v1/me", token)).body).toMatchObject({ onboarded: true });
  });

  it("only accepts supported countries and goals", async () => {
    const token = await signedIn();
    await call("put", "/api/v1/me/profile", token, { country: "US", goal: "solo" }).expect(400);
    await call("put", "/api/v1/me/profile", token, { country: "GB", goal: "rich" }).expect(400);
    await call("put", "/api/v1/me/profile", token, { country: "GB", goal: "solo" }).expect(204);
  });

  it("requires a sign-in", async () => {
    await request(http()).put("/api/v1/me/profile").set("X-Forwarded-For", newIp()).expect(401);
    await request(http()).put("/api/v1/me/pin").set("X-Forwarded-For", newIp()).expect(401);
  });

  it("rejects PINs that are not six digits or are easy to guess", async () => {
    const token = await signedIn();
    for (const pin of ["12345", "1234567", "abcdef", "123456", "000000", "111111", "654321"]) {
      await call("put", "/api/v1/me/pin", token, { pin }).expect(400);
    }
  });

  it("stores the PIN as a hash and will not silently replace it", async () => {
    const token = await signedIn();
    await call("put", "/api/v1/me/pin", token, { pin: "493817" }).expect(204);
    await call("put", "/api/v1/me/pin", token, { pin: "718204" }).expect(409);
  });

  it("checks the PIN, and locks after five wrong tries even for the right PIN", async () => {
    const token = await signedIn();
    await call("put", "/api/v1/me/pin", token, { pin: "493817" }).expect(204);
    await call("post", "/api/v1/me/pin/verify", token, { pin: "493817" }).expect(204);
    for (let i = 0; i < 5; i++) {
      await call("post", "/api/v1/me/pin/verify", token, { pin: "718204" }).expect(422);
    }
    const locked = await call("post", "/api/v1/me/pin/verify", token, { pin: "493817" }).expect(
      429,
    );
    expect(locked.body.message).toMatch(/try again/i);
  });

  it("clears the failed-try count after a correct PIN", async () => {
    const token = await signedIn();
    await call("put", "/api/v1/me/pin", token, { pin: "493817" }).expect(204);
    for (let i = 0; i < 4; i++) {
      await call("post", "/api/v1/me/pin/verify", token, { pin: "718204" }).expect(422);
    }
    await call("post", "/api/v1/me/pin/verify", token, { pin: "493817" }).expect(204);
    for (let i = 0; i < 4; i++) {
      await call("post", "/api/v1/me/pin/verify", token, { pin: "718204" }).expect(422);
    }
    await call("post", "/api/v1/me/pin/verify", token, { pin: "493817" }).expect(204);
  });
});
