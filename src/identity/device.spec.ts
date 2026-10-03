import { describeDevice } from "./device.js";

const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

describe("describeDevice", () => {
  it.each([
    [CHROME_ANDROID, "Chrome on Android"],
    [SAFARI_IPHONE, "Safari on iPhone"],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      "Edge on Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      "Safari on macOS",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
      "Samsung Internet on Android",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1",
      "Chrome on iPhone",
    ],
  ])("reads %#: %s", (userAgent, label) => {
    expect(describeDevice(userAgent).label).toBe(label);
  });

  it("is the same device after the browser updates, and a different one for another browser or system", () => {
    const updated = CHROME_ANDROID.replace("130.0.6723.58", "131.0.6778.39").replace(
      "Pixel 8",
      "Pixel 9",
    );
    expect(describeDevice(updated).key).toBe(describeDevice(CHROME_ANDROID).key);
    expect(describeDevice(SAFARI_IPHONE).key).not.toBe(describeDevice(CHROME_ANDROID).key);
    expect(
      describeDevice(CHROME_ANDROID.replace("Linux; Android 14; Pixel 8", "Windows NT 10.0; Win64"))
        .key,
    ).not.toBe(describeDevice(CHROME_ANDROID).key);
  });

  it("gives a stable key that is a SHA-256 hex digest", () => {
    expect(describeDevice(CHROME_ANDROID).key).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([undefined, "", "   ", "node-fetch", "curl/8.4.0", "x".repeat(600)])(
    "never fails on an odd or missing description (%s)",
    (userAgent) => {
      const device = describeDevice(userAgent);
      expect(device.label).toMatch(/^(Unknown device|Browser on Unknown system|.+ on .+)$/);
      expect(device.key).toMatch(/^[0-9a-f]{64}$/);
    },
  );
});
