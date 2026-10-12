import { describe, expect, test } from "bun:test";
import { validDate } from "./date";

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
