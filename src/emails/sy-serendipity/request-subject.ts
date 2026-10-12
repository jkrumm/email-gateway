interface RequestSubjectInput {
  firstName: string | null;
  lastName: string | null;
  email: string;
  numberOfPeople: string | null;
  arrivalDate: string | null;
  departureDate: string | null;
}

export interface CalendarDate {
  day: number;
  month: number;
  year: number;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// The form sends Date.toDateString() ("Sat Jun 12 2027"); ISO ("2027-06-12",
// optionally with a time part) is accepted too. Parsed by hand so the host's
// timezone can never shift the calendar day.
export function parseCalendarDate(value: string | null): CalendarDate | null {
  if (!value) return null;
  const trimmed = value.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(trimmed);
  const dateString = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{4})$/.exec(
    trimmed,
  );

  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]) - 1;
    day = Number(iso[3]);
  } else if (dateString) {
    month = MONTHS.findIndex(
      (name) => name.toLowerCase() === dateString[1]!.toLowerCase(),
    );
    day = Number(dateString[2]);
    year = Number(dateString[3]);
  } else {
    return null;
  }

  if (month < 0 || month > 11) return null;
  const check = new Date(Date.UTC(year, month, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { day, month, year };
}

function formatDateRange(
  arrivalDate: string | null,
  departureDate: string | null,
): string | null {
  const arrival = parseCalendarDate(arrivalDate);
  const departure = parseCalendarDate(departureDate);
  if (!arrival || !departure) return null;

  const arrivalMonth = MONTHS[arrival.month];
  const departureMonth = MONTHS[departure.month];
  if (arrival.year !== departure.year) {
    return `${arrival.day} ${arrivalMonth} ${arrival.year} – ${departure.day} ${departureMonth} ${departure.year}`;
  }
  if (arrival.month !== departure.month) {
    return `${arrival.day} ${arrivalMonth} – ${departure.day} ${departureMonth} ${departure.year}`;
  }
  if (arrival.day === departure.day) {
    return `${arrival.day} ${arrivalMonth} ${arrival.year}`;
  }
  return `${arrival.day}–${departure.day} ${arrivalMonth} ${arrival.year}`;
}

function formatGuests(numberOfPeople: string | null): string | null {
  const trimmed = numberOfPeople?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed) === 1 ? "1 guest" : `${Number(trimmed)} guests`;
}

// "Charter request: Jane Doe · 6 guests · 12–19 Jun 2027" — name, guests and
// dates each drop out when missing or unusable. The caller prepends the spam
// gate's subject prefix.
export function buildRequestSubject(input: RequestSubjectInput): string {
  const name = [input.firstName, input.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  const parts = [
    name.length > 0 ? name : input.email,
    formatGuests(input.numberOfPeople),
    formatDateRange(input.arrivalDate, input.departureDate),
  ].filter((part): part is string => part !== null);

  return `Charter request: ${parts.join(" · ")}`;
}
