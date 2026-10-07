import type { NestExpressApplication } from "@nestjs/platform-express";
import sharp from "sharp";
import request from "supertest";
import { OBJECT_STORE } from "../../src/adapters/object-store/object-store.port.js";
import { FakeObjectStore } from "../../src/adapters/object-store/fake.adapter.js";
import { friendsHarness } from "../friends/support.js";
import { createTestApp } from "../support/test-app.js";

let app: NestExpressApplication;
let h: ReturnType<typeof friendsHarness>;
let store: FakeObjectStore;

beforeAll(async () => {
  app = await createTestApp({ PAYMENTS_FAKE: "true" });
  h = friendsHarness(app);
  store = app.get<FakeObjectStore>(OBJECT_STORE);
});
afterAll(async () => {
  await app?.close();
});

const png = (w = 300, h = 200) =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#c8962e" } })
    .png()
    .toBuffer();
type Who = Awaited<ReturnType<typeof h.member>>;
const put = (who: Who, body: Buffer | string, type = "image/png") =>
  who.call("put", "/me/photo").set("Content-Type", type).send(body);

describe("profile pictures", () => {
  it("stores a redrawn 512 square privately, and shows the version on /me", async () => {
    const me = await h.member();
    const before = (await me.call("get", "/me").expect(200)).body;
    expect(before.photoVersion).toBeNull();
    expect(before.photosEnabled).toBe(true);
    const res = await put(me, await png()).expect(200);
    expect(res.body.version).toBeGreaterThan(0);
    expect((await me.call("get", "/me").expect(200)).body.photoVersion).toBe(res.body.version);
    const kept = store.files.get(`avatars/${me.id}.webp`)!;
    expect(kept.contentType).toBe("image/webp");
    const meta = await sharp(kept.body).metadata();
    expect([meta.width, meta.height]).toEqual([512, 512]);
  });

  it("shows it to its owner and to a friend, with caching headers, and to nobody else", async () => {
    const [ada, ben, stranger] = [await h.member(), await h.member(), await h.member()];
    await put(ada, await png()).expect(200);
    await h.befriend(ada, ben);
    const own = await ada.call("get", `/photos/${ada.username}`).expect(200);
    expect(own.headers["content-type"]).toContain("image/webp");
    expect(own.headers["cache-control"]).toBe("private, max-age=86400");
    await ben.call("get", `/photos/${ada.username}`).expect(200);
    // A stranger gets the same answer as for a person with no photo.
    await stranger.call("get", `/photos/${ada.username}`).expect(404);
    await stranger.call("get", `/photos/nobody${Date.now()}`).expect(404);
    await request(h.t.http()).get(`/api/v1/photos/${ada.username}`).expect(401);
  });

  it("is hidden across a block, and a friend's list carries the version only for the connected", async () => {
    const [ada, ben] = [await h.member(), await h.member()];
    const { version } = (await put(ada, await png()).expect(200)).body;
    await h.befriend(ada, ben);
    const list = (await ben.call("get", "/friends").expect(200)).body.friends;
    expect(list.find((f: { username: string }) => f.username === ada.username).photoVersion).toBe(
      version,
    );
    await ben.call("post", "/friends/blocks").send({ username: ada.username }).expect(204);
    await ben.call("get", `/photos/${ada.username}`).expect(404);
  });

  it("does not offer a photo in search results to people who are not connected", async () => {
    const [ada, ben] = [await h.member(), await h.member()];
    await put(ada, await png()).expect(200);
    const found = (
      await ben.call("get", `/friends/search?q=${ada.username.slice(0, 10)}`).expect(200)
    ).body.find((p: { username: string }) => p.username === ada.username);
    expect(found?.photoVersion ?? null).toBeNull();
  });

  it("refuses SVG, a file posing as a picture, nothing at all, and a picture over 5 MB", async () => {
    const me = await h.member();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    expect((await put(me, svg, "image/png").expect(400)).body.code).toBe("photo_unsupported");
    await put(me, svg, "image/svg+xml").expect(400);
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100, 1)]);
    expect((await put(me, fake, "image/jpeg").expect(400)).body.code).toBe("photo_unreadable");
    await put(me, Buffer.alloc(0)).expect(400);
    await put(me, Buffer.alloc(5 * 1024 * 1024 + 10, 1)).expect(413);
    expect((await me.call("get", "/me").expect(200)).body.photoVersion).toBeNull();
  });

  it("removes it for everyone at once and deletes the file", async () => {
    const [ada, ben] = [await h.member(), await h.member()];
    await put(ada, await png()).expect(200);
    await h.befriend(ada, ben);
    await ben.call("get", `/photos/${ada.username}`).expect(200);
    await ada.call("delete", "/me/photo").expect(204);
    await ben.call("get", `/photos/${ada.username}`).expect(404);
    expect(store.files.has(`avatars/${ada.id}.webp`)).toBe(false);
    expect((await ada.call("get", "/me").expect(200)).body.photoVersion).toBeNull();
  });
});
