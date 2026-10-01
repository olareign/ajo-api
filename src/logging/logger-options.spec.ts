import { Writable } from "node:stream";
import pino from "pino";
import { loadEnv } from "../config/env.js";
import { PRODUCTION_TEST_ENV } from "../config/test-env.js";
import { buildLoggerOptions, REDACTED } from "./logger-options.js";

const env = loadEnv(PRODUCTION_TEST_ENV);

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const logger = pino(buildLoggerOptions(env).pinoHttp as pino.LoggerOptions, stream);
  return { logger, output: () => lines.join("") };
}

describe("buildLoggerOptions", () => {
  it("writes structured JSON at the configured level", () => {
    const { logger, output } = capture();
    logger.debug("hidden");
    logger.info({ requestId: "r1" }, "shown");
    expect(output()).not.toContain("hidden");
    expect(JSON.parse(output())).toMatchObject({ level: 30, msg: "shown", requestId: "r1" });
  });

  it("redacts credentials and personal data wherever they appear", () => {
    const { logger, output } = capture();
    logger.info({
      req: { headers: { authorization: "Bearer abc.def", cookie: "session=xyz" } },
      body: {
        password: "hunter2",
        pin: "1234",
        otp: "123456",
        refreshToken: "rt-secret",
        bvn: "22222222222",
        idNumber: "A1234567",
      },
      user: { email: "ada@example.com", phone: "+2348012345678" },
    });
    const text = output();
    for (const secret of [
      "abc.def",
      "session=xyz",
      "hunter2",
      '1234"',
      "123456",
      "rt-secret",
      "22222222222",
      "A1234567",
      "ada@example.com",
      "+2348012345678",
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).toContain(REDACTED);
  });

  it("logs the request id assigned by the request-id middleware", () => {
    const genReqId = buildLoggerOptions(env).pinoHttp as unknown as {
      genReqId: (req: { id?: string }) => string;
    };
    expect(genReqId.genReqId({ id: "abc" })).toBe("abc");
  });

  it("never logs health-check noise", () => {
    const { autoLogging } = buildLoggerOptions(env).pinoHttp as {
      autoLogging: { ignore: (req: { url?: string }) => boolean };
    };
    expect(autoLogging.ignore({ url: "/api/v1/health/live" })).toBe(true);
    expect(autoLogging.ignore({ url: "/api/v1/wallet" })).toBe(false);
  });
});
