export type StoredObject = Readonly<{ body: Uint8Array; contentType: string }>;

/**
 * Private file storage (profile photos now; identity documents later). Nothing in it is ever
 * public: every read goes through the API, which decides who may see what.
 */
export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** null when there is nothing under that key. */
  get(key: string): Promise<StoredObject | null>;
  /** Deleting what is not there is fine. */
  delete(key: string): Promise<void>;
}

/** Null where storage is not switched on (production without R2 settings): features that need it say so. */
export const OBJECT_STORE = Symbol("OBJECT_STORE");
