type Email = { subject: string; text: string; html: string };

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function layout(paragraphs: string[], button?: { label: string; href: string }): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  const action = button
    ? `<p><a href="${escapeHtml(button.href)}" style="background:#038641;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">${escapeHtml(button.label)}</a></p>`
    : "";
  return `<div style="font-family:sans-serif;max-width:480px">${body}${action}</div>`;
}

export function verificationEmail(input: { to: string; name: string; link: string }): Email {
  const lines = [
    `Hi ${input.name},`,
    "Confirm your email address to finish creating your Àjọ account. This link expires in 24 hours and can be used once.",
    "If you didn't create an account, you can ignore this email.",
  ];
  return {
    subject: "Verify your email for Àjọ",
    text: `${lines.join("\n\n")}\n\n${input.link}\n`,
    html: layout(lines, { label: "Verify email", href: input.link }),
  };
}

export function accountExistsEmail(input: { to: string; signInLink: string }): Email {
  const lines = [
    "Someone tried to create an Àjọ account with this email address, but you already have one.",
    "If this was you, sign in instead. If this wasn't you, you don't need to do anything; your account is safe.",
  ];
  return {
    subject: "Someone tried to create an Àjọ account with your email",
    text: `${lines.join("\n\n")}\n\n${input.signInLink}\n`,
    html: layout(lines, { label: "Sign in", href: input.signInLink }),
  };
}
