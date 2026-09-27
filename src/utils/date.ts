// A Date, or null when the value is missing or unparseable.
export function validDate(
  value: Date | string | null | undefined,
): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Resend timestamps look like "2026-09-15 07:15:57.115000+00" — not ISO, so
// callers that compare/store dates as ISO strings (sync's created_at, the
// providers' Envelope.date) must normalize through this first.
export function toIsoTimestamp(value: string): string {
  // Only a value with a time component can end in a bare "+NN"/"-NN" offset
  // — a date-only value's trailing "-DD" (day of month) must never be
  // mistaken for one, or it gets rewritten into garbage.
  const hasTime = /\d{2}:\d{2}:\d{2}/.test(value);
  let normalized = value;
  if (hasTime) {
    normalized = normalized.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    // Resend's timestamps are always UTC; a value with no timezone
    // designator at all would otherwise parse as local time (per the Date
    // constructor's own spec), silently shifting the instant on a non-UTC
    // host. A date-only value needs no such fix: "YYYY-MM-DD" already parses
    // as UTC midnight.
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(normalized)) normalized += "Z";
  }
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
