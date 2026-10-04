import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomBytes, randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";
import request from "supertest";
import { DataSource } from "typeorm";
import { LedgerService } from "../../src/ledger/ledger.service.js";
import {
  recipientFor,
  signFakeWebhook,
  type FakeProvider,
} from "../../src/payments/providers/fake.provider.js";
import type { ProviderEvent } from "../../src/payments/providers/provider.port.js";
import { PaymentProviders } from "../../src/payments/providers/providers.service.js";
import { createVerifiedUser, newIp } from "../support/users.js";

export const codeAt = (secret: string, offsetSeconds = 0) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: Date.now() + offsetSeconds * 1000,
  });

export const PIN = "493817";

/** Everything a payments test needs, built once per test file around a running app. */
export function paymentsHarness(app: NestExpressApplication) {
  const db = app.get(DataSource);
  const ledger = app.get(LedgerService);
  const fake = (country: "NG" | "GB" = "NG") =>
    app.get(PaymentProviders).forCountry(country) as FakeProvider;
  const http = () => app.getHttpServer();

  async function person(country: "NG" | "GB" = "NG") {
    const { email } = await createVerifiedUser(app);
    const [{ id }] = await db.query("SELECT id FROM users WHERE email = $1", [email]);
    await db.query("UPDATE users SET country = $2 WHERE id = $1", [id, country]);
    return { id: id as string, email, currency: country === "NG" ? "NGN" : "GBP" };
  }

  /**
   * Someone who has everything the money routes ask for: signed in, a country, a PIN, identity checks
   * approved (written straight to the database, since a partner decides that), and the authenticator on.
   */
  async function ready(
    country: "NG" | "GB" = "NG",
    options: { mfa?: boolean; kyc?: boolean } = {},
  ) {
    const { email, password } = await createVerifiedUser(app);
    const login = await request(http())
      .post("/api/v1/auth/login")
      .set("X-Forwarded-For", newIp())
      .send({ email, password })
      .expect(200);
    const token = login.body.accessToken as string;
    const call = (method: "get" | "post" | "put" | "delete", path: string) =>
      request(http())
        [method](`/api/v1${path}`)
        .set("Authorization", `Bearer ${token}`)
        .set("X-Forwarded-For", newIp());
    const [{ id }] = await db.query("SELECT id FROM users WHERE email = $1", [email]);
    await call("put", "/me/profile").send({ country, goal: "both" }).expect(204);
    await call("put", "/me/username")
      .send({ username: `u${randomBytes(6).toString("hex")}` })
      .expect(204);
    await call("put", "/me/pin").send({ pin: PIN }).expect(204);
    if (options.kyc !== false) {
      for (const step of ["id", "selfie", "address", "location", "bank"]) {
        await db.query(
          `INSERT INTO kyc_steps (user_id, step, status) VALUES ($1, $2, 'approved')`,
          [id, step],
        );
      }
    }
    let secret: string | undefined;
    if (options.mfa !== false) {
      secret = (await call("post", "/auth/mfa/totp").expect(200)).body.secret as string;
      await call("post", "/auth/mfa/totp/confirm")
        .send({ code: codeAt(secret) })
        .expect(200);
    }
    return {
      id: id as string,
      email,
      token,
      secret,
      currency: country === "NG" ? "NGN" : "GBP",
      call,
    };
  }

  /** Gives the person a payout account the bank will vouch for as their own. */
  async function payoutAccount(
    who: { call: (m: "put", p: string) => request.Test },
    number?: string,
    name = "TEST USER",
  ) {
    const accountNumber =
      number ?? `0${randomBytes(5).toString("hex").replace(/\D/g, "").padEnd(9, "7").slice(0, 9)}`;
    fake("NG").behaviour.accountNames.set(accountNumber, name);
    await who
      .call("put", "/payments/payout-account")
      .send({ bankCode: "058", accountNumber })
      .expect(200);
    return accountNumber;
  }

  /** A payout account written directly, for tests whose app does not let the account be set through the API. */
  async function seedPayoutAccount(userId: string) {
    const number = `1${randomBytes(4).toString("hex").replace(/\D/g, "").padEnd(9, "3").slice(0, 9)}`;
    await db.query(
      `INSERT INTO payout_accounts (user_id, provider, bank_code, bank_name, last4, account_name, recipient_code)
       VALUES ($1, 'fake', '058', 'GTBank', $2, 'TEST USER', $3)`,
      [userId, number.slice(-4), recipientFor(number)],
    );
    return number;
  }

  const reference = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

  /** Money in the wallet, put there the way a real credit would: from the partner's settlement account. */
  async function giveMoney(userId: string, amount: string, currency = "NGN") {
    const settlement = await ledger.systemAccount("settlement", currency, "fake");
    const wallet = await ledger.userAccount(userId, "available", currency);
    await ledger.post({
      type: "funding",
      idempotencyKey: `seed-${randomUUID()}`,
      entries: [
        { accountId: settlement, direction: "debit", amount },
        { accountId: wallet, direction: "credit", amount },
      ],
    });
  }

  async function balance(userId: string, currency = "NGN") {
    return ledger.balance(await ledger.userAccount(userId, "available", currency));
  }

  /** A payment the person has started and not finished. */
  async function seedFunding(
    userId: string,
    amount: string,
    over: { method?: string; status?: string; currency?: string } = {},
  ) {
    const ref = reference("ajf");
    const [row] = await db.query(
      `INSERT INTO payment_intents (user_id, kind, provider, method, currency, amount, status, reference, idempotency_key, request_hash)
       VALUES ($1, 'funding', 'fake', $2, $3, $4, $5, $6, $7, repeat('0', 64)) RETURNING id`,
      [
        userId,
        over.method ?? "card",
        over.currency ?? "NGN",
        amount,
        over.status ?? "pending",
        ref,
        `seed-${randomUUID()}`,
      ],
    );
    return { id: row.id as string, reference: ref };
  }

  /** A withdrawal already held: the money has left the wallet for "in transit" and the transfer is out. */
  async function seedWithdrawal(userId: string, amount: string, currency = "NGN") {
    const wallet = await ledger.userAccount(userId, "available", currency);
    const inTransit = await ledger.systemAccount("suspense", currency, "payouts");
    const ref = reference("ajw");
    const hold = await ledger.post({
      type: "withdrawal",
      idempotencyKey: `hold-${randomUUID()}`,
      reference: ref,
      entries: [
        { accountId: wallet, direction: "debit", amount },
        { accountId: inTransit, direction: "credit", amount },
      ],
    });
    const [row] = await db.query(
      `INSERT INTO payment_intents (user_id, kind, provider, method, currency, amount, status, reference, idempotency_key, request_hash, ledger_transaction_id)
       VALUES ($1, 'withdrawal', 'fake', 'bank_account', $2, $3, 'pending', $4, $5, repeat('0', 64), $6) RETURNING id`,
      [userId, currency, amount, ref, `seed-${randomUUID()}`, hold.id],
    );
    return { id: row.id as string, reference: ref, holdId: hold.id };
  }

  const event = (over: Partial<ProviderEvent> & Pick<ProviderEvent, "kind">): ProviderEvent => ({
    eventId: `evt_${randomUUID()}`,
    type: over.kind,
    ...over,
  });

  /** Plays the partner: signs the body and posts it to the real webhook endpoint. */
  function deliver(events: ProviderEvent[], tamper?: (body: string) => string) {
    const body = JSON.stringify({ events });
    return request(http())
      .post("/api/v1/webhooks/fake")
      .set("Content-Type", "application/json")
      .set("X-Fake-Signature", signFakeWebhook(body))
      .set("X-Forwarded-For", newIp())
      .send(tamper ? tamper(body) : body);
  }

  const intent = async (id: string) =>
    (await db.query("SELECT * FROM payment_intents WHERE id = $1", [id]))[0];
  const inbox = async (eventId: string) =>
    db.query("SELECT * FROM webhook_events WHERE event_id = $1", [eventId]);
  const postings = async (key: string) =>
    db.query("SELECT id FROM ledger_transactions WHERE idempotency_key = $1", [key]);

  /** The books must always balance: every currency's entries sum to nothing. */
  async function expectBooksBalance() {
    const rows = await db.query(
      `SELECT currency, sum(CASE direction WHEN 'credit' THEN amount ELSE -amount END)::text AS net
         FROM ledger_entries GROUP BY currency`,
    );
    for (const row of rows) expect(row.net).toBe("0");
  }

  return {
    db,
    ledger,
    fake,
    http,
    person,
    ready,
    payoutAccount,
    seedPayoutAccount,
    reference,
    giveMoney,
    balance,
    seedFunding,
    seedWithdrawal,
    event,
    deliver,
    intent,
    inbox,
    postings,
    expectBooksBalance,
  };
}
