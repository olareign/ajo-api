import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { NextFunction, Request, Response } from "express";

/** Sent by the web app's server alongside its own calls; never by a browser, which cannot know the secret. */
export const BFF_SECRET_HEADER = "x-ajo-bff-secret";
export const CLIENT_IP_HEADER = "x-ajo-client-ip";
export const CLIENT_UA_HEADER = "x-ajo-client-ua";
const OWN_HEADERS = [BFF_SECRET_HEADER, CLIENT_IP_HEADER, CLIENT_UA_HEADER] as const;

const MAX_USER_AGENT = 512;

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Every browser reaches this API through the web app's server, so the connection always comes from
 * that server's address. That made every rate limit apply to all users together, and recorded the
 * wrong address and device on every session. The web server therefore says who the person behind a
 * call is, and proves it is the web server with a shared secret. Only then do their address and
 * device replace the connection's, for rate limits, sessions and sign-in alerts alike.
 *
 * Without a configured secret, or with a missing or wrong one, the headers are ignored. They are
 * removed in every case, so the secret travels no further into the application.
 */
export function clientContextMiddleware(secret: string | undefined) {
  const expected = secret ? digest(secret) : undefined;
  return (req: Request, _res: Response, next: NextFunction): void => {
    const presented = req.headers[BFF_SECRET_HEADER];
    const ip = req.headers[CLIENT_IP_HEADER];
    const userAgent = req.headers[CLIENT_UA_HEADER];
    for (const header of OWN_HEADERS) delete req.headers[header];

    const proven =
      expected !== undefined &&
      typeof presented === "string" &&
      timingSafeEqual(digest(presented), expected);
    if (proven) {
      if (typeof ip === "string" && isIP(ip.trim()) !== 0) {
        // `req.ip` is what the rate limiter and the sessions read.
        Object.defineProperty(req, "ip", {
          value: ip.trim(),
          configurable: true,
          enumerable: true,
        });
      }
      if (typeof userAgent === "string" && userAgent.length > 0) {
        req.headers["user-agent"] = userAgent.slice(0, MAX_USER_AGENT);
      }
    }
    next();
  };
}
