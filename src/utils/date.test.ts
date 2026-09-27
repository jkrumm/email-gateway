import { describe, expect, test } from "bun:test";
import { toIsoTimestamp, validDate } from "./date";

describe("validDate", () => {
  test("null/undefined/unparseable are all null", () => {
    expect(validDate(null)).toBeNull();
    expect(validDate(undefined)).toBeNull();
    expect(validDate("not a date")).toBeNull();
  });

  test("a valid Date or date string round-trips", () => {
    expect(validDate("2026-09-15T07:00:00.000Z")).toEqual(
      new Date("2026-09-15T07:00:00.000Z"),
    );
  });
});

describe("toIsoTimestamp", () => {
  test("normalizes Resend's Postgres-style timestamps to ISO UTC", () => {
    expect(toIsoTimestamp("2026-09-15 07:15:57.115000+00")).toBe(
      "2026-09-15T07:15:57.115Z",
    );
  });

  test("an already-ISO value round-trips", () => {
    expect(toIsoTimestamp("2026-09-15T07:15:57.115Z")).toBe(
      "2026-09-15T07:15:57.115Z",
    );
  });

  test("a value with no timezone designator is treated as UTC, not local time", () => {
    // No offset and no "Z" — the Date constructor would otherwise read this
    // as local time, silently shifting the instant on a non-UTC host.
    expect(toIsoTimestamp("2026-09-15 07:15:57.115000")).toBe(
      "2026-09-15T07:15:57.115Z",
    );
  });

  test("an unparseable value is returned unchanged, not a fabricated date", () => {
    expect(toIsoTimestamp("not a timestamp")).toBe("not a timestamp");
  });

  test("a date-only value (no time component) is a full ISO timestamp at UTC midnight, not passed through unchanged", () => {
    // A naive trailing-offset rewrite would mistake "-02" (day of month) for
    // a timezone offset here and corrupt the string.
    expect(toIsoTimestamp("2026-01-02")).toBe("2026-01-02T00:00:00.000Z");
  });
});
