// A Date, or null when the value is missing or unparseable.
export function validDate(
  value: Date | string | null | undefined,
): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
