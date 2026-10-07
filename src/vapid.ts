import webpush from "web-push";

/**
 * Makes the key pair web push needs, once. The private key goes only into the API's environment
 * (Render); the public one is safe to share (browsers need it to subscribe).
 * Usage: `pnpm vapid:generate`
 */
const keys = webpush.generateVAPIDKeys();
process.stdout.write(
  [
    "Paste these in Render (Environment) for the API. Keep the private key to yourself.",
    "",
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    "VAPID_SUBJECT=mailto:<an address that reaches you>",
    "",
  ].join("\n"),
);
