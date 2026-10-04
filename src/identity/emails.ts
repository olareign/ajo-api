type Email = { subject: string; text: string; html: string };

// The app's own colours (apps/web globals.css), so a message looks like the place it came from.
const GREEN = "#057a3f";
const DEEP = "#035e30";
const TINT = "#e3f5eb";
const GOLD_TINT = "#fbefd2";
const GOLD = "#d99a1e";
const GOLD_INK = "#7a5306";
const INK = "#0f1f17";
const MUTED = "#4a5750";
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Content = Readonly<{
  /** The line a mail app shows beside the subject, before the message is opened. */
  preheader: string;
  heading: string;
  paragraphs: readonly string[];
  button: Readonly<{ label: string; href: string }>;
  /** Small pills under the heading, such as how long a link lasts. */
  chips?: readonly string[];
  /** A label and value pair for each fact worth seeing at a glance. */
  facts?: readonly (readonly [string, string])[];
  /** The gold heads-up box: what to do if this was not the reader. */
  note?: string;
}>;

/** The logo lives with the web app; use the same address the link points to, so each site sends its own. */
function logoUrl(href: string): string | null {
  try {
    return `${new URL(href).origin}/email/logo.png`;
  } catch {
    return null;
  }
}

function header(href: string): string {
  const logo = logoUrl(href);
  const mark = logo
    ? `<img src="${escapeHtml(logo)}" width="168" alt="Àjọ" style="display:block;border:0;outline:none;height:auto;width:168px;max-width:100%">`
    : `<span style="font:700 32px/1 ${FONT};color:${GREEN}">Àjọ</span>`;
  // A white badge with a dashed "stitched" edge round it: the same thread the member card has in the app.
  return `<tr><td align="center" bgcolor="${DEEP}" style="background:${DEEP};padding:28px 24px;border-radius:16px 16px 0 0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border:1.5px dashed #6fb691;border-radius:18px;padding:8px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#ffffff" style="background:#ffffff;border-radius:12px;padding:14px 22px">${mark}</td></tr></table>
</td></tr></table></td></tr>`;
}

function chip(text: string): string {
  return `<span style="display:inline-block;background:${TINT};color:${DEEP};border-radius:999px;padding:4px 12px;margin:0 6px 6px 0;font:600 12px/18px ${FONT}">${escapeHtml(text)}</span>`;
}

function facts(rows: readonly (readonly [string, string])[]): string {
  const lines = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:10px 0;border-top:1px dashed #d4dbd6;font:600 13px/18px ${FONT};color:${MUTED};width:90px;vertical-align:top">${escapeHtml(label)}</td><td style="padding:10px 0;border-top:1px dashed #d4dbd6;font:600 15px/22px ${FONT};color:${INK}">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px">${lines}</table>`;
}

function render(c: Content): string {
  const body = c.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font:400 16px/25px ${FONT};color:${INK}">${escapeHtml(p)}</p>`,
    )
    .join("");
  const href = escapeHtml(c.button.href);
  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(c.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#eef2ef">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#eef2ef;font-size:1px;line-height:1px">${escapeHtml(c.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2ef" style="background:#eef2ef">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px">
${header(c.button.href)}
<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:32px 28px 8px;border-left:1px solid #dfe5e1;border-right:1px solid #dfe5e1">
<h1 style="margin:0 0 14px;font:700 26px/32px ${FONT};color:${DEEP}">${escapeHtml(c.heading)}</h1>
${c.chips?.length ? `<div style="margin:0 0 18px">${c.chips.map(chip).join("")}</div>` : ""}
${body}
${c.facts?.length ? facts(c.facts) : ""}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 22px"><tr><td align="center" bgcolor="${GREEN}" style="background:${GREEN};border-radius:12px"><a href="${href}" style="display:inline-block;padding:15px 30px;font:600 16px/20px ${FONT};color:#ffffff;text-decoration:none;border-radius:12px">${escapeHtml(c.button.label)}</a></td></tr></table>
<p style="margin:0 0 6px;font:400 13px/20px ${FONT};color:${MUTED}">If the button doesn't work, paste this link into your browser:</p>
<p style="margin:0 0 24px;font:400 13px/20px ${FONT};word-break:break-all"><a href="${href}" style="color:${GREEN}">${href}</a></p>
${
  c.note
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px"><tr><td bgcolor="${GOLD_TINT}" style="background:${GOLD_TINT};border-left:4px solid ${GOLD};border-radius:8px;padding:14px 16px;font:400 14px/21px ${FONT};color:${GOLD_INK}">${escapeHtml(c.note)}</td></tr></table>`
    : ""
}
</td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;border-left:1px solid #dfe5e1;border-right:1px solid #dfe5e1;padding:0 28px"><div style="border-top:2px dashed #d4dbd6;font-size:0;line-height:0">&nbsp;</div></td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;padding:18px 28px 28px;border:1px solid #dfe5e1;border-top:0;border-radius:0 0 16px 16px">
<p style="margin:0 0 4px;font:700 14px/20px ${FONT};color:${DEEP}">Àjọ</p>
<p style="margin:0;font:400 12px/18px ${FONT};color:${MUTED}">Save on your own, or in èsúsú circles with people you trust. You're getting this because of activity on your Àjọ account.</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Plain text for mail apps that do not show the designed version; the link sits on a line of its own. */
function plain(c: Content): string {
  const facts = c.facts?.length ? `${c.facts.map(([l, v]) => `${l}: ${v}`).join("\n")}\n\n` : "";
  const note = c.note ? `${c.note}\n\n` : "";
  return `${c.paragraphs.join("\n\n")}\n\n${facts}${c.button.label}:\n${c.button.href}\n\n${note}— Àjọ\n`;
}

function email(subject: string, c: Content): Email {
  return { subject, text: plain(c), html: render(c) };
}

export function verificationEmail(input: { to: string; name: string; link: string }): Email {
  const lines = [
    `Hi ${input.name},`,
    "Confirm your email address to finish creating your Àjọ account. This link expires in 24 hours and can be used once.",
  ];
  return email("Verify your email for Àjọ", {
    preheader: "One tap to confirm your email and finish creating your account.",
    heading: "Confirm your email",
    chips: ["Expires in 24 hours", "Works once"],
    paragraphs: lines,
    button: { label: "Verify email", href: input.link },
    note: "If you didn't create an account, you can ignore this email.",
  });
}

export function accountExistsEmail(input: { to: string; signInLink: string }): Email {
  const lines = [
    "Someone tried to create an Àjọ account with this email address, but you already have one.",
    "If this was you, sign in instead.",
  ];
  return email("Someone tried to create an Àjọ account with your email", {
    preheader: "You already have an account. If this was you, just sign in.",
    heading: "You already have an Àjọ account",
    paragraphs: lines,
    button: { label: "Sign in", href: input.signInLink },
    note: "If this wasn't you, you don't need to do anything; your account is safe.",
  });
}

export function passwordResetEmail(input: { to: string; name: string; link: string }): Email {
  const lines = [
    `Hi ${input.name},`,
    "Use this link to choose a new password for your Àjọ account. It expires in 1 hour and can be used once.",
  ];
  return email("Reset your Àjọ password", {
    preheader: "Choose a new password for your Àjọ account.",
    heading: "Choose a new password",
    chips: ["Expires in 1 hour", "Works once"],
    paragraphs: lines,
    button: { label: "Choose a new password", href: input.link },
    note: "If you didn't ask to reset your password, you can ignore this email. Your password has not been changed.",
  });
}

export function passwordChangedEmail(input: {
  to: string;
  name: string;
  signInLink: string;
}): Email {
  const lines = [
    `Hi ${input.name},`,
    "The password on your Àjọ account was just changed, and you were signed out everywhere.",
  ];
  return email("Your Àjọ password was changed", {
    preheader: "Your password was just changed and you were signed out everywhere.",
    heading: "Your password was changed",
    paragraphs: lines,
    button: { label: "Sign in", href: input.signInLink },
    note: "If this wasn't you, reset your password again straight away and contact us.",
  });
}

export function newDeviceEmail(input: {
  to: string;
  name: string;
  device: string;
  when: Date;
  resetLink: string;
}): Email {
  const lines = [
    `Hi ${input.name},`,
    "Your Àjọ account was just signed in to from a device we haven't seen before.",
    "If this was you, there's nothing to do.",
  ];
  return email("New sign-in to your Àjọ account", {
    preheader: `A new device signed in to your account: ${input.device}.`,
    heading: "New sign-in to your account",
    paragraphs: lines,
    facts: [
      ["Device", input.device],
      ["When", input.when.toUTCString()],
    ],
    button: { label: "Change my password", href: input.resetLink },
    note: "If it wasn't you, change your password now: that signs every other device out. You can also sign out of all devices from the Me screen in the app.",
  });
}
