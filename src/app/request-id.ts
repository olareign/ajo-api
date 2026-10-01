import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RequestWithId = Request & { id?: string };

/** Keeps a caller's request id only if it is a UUID, so nothing hostile reaches logs or headers. */
export function requestIdMiddleware(req: RequestWithId, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  const id = incoming && UUID.test(incoming) ? incoming.toLowerCase() : randomUUID();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
}
