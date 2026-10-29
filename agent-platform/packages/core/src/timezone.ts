/** Application wall-clock timezone for day boundaries and display. */
export const APP_TIMEZONE = (process.env.TZ || "Europe/Amsterdam").trim() || "Europe/Amsterdam";

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

/** Offset of `timeZone` from UTC at `date`, in milliseconds (positive east of UTC). */
export function zoneOffsetMs(date: Date, timeZone: string = APP_TIMEZONE): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Start of the calendar day in the app timezone, as a UTC Instant. */
export function startOfAppDay(now: Date, timeZone: string = APP_TIMEZONE): Date {
  const parts = zonedParts(now, timeZone);
  const utcMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0);
  // First guess: treat local Y-M-D as UTC, then subtract the zone offset at that instant.
  let start = new Date(utcMidnight - zoneOffsetMs(new Date(utcMidnight), timeZone));
  // Correct once more around DST transitions.
  start = new Date(utcMidnight - zoneOffsetMs(start, timeZone));
  return start;
}

/** @deprecated Alias for startOfAppDay — day budgets use Europe/Amsterdam, not UTC. */
export function startOfUtcDay(now: Date): Date {
  return startOfAppDay(now);
}

export function formatInAppZone(
  value: string | Date,
  options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  },
  timeZone: string = APP_TIMEZONE,
): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", { timeZone, ...options }).format(date);
}

export function appDateKey(value: string | Date, timeZone: string = APP_TIMEZONE): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
