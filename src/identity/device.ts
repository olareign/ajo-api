import { createHash } from "node:crypto";

export type Device = Readonly<{ key: string; label: string }>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// Order matters: Edge, Opera and Samsung's browser all say "Chrome" too, and an iPhone says "Mac OS X".
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/CriOS|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows NT/, "Windows"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/CrOS/, "ChromeOS"],
  [/Linux|X11/, "Linux"],
];

const firstMatch = (list: readonly (readonly [RegExp, string])[], text: string) =>
  list.find(([pattern]) => pattern.test(text))?.[1];

/**
 * What kind of device a sign-in came from, read from its browser's own description: "Chrome on
 * Android". The key is the same after a browser update or a new phone of the same kind, and different
 * for another browser or system, so a sign-in alert fires for a genuinely different device and not on
 * every update. Not a security boundary (a description can be faked), only a prompt to look.
 */
export function describeDevice(userAgent: string | undefined): Device {
  const text = (userAgent ?? "").slice(0, 512).trim();
  const browser = firstMatch(BROWSERS, text);
  const system = firstMatch(SYSTEMS, text);
  if (!browser && !system) return { key: hash("unknown"), label: "Unknown device" };
  return {
    key: hash(`${browser ?? "?"}|${system ?? "?"}`),
    label: `${browser ?? "Browser"} on ${system ?? "unknown system"}`,
  };
}
