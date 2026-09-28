import { describe, expect, test } from "bun:test";
import { hostAllowed } from "./host-gate";

describe("hostAllowed", () => {
  test("no MAIL_HOST -> every host is allowed", () => {
    expect(hostAllowed("public.test", undefined)).toBe(true);
    expect(hostAllowed(undefined, undefined)).toBe(true);
  });

  test("matches ignoring case and the request port", () => {
    expect(hostAllowed("Mail.Test:3010", "mail.test")).toBe(true);
    expect(hostAllowed("mail.test", "MAIL.TEST")).toBe(true);
    expect(hostAllowed("[::1]:3010", "[::1]")).toBe(true);
  });

  test("a mismatching or missing Host is denied once MAIL_HOST is set", () => {
    expect(hostAllowed("public.test", "mail.test")).toBe(false);
    expect(hostAllowed(undefined, "mail.test")).toBe(false);
  });
});
