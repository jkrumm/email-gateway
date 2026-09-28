import { describe, expect, test } from "bun:test";
import {
  SESSION_MAX_AGE_MS,
  isSessionValue,
  sessionSecret,
  sessionValue,
} from "./session";

const PASSWORD = "admin-password-long-enough";
const COOKIE_SECRET = "cookie-secret-long-enough";

describe("sessionSecret", () => {
  test("no valid password -> undefined", () => {
    expect(sessionSecret(undefined, COOKIE_SECRET)).toBeUndefined();
    expect(sessionSecret("short", COOKIE_SECRET)).toBeUndefined();
  });

  test("falls back to the password when COOKIE_SECRET is unset", () => {
    expect(sessionSecret(PASSWORD, undefined)).toBe(PASSWORD);
  });

  test("an empty COOKIE_SECRET is unset, not an empty signing key", () => {
    expect(sessionSecret(PASSWORD, "")).toBe(PASSWORD);
  });

  test("a too-short COOKIE_SECRET falls back to the password", () => {
    expect(sessionSecret(PASSWORD, "too-short")).toBe(PASSWORD);
  });

  test("a long enough COOKIE_SECRET overrides the password", () => {
    expect(sessionSecret(PASSWORD, COOKIE_SECRET)).toBe(COOKIE_SECRET);
  });
});

describe("session value expiry", () => {
  const now = 1_700_000_000_000;

  test("a freshly minted value is valid until its expiry", () => {
    const value = sessionValue(now);
    expect(isSessionValue(value, now)).toBe(true);
    expect(isSessionValue(value, now + SESSION_MAX_AGE_MS - 1)).toBe(true);
  });

  test("an expired value is rejected", () => {
    const value = sessionValue(now);
    expect(isSessionValue(value, now + SESSION_MAX_AGE_MS + 1)).toBe(false);
  });

  test("the bare constant and garbage are rejected", () => {
    expect(isSessionValue("authenticated", now)).toBe(false);
    expect(isSessionValue("authenticated:not-a-number", now)).toBe(false);
    expect(isSessionValue(undefined, now)).toBe(false);
  });
});
