import { HttpException, type HttpStatus } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { PaymentResponse } from "./payments.dto.js";
import type { PaymentProvider } from "./providers/provider.port.js";

export type IntentRow = {
  id: string;
  user_id: string;
  kind: "funding" | "withdrawal";
  provider: PaymentProvider["name"];
  method: PaymentResponse["method"];
  currency: string;
  amount: string;
  status: PaymentResponse["status"];
  reference: string;
  provider_id: string | null;
  request_hash: string;
  action: PaymentResponse["action"];
  failure_reason: string | null;
  created_at: Date;
};

export const COLUMNS = `id, user_id, kind, provider, method, currency, amount::text, status, reference,
  provider_id, request_hash, action, failure_reason, created_at`;

export const requestHash = (...parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export const newReference = (prefix: "ajf" | "ajw" | "ajm"): string =>
  `${prefix}_${randomBytes(12).toString("hex")}`;

export const coded = (status: HttpStatus, message: string, code: string) =>
  new HttpException({ message, code }, status);

export function view(row: IntentRow): PaymentResponse {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    method: row.method,
    amount: { amount: row.amount, currency: row.currency },
    action: row.action,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
  };
}
