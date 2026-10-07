import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { json, raw, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import type { Env } from "../config/env.js";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import { clientContextMiddleware } from "./client-context.js";
import { requestIdMiddleware } from "./request-id.js";

export const API_PREFIX = "api/v1";

/** A request whose exact body bytes were kept, for checking a partner's signature. */
export type RequestWithRawBody = Request & { rawBody?: Buffer };
export const MAX_BODY_SIZE = "100kb";

/**
 * Hardening shared by the real server and the tests. The app must be created with
 * `bodyParser: false` so the size limit below is the only body parser.
 *
 * CORS is deliberately never enabled: browsers reach the API only through the web app's
 * server-side BFF, and the mobile app is not a browser.
 */
export function configureApp(app: NestExpressApplication, env: Env): void {
  app.set("trust proxy", env.TRUST_PROXY_HOPS);
  app.disable("x-powered-by");

  app.use(requestIdMiddleware);
  app.use(clientContextMiddleware(env.BFF_SHARED_SECRET));
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
      xFrameOptions: { action: "deny" },
      crossOriginResourcePolicy: { policy: "same-origin" },
    }),
  );
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  // A profile photo is sent as the picture itself; only that one route reads such a body (5 MB at most).
  app.use(
    `/${API_PREFIX}/me/photo`,
    raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "5mb" }),
  );
  app.use(
    json({
      limit: MAX_BODY_SIZE,
      // A webhook's signature is over the exact bytes sent, so keep them (for webhook paths only).
      verify: (req: Request, _res, buf: Buffer) => {
        if (req.originalUrl?.startsWith(`/${API_PREFIX}/webhooks/`)) {
          (req as RequestWithRawBody).rawBody = buf;
        }
      },
    }),
  );

  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
}
