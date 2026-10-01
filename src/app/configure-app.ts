import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import type { Env } from "../config/env.js";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import { requestIdMiddleware } from "./request-id.js";

export const API_PREFIX = "api/v1";
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
  app.useBodyParser("json", { limit: MAX_BODY_SIZE });

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
