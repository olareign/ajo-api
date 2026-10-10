import { OpenExchangeRates } from "./openexchangerates.adapter.js";

const APP_ID = "0123456789abcdef0123456789abcdef";
const answer = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("OpenExchangeRates", () => {
  it("reads the latest dollar rates and when they were true", async () => {
    let asked = "";
    const source = new OpenExchangeRates(APP_ID, (async (url: string) => {
      asked = url;
      return answer(200, {
        base: "USD",
        timestamp: 1_790_000_000,
        rates: { NGN: 1532.5, GBP: 0.78, EUR: 0.91, BAD: "x", zz: 1 },
      })();
    }) as typeof fetch);
    const latest = await source.latest();
    expect(asked).toBe(`https://openexchangerates.org/api/latest.json?app_id=${APP_ID}`);
    expect(latest).toEqual({
      asOf: new Date(1_790_000_000_000),
      rates: { NGN: 1532.5, GBP: 0.78, EUR: 0.91 },
      source: "openexchangerates",
    });
  });

  it("fails plainly on a refusal, an outage or an answer it can't read, without ever naming the App ID", async () => {
    const cases = [
      answer(401, { error: true, message: "invalid_app_id" }),
      answer(200, { base: "EUR", timestamp: 1, rates: {} }),
      answer(200, { nonsense: true }),
      async () => {
        throw new Error(`connect failed for ${APP_ID}`);
      },
    ];
    for (const fetchFn of cases) {
      const error = await new OpenExchangeRates(APP_ID, fetchFn as unknown as typeof fetch)
        .latest()
        .catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain(APP_ID);
    }
  });
});
