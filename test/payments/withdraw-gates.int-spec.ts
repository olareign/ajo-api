import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { createTestApp } from "../support/test-app.js";
import { codeAt, paymentsHarness, PIN } from "./support.js";

let app: NestExpressApplication;
let bare: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  t = paymentsHarness(app);
  bare = await createTestApp({ PAYMENTS_FAKE: "false" });
});
afterAll(async () => {
  await app?.close();
  await bare?.close();
});
afterEach(async () => t.expectBooksBalance());

type Who = Awaited<ReturnType<typeof t.ready>>;
const withdraw = (who: Who, body: object, code?: string) => {
  const req = who.call("post", "/payments/withdraw").set("Idempotency-Key", `k_${randomUUID()}`);
  return (code ? req.set("X-Ajo-Mfa-Code", code) : req).send(body);
};
const body = { amount: "40000", pin: PIN };

describe("the gates in front of taking money out", () => {
  it("asks for approved identity checks first, before anything else", async () => {
    const who = await t.ready("NG", { kyc: false });
    const res = await withdraw(who, body).expect(403);
    expect(res.body.code).toBe("kyc_required");
  });

  it("then needs the authenticator app to be on", async () => {
    const who = await t.ready("NG", { mfa: false });
    const res = await withdraw(who, body, "123456").expect(403);
    expect(res.body.code).toBe("mfa_enrolment_required");
  });

  it("then needs a fresh code with every request, and refuses a wrong one", async () => {
    const who = await t.ready();
    expect((await withdraw(who, body).expect(401)).body.code).toBe("mfa_code_required");
    expect((await withdraw(who, body, "000000").expect(401)).body.code).toBe("mfa_code_wrong");
  });

  it("lets a right code through, once, and moves nothing when the PIN is wrong", async () => {
    const who = await t.ready();
    await t.giveMoney(who.id, "100000");
    await t.seedPayoutAccount(who.id);
    // The authenticator's code works once, so this one request is all it can carry.
    const code = codeAt(who.secret!, 30);
    const res = await withdraw(who, { amount: "40000", pin: "000000" }, code).expect(422);
    expect(res.body.message).toMatch(/PIN/);
    expect(await t.balance(who.id)).toBe("100000");
    // The same code again is refused: a copied code cannot be replayed.
    expect((await withdraw(who, body, code).expect(401)).body.code).toBe("mfa_code_wrong");
  });

  it("takes the money out when the code, the PIN and the account are all right", async () => {
    const who = await t.ready();
    await t.giveMoney(who.id, "100000");
    await t.seedPayoutAccount(who.id);
    const res = await withdraw(who, body, codeAt(who.secret!, 30)).expect(200);
    expect(res.body.status).toBe("pending");
    expect(await t.balance(who.id)).toBe("60000");
  });

  it("also guards changing where the money goes", async () => {
    const who = await t.ready();
    const put = (code?: string) => {
      const req = who.call("put", "/payments/payout-account");
      return (code ? req.set("X-Ajo-Mfa-Code", code) : req).send({
        bankCode: "058",
        accountNumber: "0123456789",
      });
    };
    expect((await put().expect(401)).body.code).toBe("mfa_code_required");
    expect((await put("000000").expect(401)).body.code).toBe("mfa_code_wrong");
    const noKyc = await t.ready("NG", { kyc: false });
    expect(
      (
        await noKyc
          .call("put", "/payments/payout-account")
          .send({ bankCode: "058", accountNumber: "0123456789" })
          .expect(403)
      ).body.code,
    ).toBe("kyc_required");
  });

  it("says plainly when no payment partner is connected, even for someone with every check passed", async () => {
    const b = paymentsHarness(bare);
    const who = await b.ready();
    const res = await who
      .call("post", "/payments/withdraw")
      .set("Idempotency-Key", `k_${randomUUID()}`)
      .set("X-Ajo-Mfa-Code", codeAt(who.secret!, 30))
      .send(body)
      .expect(503);
    expect(res.body.code).toBe("payments_not_connected");
  });

  it("never lets a signed-out request through", async () => {
    const { default: request } = await import("supertest");
    await request(t.http())
      .post("/api/v1/payments/withdraw")
      .set("Idempotency-Key", `k_${randomUUID()}`)
      .send(body)
      .expect(401);
    await request(t.http()).put("/api/v1/payments/payout-account").send({}).expect(401);
  });
});
