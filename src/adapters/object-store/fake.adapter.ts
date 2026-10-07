import type { ObjectStore, StoredObject } from "./object-store.port.js";

/** Keeps files in memory, for development and tests. Never used in production. */
export class FakeObjectStore implements ObjectStore {
  readonly files = new Map<string, StoredObject>();

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.files.set(key, { body: Uint8Array.from(body), contentType });
  }

  async get(key: string): Promise<StoredObject | null> {
    return this.files.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
}
