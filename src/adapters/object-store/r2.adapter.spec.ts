import { R2ObjectStore } from "./r2.adapter.js";

const settings = {
  accountId: "a".repeat(32),
  accessKeyId: "AKIAEXAMPLEKEY123",
  secretAccessKey: "super-secret-value-do-not-log",
  bucket: "ajo-media",
};

function store(respond: (req: Request) => Response) {
  const seen: Request[] = [];
  const fetchFn = async (req: Request) => {
    seen.push(req);
    return respond(req);
  };
  return { seen, store: new R2ObjectStore(settings, fetchFn) };
}

describe("R2ObjectStore", () => {
  it("writes to the bucket's own address with a signed request, and never sends the secret", async () => {
    const { seen, store: r2 } = store(() => new Response(null, { status: 200 }));
    await r2.put("avatars/u1.webp", new Uint8Array([1, 2, 3]), "image/webp");
    const [req] = seen;
    expect(req!.method).toBe("PUT");
    expect(req!.url).toBe(
      `https://${"a".repeat(32)}.r2.cloudflarestorage.com/ajo-media/avatars/u1.webp`,
    );
    expect(req!.headers.get("content-type")).toBe("image/webp");
    const auth = req!.headers.get("authorization")!;
    expect(auth).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEKEY123\/\d{8}\/auto\/s3\/aws4_request/,
    );
    expect(JSON.stringify([...req!.headers])).not.toContain(settings.secretAccessKey);
    expect(new Uint8Array(await req!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reads a file back with its type, and answers null for one that is not there", async () => {
    const found = store(
      () => new Response(new Uint8Array([9, 8]), { headers: { "content-type": "image/webp" } }),
    );
    expect(await found.store.get("avatars/u1.webp")).toEqual({
      body: new Uint8Array([9, 8]),
      contentType: "image/webp",
    });
    const missing = store(() => new Response(null, { status: 404 }));
    expect(await missing.store.get("avatars/none.webp")).toBeNull();
  });

  it("deleting what is not there is fine, but a refusal is an error that does not carry the secret", async () => {
    const gone = store(() => new Response(null, { status: 404 }));
    await expect(gone.store.delete("avatars/u1.webp")).resolves.toBeUndefined();
    const refused = store(() => new Response("denied", { status: 403 }));
    const failure = await refused.store.put("k", new Uint8Array([1]), "image/webp").catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure.message)).toContain("403");
    expect(String(failure.message)).not.toContain(settings.secretAccessKey);
    await expect(refused.store.get("k")).rejects.toThrow("403");
  });
});
