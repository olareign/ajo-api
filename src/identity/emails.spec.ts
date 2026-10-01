import {
  accountExistsEmail,
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
    expect(email.html).not.toContain("<img");
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
