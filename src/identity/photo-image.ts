import sharp from "sharp";

export const PHOTO_SIZE = 512;
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 24_000_000;

export type PhotoProblem = "unsupported" | "unreadable";

/** The first bytes of a file say what it is, whatever the sender claims (and SVG is never one of them). */
export function sniff(bytes: Uint8Array): "jpeg" | "png" | "webp" | null {
  const at = (i: number) => bytes[i];
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "jpeg";
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "png";
  const ascii = (from: number, to: number) =>
    Buffer.from(bytes.subarray(from, to)).toString("latin1");
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return null;
}

/**
 * Re-draws the picture from its pixels: turned upright, cropped square, shrunk, and saved fresh as
 * WebP. Nothing from the original file survives (location, camera, comments, hidden data).
 */
export async function prepareProfilePhoto(
  bytes: Uint8Array,
): Promise<{ ok: true; image: Buffer } | { ok: false; problem: PhotoProblem }> {
  if (sniff(bytes) === null) return { ok: false, problem: "unsupported" };
  try {
    const image = await sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error" })
      .rotate()
      .resize(PHOTO_SIZE, PHOTO_SIZE, { fit: "cover", position: "centre" })
      .webp({ quality: 82 })
      .toBuffer();
    return { ok: true, image };
  } catch {
    return { ok: false, problem: "unreadable" };
  }
}
