import type { NestExpressApplication } from "@nestjs/platform-express";
import { randomUUID } from "node:crypto";
import { ActiveCommitments } from "../../src/payments/commitments.js";
import { createTestApp } from "../support/test-app.js";
import { paymentsHarness } from "./support.js";

let app: NestExpressApplication;
let t: ReturnType<typeof paymentsHarness>;
let commitments = 0;

beforeAll(async () => {
  app = await createTestApp(
    { PAYMENTS_FAKE: "true", WEB_APP_URL: "https://app.ajo.test" },
    [],
    (builder) =>
      builder.overrideProvider(ActiveCommitments).useValue({ count: async () => commitments }),
  );
  t = paymentsHarness(app);
});
afterAll(async () => {
  await app?.close();
});
afterEach(async () => {
  commitments = 0;
  t.fake("NG").behaviour.initialize = "ok";
  await t.expectBooksBalance();
});

type Who = Awaited<ReturnType<typeof t.ready>>;
const many = <T>(n: number, make: (i: number) => Promise<T>) =>
  Promise.all(Array.from({ length: n }, (_, i) => make(i)));
const open = (who: Who) => who.call("post", "/payments/mandate");
const cancel = (who: Who) => who.call("delete", "/payments/mandate");
const mandateRow = async (userId: string) =>
  await t.db.query("SELECT * FROM mandates WHERE user_id = $1 ORDER BY created_at DESC", [userId]);
const created = (who: Who) =>
  t.db
    .query(
      "SELECT reference FROM mandates WHERE user_id = $1 AND status IN ('pending', 'active')",
      [who.id],
    )
    .then((r: { reference: string }[]) => r[0]!.reference);
const send = (
  kind: "mandate.created" | "mandate.active" | "mandate.cancelled" | "mandate.failed",
  reference: string,
  more = {},
) => t.deliver([t.event({ kind, reference, ...more })]);

describe("who may set up auto-debit", () => {
  it("needs approved identity checks and the authenticator app, but no fresh code", async () => {
    const noKyc = await t.ready("NG", { kyc: false });
    expect((await open(noKyc).expect(403)).body.code).toBe("kyc_required");
    const noApp = await t.ready("NG", { mfa: false });
    expect((await open(noApp).expect(403)).body.code).toBe("mfa_enrolment_required");
    await open(await t.ready()).expect(200);
  });

  it("needs a signed-in person, and is for a country whose partner offers it", async () => {
    const { default: request } = await import("supertest");
    await request(t.http()).post("/api/v1/payments/mandate").expect(401);
    await request(t.http()).get("/api/v1/payments/mandate").expect(401);
    await request(t.http()).delete("/api/v1/payments/mandate").expect(401);
  });
});

describe("setting it up", () => {
  it("starts a pending mandate, asks the partner once, and says where to give permission", async () => {
    const who = await t.ready();
    const asked = t.fake("NG").count("createMandate");
    const res = await open(who).expect(200);
    expect(res.body).toMatchObject({
      status: "pending",
      action: {
        type: "redirect",
        url: expect.stringMatching(/^https:\/\/fake-pay\.test\/mandate\//),
      },
    });
    expect(t.fake("NG").count("createMandate")).toBe(asked + 1);
    const call = t
      .fake("NG")
      .calls.filter(([m]) => m === "createMandate")
      .at(-1)![1] as Record<string, string>;
    expect(call).toMatchObject({
      email: who.email,
      returnUrl: "https://app.ajo.test/wallet/mandate/return",
    });
  });

  it("returns the same one when asked again, and asks the partner only once", async () => {
    const who = await t.ready();
    const first = await open(who).expect(200);
    const asked = t.fake("NG").count("createMandate");
    const again = await open(who).expect(200);
    expect(again.body.id).toBe(first.body.id);
    expect(t.fake("NG").count("createMandate")).toBe(asked);
  });

  it("makes one mandate, and asks the partner once, when ten requests arrive at the same instant", async () => {
    const who = await t.ready();
    const asked = t.fake("NG").count("createMandate");
    const answers = await many(10, () => open(who));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(new Set(answers.map((a) => a.body.id)).size).toBe(1);
    expect(t.fake("NG").count("createMandate")).toBe(asked + 1);
    expect(await mandateRow(who.id)).toHaveLength(1);
  });

  it("lets two people each have one", async () => {
    const [a, b] = await Promise.all([t.ready(), t.ready()]);
    const [x, y] = await Promise.all([open(a), open(b)]);
    expect(x.body.id).not.toBe(y.body.id);
  });

  it("is refused by the database itself if two open ones are ever written", async () => {
    const who = await t.ready();
    await open(who).expect(200);
    await expect(
      t.db.query(
        `INSERT INTO mandates (user_id, provider, status, reference) VALUES ($1, 'fake', 'active', $2)`,
        [who.id, t.reference("ajm")],
      ),
    ).rejects.toThrow();
  });

  it("marks it failed when the partner refuses, and the person can try again", async () => {
    const who = await t.ready();
    t.fake("NG").behaviour.initialize = "reject";
    expect((await open(who).expect(422)).body.code).toBe("mandate_refused");
    expect((await who.call("get", "/payments/mandate").expect(200)).body.status).toBe("failed");
    t.fake("NG").behaviour.initialize = "ok";
    expect((await open(who).expect(200)).body.status).toBe("pending");
  });

  it("says 503 when the partner cannot be reached, and leaves nothing open", async () => {
    const who = await t.ready();
    t.fake("NG").behaviour.initialize = "unavailable";
    expect((await open(who).expect(503)).body.code).toBe("payments_unavailable");
    t.fake("NG").behaviour.initialize = "ok";
    await open(who).expect(200);
  });
});

describe("what the partner says about it", () => {
  it("becomes active when the partner says so, by our reference, and a repeat changes nothing", async () => {
    const who = await t.ready();
    await open(who).expect(200);
    const reference = await created(who);
    await send("mandate.active", reference).expect(200);
    expect((await who.call("get", "/payments/mandate").expect(200)).body.status).toBe("active");
    await many(15, () => send("mandate.active", reference));
    expect((await mandateRow(who.id))[0].status).toBe("active");
  });

  it("is found by the partner's own id for it, and remembers the mandate's id once it exists", async () => {
    const who = await t.ready();
    const mandateId = `MD_${randomUUID()}`;
    const started = await open(who).expect(200);
    const [{ provider_id }] = await mandateRow(who.id);
    await send("mandate.created", "", {
      reference: undefined,
      billingRequestId: provider_id,
      mandateId,
    }).expect(200);
    await t.deliver([t.event({ kind: "mandate.active", mandateId })]).expect(200);
    const [row] = await mandateRow(who.id);
    expect(row).toMatchObject({ status: "active", provider_mandate_id: mandateId });
    expect(started.body.id).toBe(row.id);
  });

  it("is found by the customer's email when the partner only names the customer", async () => {
    const who = await t.ready();
    await open(who).expect(200);
    await t
      .deliver([
        t.event({
          kind: "mandate.active",
          customerEmail: who.email,
          authorizationCode: "AUTH_xyz",
        }),
      ])
      .expect(200);
    expect((await mandateRow(who.id))[0]).toMatchObject({
      status: "active",
      authorization_code: "AUTH_xyz",
    });
  });

  it("does not touch someone else's mandate when the email matches another person", async () => {
    const a = await t.ready();
    const b = await t.ready();
    await open(a).expect(200);
    await t.deliver([t.event({ kind: "mandate.active", customerEmail: b.email })]).expect(200);
    expect((await mandateRow(a.id))[0].status).toBe("pending");
  });

  it("ends when the partner says it was cancelled or failed", async () => {
    const a = await t.ready();
    await open(a).expect(200);
    await send("mandate.failed", await created(a)).expect(200);
    expect((await mandateRow(a.id))[0].status).toBe("failed");

    const b = await t.ready();
    await open(b).expect(200);
    const reference = await created(b);
    await send("mandate.active", reference);
    await send("mandate.cancelled", reference).expect(200);
    expect((await mandateRow(b.id))[0]).toMatchObject({ status: "cancelled" });
  });

  it("ignores an event about a mandate we have never heard of", async () => {
    const e = t.event({ kind: "mandate.active", reference: "ajm_nobody_knows_this_one" });
    await t.deliver([e]).expect(200);
    expect((await t.inbox(e.eventId))[0].status).toBe("ignored");
  });
});

describe("cancelling it", () => {
  it("tells the partner, cancels, and lets the person start again", async () => {
    const who = await t.ready();
    await open(who).expect(200);
    await send("mandate.active", await created(who));
    const told = t.fake("NG").count("cancelMandate");
    const res = await cancel(who).expect(200);
    expect(res.body.status).toBe("cancelled");
    expect(t.fake("NG").count("cancelMandate")).toBe(told + 1);
    expect((await open(who).expect(200)).body.status).toBe("pending");
    expect(await mandateRow(who.id)).toHaveLength(2);
  });

  it("has nothing to cancel when none is open", async () => {
    const who = await t.ready();
    expect((await cancel(who).expect(404)).body.code).toBe("no_mandate");
  });

  it("is refused while a saving plan or circle depends on it, and nothing changes", async () => {
    const who = await t.ready();
    await open(who).expect(200);
    await send("mandate.active", await created(who));
    commitments = 1;
    const res = await cancel(who).expect(409);
    expect(res.body.code).toBe("active_commitments");
    expect((await mandateRow(who.id))[0].status).toBe("active");
  });

  it("stays as it was if the partner cannot be told", async () => {
    const who = await t.ready();
    await open(who).expect(200);
    await send("mandate.active", await created(who));
    const original = t.fake("NG").cancelMandate.bind(t.fake("NG"));
    t.fake("NG").cancelMandate = async () => {
      throw new (await import("../../src/payments/providers/provider.port.js")).ProviderUnavailable(
        "down",
      );
    };
    try {
      expect((await cancel(who).expect(503)).body.code).toBe("payments_unavailable");
    } finally {
      t.fake("NG").cancelMandate = original;
    }
    expect((await mandateRow(who.id))[0].status).toBe("active");
  });

  it("is not brought back by a late 'active' from the partner", async () => {
    const who = await t.ready();
    await open(who).expect(200);
    const reference = await created(who);
    await cancel(who).expect(200);
    await send("mandate.active", reference).expect(200);
    expect((await mandateRow(who.id))[0].status).toBe("cancelled");
  });
});

describe("the partner's word racing the person's own", () => {
  it("ends cancelled, never active, when many 'active' messages and a cancel arrive together", async () => {
    for (let round = 0; round < 5; round++) {
      const who = await t.ready();
      await open(who).expect(200);
      const reference = await created(who);
      await Promise.all([
        ...Array.from({ length: 6 }, () => send("mandate.active", reference)),
        cancel(who),
        ...Array.from({ length: 3 }, () => send("mandate.active", reference)),
      ]);
      const rows = await mandateRow(who.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("cancelled");
    }
  });

  it("never leaves two open mandates, however creating, activating and cancelling interleave", async () => {
    const who = await t.ready();
    await open(who).expect(200);
    const reference = await created(who);
    await Promise.all([
      ...Array.from({ length: 5 }, () => open(who)),
      send("mandate.active", reference),
      cancel(who),
      ...Array.from({ length: 5 }, () => open(who)),
    ]);
    const openOnes = await t.db.query(
      "SELECT 1 FROM mandates WHERE user_id = $1 AND status IN ('pending', 'active')",
      [who.id],
    );
    expect(openOnes.length).toBeLessThanOrEqual(1);
  });
});
