import { Inject, Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { OBJECT_STORE, type ObjectStore } from "../adapters/object-store/object-store.port.js";
import { sql } from "../database/sql.js";
import { prepareProfilePhoto, type PhotoProblem } from "./photo-image.js";

const keyOf = (userId: string) => `avatars/${userId}.webp`;

export type PhotoRead =
  { found: true; body: Uint8Array; contentType: string; version: number } | { found: false };

/** Profile photos: kept private, and shown only to the person and the people they are connected to. */
@Injectable()
export class PhotoService {
  constructor(
    private readonly db: DataSource,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore | null,
  ) {}

  /** False where storage is not switched on. */
  get enabled(): boolean {
    return this.store !== null;
  }

  async set(
    userId: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true; version: number } | { ok: false; problem: PhotoProblem | "off" }> {
    if (!this.store) return { ok: false, problem: "off" };
    const prepared = await prepareProfilePhoto(bytes);
    if (!prepared.ok) return prepared;
    // Write the file first: a failure here leaves the old photo and the old date untouched.
    await this.store.put(keyOf(userId), prepared.image, "image/webp");
    const [row] = await this.db.transaction((tx) =>
      sql<{ version: string }>(
        tx,
        `UPDATE users SET photo_updated_at = now(), updated_at = now() WHERE id = $1
         RETURNING (extract(epoch FROM photo_updated_at) * 1000)::bigint::text AS version`,
        [userId],
      ),
    );
    return { ok: true, version: Number(row!.version) };
  }

  async remove(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET photo_updated_at = NULL, updated_at = now() WHERE id = $1`,
      [userId],
    );
    // The picture is gone for everyone the moment the date is cleared; the file follows.
    await this.store?.delete(keyOf(userId));
  }

  /**
   * Someone's photo, if the viewer may see it: their own, or a friend's, or from someone they have a
   * request open with, never across a block. Every other case answers the same as "no photo".
   */
  async read(viewerId: string, username: string): Promise<PhotoRead> {
    if (!this.store) return { found: false };
    const [owner] = await this.db.query<{ id: string; version: string }[]>(
      `SELECT u.id, (extract(epoch FROM u.photo_updated_at) * 1000)::bigint::text AS version
         FROM users u
        WHERE u.username = $2 AND u.status = 'active' AND u.photo_updated_at IS NOT NULL
          AND (u.id = $1
               OR (EXISTS (SELECT 1 FROM friendships f
                            WHERE f.low_id = least($1::uuid, u.id) AND f.high_id = greatest($1::uuid, u.id))
                   AND NOT EXISTS (SELECT 1 FROM blocks bl
                            WHERE (bl.blocker_id = $1 AND bl.blocked_id = u.id)
                               OR (bl.blocker_id = u.id AND bl.blocked_id = $1))))`,
      [viewerId, username.toLowerCase()],
    );
    if (!owner) return { found: false };
    const file = await this.store.get(keyOf(owner.id));
    if (!file) return { found: false };
    return { found: true, ...file, version: Number(owner.version) };
  }
}
