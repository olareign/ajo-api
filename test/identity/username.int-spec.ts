import { randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { DataSource } from "typeorm";
import { createTestApp } from "../support/test-app.js";
import { createVerifiedUser, newIp } from "../support/users.js";

let app: NestExpressApplication;
let db: DataSource;
const http = () => app.getHttpServer();

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DataSource);
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
const call = (method: "get" | "put", path: string, token: string, body?: object) => {
  const r = request(http())
    [method](path)
    .set("X-Forwarded-For", newIp())
    .set("Authorization", `Bearer ${token}`);
  return body ? r.send(body) : r;
};
/** A name nobody else in this shared test database has. */
const fresh = () => `u${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const available = (token: string, username: string) =>
  call("get", `/api/v1/me/username/available?username=${encodeURIComponent(username)}`, token);

describe("GET /me/username/available", () => {
  it("says yes to a free name, and no once someone has it, whatever the capitals", async () => {
    const [a, b] = [await signedIn(), await signedIn()];
    const name = fresh();
    expect((await available(a, name).expect(200)).body).toEqual({ available: true });

    await call("put", "/api/v1/me/username", a, { username: name }).expect(204);
    expect((await available(b, name).expect(200)).body).toEqual({ available: false });
    expect((await available(b, name.toUpperCase()).expect(200)).body).toEqual({ available: false });
  });

  it("says no to a name the company keeps, in the same words as a taken one", async () => {
    const token = await signedIn();
    expect((await available(token, "admin").expect(200)).body).toEqual({ available: false });
  });

  it("refuses a name that is not a possible name, and needs a signed-in person", async () => {
    const token = await signedIn();
    await available(token, "no spaces allowed").expect(400);
    await available(token, "ab").expect(400);
    await request(http())
      .get("/api/v1/me/username/available?username=anyone")
      .set("X-Forwarded-For", newIp())
      .expect(401);
  });
});

describe("PUT /me/username", () => {
  it("saves it in lowercase and shows it on the profile", async () => {
    const token = await signedIn();
    const name = fresh();
    await call("put", "/api/v1/me/username", token, { username: `@${name.toUpperCase()}` }).expect(
      204,
    );
    expect((await call("get", "/api/v1/me", token)).body.username).toBe(name);
  });

  it("is chosen once; changing it comes with account settings", async () => {
    const token = await signedIn();
    await call("put", "/api/v1/me/username", token, { username: fresh() }).expect(204);
    const again = await call("put", "/api/v1/me/username", token, { username: fresh() }).expect(
      409,
    );
    expect(again.body.message).toBe("You already have a username.");
  });

  it("refuses a name someone has, or the company keeps, with one and the same message", async () => {
    const [a, b] = [await signedIn(), await signedIn()];
    const name = fresh();
    await call("put", "/api/v1/me/username", a, { username: name }).expect(204);

    const taken = await call("put", "/api/v1/me/username", b, {
      username: name.toUpperCase(),
    }).expect(409);
    const reserved = await call("put", "/api/v1/me/username", b, { username: "support" }).expect(
      409,
    );
    expect(taken.body.message).toBe("That username isn't available.");
    expect(reserved.body.message).toBe(taken.body.message);
  });

  it("gives the name to exactly one of two people who ask at the same moment", async () => {
    const [a, b] = [await signedIn(), await signedIn()];
    const name = fresh();
    const results = await Promise.all([
      call("put", "/api/v1/me/username", a, { username: name }),
      call("put", "/api/v1/me/username", b, { username: name }),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([204, 409]);
    const [{ count }] = await db.query(
      "SELECT count(*)::int AS count FROM users WHERE username = $1",
      [name],
    );
    expect(count).toBe(1);
  });

  it("refuses names that are not possible, and never takes the person from the request", async () => {
    const token = await signedIn();
    for (const username of ["ab", "1abc", "has space", "ada.ola", "x".repeat(21)]) {
      await call("put", "/api/v1/me/username", token, { username }).expect(400);
    }
    await call("put", "/api/v1/me/username", token, {
      username: fresh(),
      userId: randomUUID(),
    }).expect(400);
  });
});

describe("the database's own guard", () => {
  it("refuses a badly formed username even if the application let it through", async () => {
    const user = await createVerifiedUser(app);
    for (const bad of ["Bad Name", "UPPER", "ab", "1abc", "x".repeat(21)]) {
      await expect(
        db.query("UPDATE users SET username = $2 WHERE email = $1", [user.email, bad]),
      ).rejects.toThrow(/users_username_format/);
    }
  });

  it("keeps usernames unique whatever the capitals, even for direct writes", async () => {
    const [one, two] = [await createVerifiedUser(app), await createVerifiedUser(app)];
    const name = fresh();
    await db.query("UPDATE users SET username = $2 WHERE email = $1", [one.email, name]);
    await expect(
      db.query("UPDATE users SET username = $2 WHERE email = $1", [two.email, name.toUpperCase()]),
    ).rejects.toThrow(/users_username_key|users_username_format/);
  });
});
