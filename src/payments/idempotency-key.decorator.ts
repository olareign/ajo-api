import { BadRequestException, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

const KEY = /^[A-Za-z0-9_\-:.]{8,100}$/;

/**
 * The caller's `Idempotency-Key` header: a value the app makes up once per attempt and repeats if it
 * has to retry, so the same attempt is never done twice. 8 to 100 letters, digits and `_-:.`.
 */
export const IdempotencyKey = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<Request>().header("idempotency-key")?.trim();
  if (!value || !KEY.test(value)) {
    throw new BadRequestException({
      message: "Send an Idempotency-Key header of 8 to 100 letters, digits or _-:.",
      code: "idempotency_key_required",
    });
  }
  return value;
});
