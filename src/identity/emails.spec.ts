import {
  accountExistsEmail,
  newDeviceEmail,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from "./emails.js";

describe("identity emails", () => {
  it("builds a verification email with a link to the web app", () => {
    const email = verificationEmail({
      to: "ada@example.com",
      name: "Ada",
      link: "https://app.ajo.example/verify-email?token=abc",
    });
    expect(email.subject).toBe("Verify your email for Àjọ");
    expect(email.text).toContain("https://app.ajo.example/verify-email?token=abc");
    expect(email.html).toContain('href="https://app.ajo.example/verify-email?token=abc"');
    expect(email.text).toMatch(/expires in 24 hours/);
  });

  it("escapes user-supplied text in HTML so a name cannot inject markup", () => {
    const email = verificationEmail({
      to: "x@y.z",
      name: '<img src=x onerror="alert(1)">',
      link: "https://app.ajo.example/verify-email?token=abc",
    });
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain('onerror="');
    expect(email.html).toContain("&lt;img");
  });

  it("tells an existing user that someone tried to register with their email", () => {
    const email = accountExistsEmail({
      to: "ada@example.com",
      signInLink: "https://app.ajo.example/sign-in",
    });
    expect(email.subject).toBe("Someone tried to create an Àjọ account with your email");
    expect(email.text).toContain("https://app.ajo.example/sign-in");
    expect(email.text).toMatch(/If this wasn't you/);
  });

  it("builds a password reset email whose link expires and works once", () => {
    const email = passwordResetEmail({
      to: "ada@example.com",
      name: "Ada",
      link: "https://app.ajo.example/reset-password?token=abc",
    });
    expect(email.subject).toBe("Reset your Àjọ password");
    expect(email.text).toContain("https://app.ajo.example/reset-password?token=abc");
    expect(email.text).toMatch(/expires in 1 hour/);
    expect(email.text).toMatch(/If you didn't ask/);
  });

  it("tells the owner when their password was changed, and what to do if it wasn't them", () => {
    const email = passwordChangedEmail({
      to: "ada@example.com",
      name: "Ada",
      signInLink: "https://app.ajo.example/sign-in",
    });
    expect(email.subject).toBe("Your Àjọ password was changed");
    expect(email.text).toMatch(/wasn't you/);
  });

  it("styles buttons in the Àjọ green", () => {
    const email = verificationEmail({ to: "a@b.c", name: "A", link: "https://app.ajo.example/x" });
    expect(email.html).toContain("#057a3f");
    expect(email.html).not.toContain("#222f78");
  });
});

const ORIGIN = "https://app.ajo.example";
const every = () => [
  verificationEmail({ to: "a@b.c", name: "Ada", link: `${ORIGIN}/verify-email?token=abc` }),
  accountExistsEmail({ to: "a@b.c", signInLink: `${ORIGIN}/sign-in` }),
  passwordResetEmail({ to: "a@b.c", name: "Ada", link: `${ORIGIN}/reset-password?token=abc` }),
  passwordChangedEmail({ to: "a@b.c", name: "Ada", signInLink: `${ORIGIN}/sign-in` }),
  newDeviceEmail({
    to: "a@b.c",
    name: "Ada",
    device: "Chrome on Android",
    when: new Date("2026-10-04T09:30:00Z"),
    resetLink: `${ORIGIN}/forgot-password`,
  }),
];

describe("the look of every email", () => {
  it.each(every().map((email) => [email.subject, email] as const))(
    "%s carries the logo, from the web app's own address, with a text alternative",
    (_subject, email) => {
      expect(email.html).toContain(`src="${ORIGIN}/email/logo.png"`);
      expect(email.html).toContain('alt="Àjọ"');
      expect(email.html).toMatch(/<img [^>]*width="\d+"/);
    },
  );

  it.each(every().map((email) => [email.subject, email] as const))(
    "%s is a complete, table-based document that needs nothing from outside to look right",
    (_subject, email) => {
      expect(email.html.startsWith("<!doctype html>")).toBe(true);
      expect(email.html).toContain('<html lang="en"');
      expect(email.html).toContain('role="presentation"');
      expect(email.html).toContain('<meta name="color-scheme" content="light only">');
      // No web fonts, stylesheets or scripts: many mail apps block them.
      expect(email.html).not.toMatch(/<link|<script|@import|@font-face/i);
    },
  );

  it.each(every().map((email) => [email.subject, email] as const))(
    "%s has a preheader, a heading, a button, and the link spelled out in case the button fails",
    (_subject, email) => {
      expect(email.html).toMatch(/display:none[^>]*>[^<]{20,}/);
      expect(email.html).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
      const href = /href="([^"]+)"[^>]*>\s*[^<]+<\/a>/.exec(email.html)![1]!;
      expect(email.html.split(href.replaceAll("&", "&amp;")).length).toBeGreaterThan(2);
    },
  );

  it("shows the logo from wherever the link points, so a preview or staging site sends its own", () => {
    const email = verificationEmail({
      to: "a@b.c",
      name: "Ada",
      link: "https://staging.ajo.example/verify-email?token=abc",
    });
    expect(email.html).toContain('src="https://staging.ajo.example/email/logo.png"');
  });

  it("falls back to the name in words when the link is not a web address", () => {
    const email = verificationEmail({ to: "a@b.c", name: "Ada", link: "not a url" });
    expect(email.html).not.toContain("<img");
    expect(email.html).toContain("Àjọ");
  });

  it("uses the brand's colours and keeps gold for the heads-up box", () => {
    const { html } = verificationEmail({ to: "a@b.c", name: "A", link: `${ORIGIN}/x` });
    expect(html).toContain("#057a3f");
    expect(html).toContain("#035e30");
    expect(html).toContain("#fbefd2");
  });

  it("states how long a link lasts, as a chip a person can spot", () => {
    expect(verificationEmail({ to: "a@b.c", name: "A", link: `${ORIGIN}/x` }).html).toContain(
      "Expires in 24 hours",
    );
    expect(passwordResetEmail({ to: "a@b.c", name: "A", link: `${ORIGIN}/x` }).html).toContain(
      "Expires in 1 hour",
    );
  });

  it("escapes everything a person controls, in every place it appears", () => {
    const evil = '"><script>alert(1)</script>';
    const email = newDeviceEmail({
      to: "a@b.c",
      name: evil,
      device: evil,
      when: new Date("2026-10-04T09:30:00Z"),
      resetLink: `${ORIGIN}/forgot-password?x=${encodeURIComponent(evil)}`,
    });
    expect(email.html).not.toContain("<script");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("lists the device and the time in a small table for the new-sign-in alert", () => {
    const email = newDeviceEmail({
      to: "a@b.c",
      name: "Ada",
      device: "Chrome on Android",
      when: new Date("2026-10-04T09:30:00Z"),
      resetLink: `${ORIGIN}/forgot-password`,
    });
    expect(email.html).toContain("Chrome on Android");
    expect(email.html).toContain("Sun, 04 Oct 2026 09:30:00 GMT");
    expect(email.text).toContain("Chrome on Android");
  });

  it("keeps the plain-text version free of markup, with the link on its own line", () => {
    for (const email of every()) {
      expect(email.text).not.toMatch(/<[a-z/][^>]*>/i);
      expect(email.text).toMatch(/^https:\/\/app\.ajo\.example\/\S+$/m);
      expect(email.text).toMatch(/Àjọ/);
    }
  });
});
