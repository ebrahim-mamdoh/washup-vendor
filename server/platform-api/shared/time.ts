import "server-only";

/**
 * Wall-clock helpers in a branch timezone (wash hours are local time, not the server TZ).
 * Byte-identical in the Super Admin and the partner portal (`npm run check:shared`, GAP-054).
 */

/** Default zone: the mock store and branches without a country. */
export const CAIRO = "Africa/Cairo";

/** Calendar / clock parts in a branch timezone (wash hours are wall-clock, not the server TZ). */
export function zoneDateParts(d: Date, timeZone = CAIRO): { y: number; m: number; day: number; weekday: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(p.year),
    m: Number(p.month),
    day: Number(p.day),
    weekday: weekdayMap[p.weekday] ?? 0,
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

/** Instant whose wall-clock in `timeZone` equals the given Y-M-D H:M. */
export function zoneLocalToUtc(timeZone: string, y: number, month: number, day: number, hour = 0, minute = 0): Date {
  const utc = Date.UTC(y, month - 1, day, hour, minute, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wallAsUtc = (instant: Date) => {
    const p = Object.fromEntries(dtf.formatToParts(instant).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  };
  return new Date(utc - (wallAsUtc(new Date(utc)) - utc));
}
