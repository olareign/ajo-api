import type { IncomingMessage } from "node:http";
import type { Params } from "nestjs-pino";
import type { Env } from "../config/env.js";

export const REDACTED = "[REDACTED]";

/** Keys that hold credentials or personal data, redacted at any depth up to three levels. */
const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "password",
  "newPassword",
  "currentPassword",
  "pin",
  "otp",
  "token",
  "accessToken",
  "refreshToken",
  "secret",
  "bvn",
  "nin",
  "idNumber",
  "accountNumber",
  "email",
  "phone",
];

const redactPaths = SENSITIVE_KEYS.flatMap((key) => {
  const prop = /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`;
  return [prop.slice(prop.startsWith(".") ? 1 : 0), `*${prop}`, `*.*${prop}`, `*.*.*${prop}`];
});

export function buildLoggerOptions(env: Env): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      redact: { paths: redactPaths, censor: REDACTED },
      // Use the id set by the request-id middleware (a validated UUID).
      genReqId: (req: IncomingMessage) => req.id ?? "unknown",
      autoLogging: {
        ignore: (req: IncomingMessage) => req.url?.startsWith("/api/v1/health") ?? false,
      },
      // Log method, path and status only: no query strings, bodies or headers.
      serializers: {
        req: (req: { id?: string; method?: string; url?: string }) => ({
          id: req.id,
          method: req.method,
          path: req.url?.split("?")[0],
        }),
        res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      },
      ...(env.NODE_ENV === "development"
        ? { transport: { target: "pino-pretty", options: { singleLine: true } } }
        : {}),
    },
  };
}
