import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

const SECRET = "integration-bff-secret-integration-bff-secret";
let app: NestExpressApplication;
let db: DataSource;

beforeAll(async () => {
  app = await createTestApp({ BFF_SHARED_SECRET: SECRET });
  db = app.get(DataSource);
});
afterAll(async () => {
  await app?.close();
});

/** What the web server's own calls look like: all from one connection, naming the person behind it. */
const fromWeb = (path: string, person: { ip: string; ua?: string }, connection: string) =>
  request(app.getHttpServer())
    .post(path)
    .set("X-Forwarded-For", connection)
    .set("X-Ajo-Bff-Secret", SECRET)
    .set("X-Ajo-Client-Ip", person.ip)
    .set("X-Ajo-Client-Ua", person.ua ?? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5) Safari/605.1")
    .send({ email: "nobody@example.com", password: "wrong password here" });

describe("client address from the web server", () => {
  it("limits sign-in attempts per person, not for everyone behind the web server together", async () => {
    const connection = newIp(); // one address: the web server's
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push(
        (await fromWeb("/api/v1/auth/login", { ip: `102.89.${i}.1` }, connection)).status,
      );
    }
    expect(statuses.every((s) => s === 401)).toBe(true);
  });

  it("still limits one person who keeps trying", async () => {
    const connection = newIp();
    const person = { ip: "41.58.2.9" };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await fromWeb("/api/v1/auth/login", person, connection)).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("does not let anyone else claim an address: without the secret the connection's address is what counts", async () => {
    const connection = newIp();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (
          await request(app.getHttpServer())
            .post("/api/v1/auth/login")
            .set("X-Forwarded-For", connection)
            .set("X-Ajo-Client-Ip", `9.9.${i}.9`) // claimed, but no secret
            .send({ email: "nobody@example.com", password: "wrong password here" })
        ).status,
      );
    }
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it("records the person's real address and device on their session", async () => {
    const user = await createVerifiedUser(app);
    const ua =
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36";
    await request(app.getHttpServer())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .set("X-Ajo-Bff-Secret", SECRET)
      .set("X-Ajo-Client-Ip", "102.89.34.7")
      .set("X-Ajo-Client-Ua", ua)
      .send({ email: user.email, password: user.password })
      .expect(200);

    const [session] = await db.query(
      `SELECT host(s.ip) AS ip, s.user_agent FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE u.email = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [user.email],
    );
    expect(session).toEqual({ ip: "102.89.34.7", user_agent: ua });
  });
});
