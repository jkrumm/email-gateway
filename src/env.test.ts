import { describe, expect, test } from "bun:test";
import { envSchema, parseEnv } from "./env";
import { CERT_A } from "./test/certs";

const base = {
  SECRET_KEY: "0123456789",
  RECEIVER_EMAIL: "me@example.com",
  RESEND_API_KEY: "re_key",
  SY_SERENDIPITY_RECEIVER_EMAIL: "sy@example.com",
};

describe("IMAP env validation", () => {
  test("no host: IMAP is off and defaults apply", () => {
    const parsed = envSchema.parse(base);
    expect(parsed.IMAP_HOST).toBeUndefined();
    expect(parsed.IMAP_PORT).toBe(1143);
    expect(parsed.IMAP_MAILBOXES).toBe("INBOX,Spam");
    expect(parsed.IMAP_TLS_INSECURE).toBe(false);
  });

  test("host without user/password fails fast, naming the missing keys", () => {
    const result = envSchema.safeParse({ ...base, IMAP_HOST: "bridge" });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "IMAP_USER",
      "IMAP_PASSWORD",
    ]);
  });

  test("host with credentials parses; empty mailbox list is rejected", () => {
    const ok = {
      ...base,
      IMAP_HOST: "bridge",
      IMAP_USER: "u",
      IMAP_PASSWORD: "p",
      IMAP_TLS_INSECURE: "true",
    };
    expect(envSchema.parse(ok).IMAP_TLS_INSECURE).toBe(true);

    const empty = envSchema.safeParse({ ...ok, IMAP_MAILBOXES: " , " });
    expect(empty.success).toBe(false);
  });

  test("IMAP_TLS_CERT must be a valid PEM (escaped newlines accepted)", () => {
    const ok = {
      ...base,
      IMAP_HOST: "bridge",
      IMAP_USER: "u",
      IMAP_PASSWORD: "p",
    };

    expect(envSchema.safeParse({ ...ok, IMAP_TLS_CERT: CERT_A }).success).toBe(
      true,
    );
    expect(
      envSchema.safeParse({
        ...ok,
        IMAP_TLS_CERT: CERT_A.replace(/\n/g, "\\n"),
      }).success,
    ).toBe(true);

    const bad = envSchema.safeParse({ ...ok, IMAP_TLS_CERT: "not a cert" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "IMAP_TLS_CERT",
    ]);
  });

  test("IMAP_PORT must be an integer in 1..65535", () => {
    for (const port of ["0", "65536", "11.5", "abc"]) {
      expect(envSchema.safeParse({ ...base, IMAP_PORT: port }).success).toBe(
        false,
      );
    }
    expect(envSchema.parse({ ...base, IMAP_PORT: "993" }).IMAP_PORT).toBe(993);
  });
});

describe("MAIL_HOST validation", () => {
  test("unset is allowed, but an empty string is not", () => {
    expect(envSchema.safeParse(base).success).toBe(true);

    const empty = envSchema.safeParse({ ...base, MAIL_HOST: "" });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "MAIL_HOST",
    ]);
  });

  test("parseEnv fails a present-but-empty MAIL_HOST, yet an absent one is unset", () => {
    // The schema's min(1) alone is not enough: parseEnv strips "" to unset
    // before parsing, so this is the guard that actually fires on the raw env.
    expect(() => parseEnv({ ...base, MAIL_HOST: "" })).toThrow(
      "MAIL_HOST must not be empty",
    );
    expect(parseEnv(base).MAIL_HOST).toBeUndefined();
  });
});

describe("Gmail IMAP env validation", () => {
  test("unset user: Gmail is off and the mailbox default applies", () => {
    const parsed = envSchema.parse(base);
    expect(parsed.GMAIL_IMAP_USER).toBeUndefined();
    expect(parsed.GMAIL_IMAP_APP_PASSWORD).toBeUndefined();
    expect(parsed.GMAIL_IMAP_MAILBOXES).toBe("INBOX");
  });

  test("user without an app password (or vice versa) fails fast, naming the missing key", () => {
    const noPassword = envSchema.safeParse({
      ...base,
      GMAIL_IMAP_USER: "me@gmail.com",
    });
    expect(noPassword.success).toBe(false);
    expect(
      noPassword.error?.issues.map((issue) => issue.path.join(".")),
    ).toEqual(["GMAIL_IMAP_APP_PASSWORD"]);

    const noUser = envSchema.safeParse({
      ...base,
      GMAIL_IMAP_APP_PASSWORD: "p",
    });
    expect(noUser.success).toBe(false);
    expect(noUser.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "GMAIL_IMAP_USER",
    ]);
  });

  test("user with an app password parses; an empty mailbox list is rejected", () => {
    const ok = {
      ...base,
      GMAIL_IMAP_USER: "me@gmail.com",
      GMAIL_IMAP_APP_PASSWORD: "p",
    };
    expect(envSchema.safeParse(ok).success).toBe(true);

    const empty = envSchema.safeParse({
      ...ok,
      GMAIL_IMAP_MAILBOXES: " , ",
    });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "GMAIL_IMAP_MAILBOXES",
    ]);
  });
});
