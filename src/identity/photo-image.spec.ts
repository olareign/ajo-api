import sharp from "sharp";
import { prepareProfilePhoto, sniff } from "./photo-image.js";

const solid = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#2f6f4e" } });

describe("sniff", () => {
  it("knows the three allowed kinds by their first bytes, and nothing else", async () => {
    expect(sniff(await solid(8, 8).jpeg().toBuffer())).toBe("jpeg");
    expect(sniff(await solid(8, 8).png().toBuffer())).toBe("png");
    expect(sniff(await solid(8, 8).webp().toBuffer())).toBe("webp");
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniff(Buffer.from("GIF89a"))).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
  });
});

describe("prepareProfilePhoto", () => {
  it("makes a 512 by 512 WebP from any size, cropped to the centre", async () => {
    const wide = await prepareProfilePhoto(await solid(1600, 900).jpeg().toBuffer());
    expect(wide.ok).toBe(true);
    if (!wide.ok) return;
    const meta = await sharp(wide.image).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 512, 512]);
  });

  it("drops what was hidden in the file: location, camera and orientation tags", async () => {
    const tagged = await solid(300, 200)
      .withExif({ IFD0: { Make: "SecretCam", Software: "tracker" }, IFD3: { GPSLatitudeRef: "N" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();
    const out = await prepareProfilePhoto(tagged);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect((await sharp(out.image).metadata()).exif).toBeUndefined();
    expect(out.image.toString("latin1")).not.toContain("SecretCam");
  });

  it("refuses SVG and other kinds, and files that look right but cannot be read", async () => {
    expect(await prepareProfilePhoto(Buffer.from("<svg onload='x()'></svg>"))).toEqual({
      ok: false,
      problem: "unsupported",
    });
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
    expect(await prepareProfilePhoto(broken)).toEqual({ ok: false, problem: "unreadable" });
  });
});
