import { AwsClient } from "aws4fetch";
import type { ObjectStore, StoredObject } from "./object-store.port.js";

type Fetch = (request: Request) => Promise<Response>;

/** What it takes to reach one Cloudflare R2 bucket. The two keys are secrets: never log them. */
export type R2Settings = Readonly<{
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}>;

/**
 * Cloudflare R2 through its S3-compatible API, requests signed here (SigV4) so no SDK is needed. The
 * bucket stays private; keys are never built from what a person typed, only from ids we made.
 */
export class R2ObjectStore implements ObjectStore {
  private readonly client: AwsClient;
  private readonly base: string;

  constructor(
    settings: R2Settings,
    private readonly fetchFn: Fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {
    this.client = new AwsClient({
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    this.base = `https://${settings.accountId}.r2.cloudflarestorage.com/${settings.bucket}`;
  }

  private async send(
    method: "GET" | "PUT" | "DELETE",
    key: string,
    options: { body?: Uint8Array; contentType?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.contentType) headers["Content-Type"] = options.contentType;
    const signed = await this.client.sign(`${this.base}/${key}`, {
      method,
      headers,
      body: options.body as BodyInit | undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return this.fetchFn(signed);
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const res = await this.send("PUT", key, { body, contentType });
    if (!res.ok) throw new Error(`Storage refused a write (${res.status})`);
  }

  async get(key: string): Promise<StoredObject | null> {
    const res = await this.send("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Storage refused a read (${res.status})`);
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.send("DELETE", key);
    if (!res.ok && res.status !== 404) throw new Error(`Storage refused a delete (${res.status})`);
  }
}
