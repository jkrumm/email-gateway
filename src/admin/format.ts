const TIME_ZONE = "Europe/Berlin";

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const timeFormatter = new Intl.DateTimeFormat("de-DE", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
});

function dayKey(date: Date): string {
  return dayKeyFormatter.format(date);
}

/** List-cell date: "Heute, 10:32" / "Gestern, 10:32" / "15.09.2026, 10:32". */
export function formatListDateTime(
  iso: string,
  now: Date = new Date(),
): string {
  const date = new Date(iso);
  const time = timeFormatter.format(date);

  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const key = dayKey(date);

  if (key === today) return `Heute, ${time}`;
  if (key === yesterday) return `Gestern, ${time}`;
  return `${dateFormatter.format(date)}, ${time}`;
}

// U+202F narrow no-break space keeps "85 %" reading as one mono token
// instead of two words with a full-width gap.
export function formatPercent(value: number): string {
  return `${Math.round(value * 100)} %`;
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
