import { isPushEndpoint } from "./push-sender.port.js";

describe("isPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc123",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://web.push.apple.com/QGxyz",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
  ])("accepts the browsers' own push services: %s", (url) => {
    expect(isPushEndpoint(url)).toBe(true);
  });

  it.each([
    ["a made-up host", "https://evil.example.com/push"],
    ["an internal address", "https://169.254.169.254/latest/meta-data"],
    ["localhost", "https://localhost/push"],
    ["plain http", "http://fcm.googleapis.com/fcm/send/abc"],
    ["a look-alike host", "https://fcm.googleapis.com.evil.example.com/x"],
    ["a suffix trick", "https://notfcm.googleapis.com.example/x"],
    ["credentials in the address", "https://user:pw@fcm.googleapis.com/x"],
    ["an odd port", "https://fcm.googleapis.com:8443/x"],
    ["not a URL", "fcm.googleapis.com/x"],
    ["too long", `https://fcm.googleapis.com/${"a".repeat(2100)}`],
  ])("refuses %s", (_name, url) => {
    expect(isPushEndpoint(url)).toBe(false);
  });
});
