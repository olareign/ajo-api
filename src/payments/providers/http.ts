import { ProviderRejected, ProviderUnavailable } from "./provider.port.js";

export type HttpFetch = typeof fetch;

export const TIMEOUT_MS = 15_000;

export type Reply<T> = Readonly<{ status: number; body: T }>;

/**
 * One call to a partner, with the two kinds of failure kept apart:
 * - a clear refusal (a 4xx with the partner's own message) is `ProviderRejected`: nothing happened;
 * - anything we cannot be sure of (no answer, a dropped connection, a 5xx, a throttle, an answer we do
 *   not understand) is `ProviderUnavailable`: the partner may or may not have acted.
 * `acceptable` lists statuses the caller wants to look at itself (a 404 on a status check, say).
 */
export async function call<T = Record<string, unknown>>(
  fetchFn: HttpFetch,
  url: string,
  init: Readonly<{
    method: "GET" | "POST" | "PUT";
    headers: Record<string, string>;
    body?: unknown;
    acceptable?: readonly number[];
    /** Pulls the partner's own words out of an error body. */
    messageOf: (body: unknown) => string | undefined;
  }>,
): Promise<Reply<T>> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: init.method,
      headers: { Accept: "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderUnavailable("The payment partner did not answer.");
  }
  const text = await response.text().catch(() => "");
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    if (response.ok)
      throw new ProviderUnavailable("The payment partner sent an answer we cannot read.");
  }
  if (response.ok || init.acceptable?.includes(response.status)) {
    return { status: response.status, body: body as T };
  }
  if (response.status >= 500 || response.status === 429 || response.status === 408) {
    throw new ProviderUnavailable(`The payment partner is not available (${response.status}).`);
  }
  throw new ProviderRejected(
    init.messageOf(body) ?? `The payment partner refused it (${response.status}).`,
  );
}

export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

export const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** Money as a whole number of minor units, as a string; undefined if it is not one. */
export function minor(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  return undefined;
}
