import { describe, expect, test } from "bun:test";
import { imapConfigFromEnv } from "./config";

const base = {
  IMAP_HOST: "bridge.example",
  IMAP_PORT: 1143,
  IMAP_USER: "hello",
  IMAP_PASSWORD: "secret",
  IMAP_MAILBOXES: "INBOX,Spam",
  IMAP_TLS_CERT: undefined,
  IMAP_TLS_INSECURE: false,
};

describe("imapConfigFromEnv", () => {
  test("no host -> disabled", () => {
    expect(
      imapConfigFromEnv({ ...base, IMAP_HOST: undefined }),
    ).toBeUndefined();
  });

  test("missing credentials -> disabled (env validation rejects this earlier)", () => {
    expect(
      imapConfigFromEnv({ ...base, IMAP_USER: undefined }),
    ).toBeUndefined();
    expect(
      imapConfigFromEnv({ ...base, IMAP_PASSWORD: undefined }),
    ).toBeUndefined();
  });

  test("maps env to config and splits, trims and drops empty mailbox names", () => {
    expect(
      imapConfigFromEnv({
        ...base,
        IMAP_PORT: 993,
        IMAP_MAILBOXES: " INBOX , ,Spam,Archive/2026 ",
        IMAP_TLS_CERT: "PEM",
        IMAP_TLS_INSECURE: true,
      }),
    ).toEqual({
      host: "bridge.example",
      port: 993,
      user: "hello",
      password: "secret",
      mailboxes: ["INBOX", "Spam", "Archive/2026"],
      tlsCert: "PEM",
      tlsInsecure: true,
    });
  });
});
