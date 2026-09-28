import { describe, expect, test } from "bun:test";
import { formatListDateTime, formatLatency, formatPercent } from "./format";

// Fixed "now" for deterministic Heute/Gestern assertions.
const NOW = new Date("2026-09-15T10:32:00.000Z");

describe("formatListDateTime", () => {
  test("same Berlin day as now -> Heute, HH:MM", () => {
    expect(formatListDateTime("2026-09-15T08:32:00.000Z", NOW)).toBe(
      "Heute, 10:32",
    );
  });

  test("previous Berlin day -> Gestern, HH:MM", () => {
    expect(formatListDateTime("2026-09-14T08:32:00.000Z", NOW)).toBe(
      "Gestern, 10:32",
    );
  });

  test("older date -> DD.MM.YYYY, HH:MM", () => {
    expect(formatListDateTime("2026-01-01T08:32:00.000Z", NOW)).toBe(
      "01.01.2026, 09:32",
    );
  });
});

describe("formatPercent", () => {
  test("rounds and appends a narrow no-break space before %", () => {
    expect(formatPercent(0.874)).toBe("87 %");
  });
});

describe("formatLatency", () => {
  test("renders milliseconds under a second", () => {
    expect(formatLatency(420)).toBe("420 ms");
  });

  test("renders seconds at and above a second", () => {
    expect(formatLatency(1500)).toBe("1.5 s");
  });

  test("renders a dash for null", () => {
    expect(formatLatency(null)).toBe("—");
  });
});
