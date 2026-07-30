// Timezone helpers for the availability planner. All slots are stored as UTC
// instants; these convert a wall-clock time in a chosen IANA zone to/from UTC
// using the Intl offset trick (no external library).

export const COMMON_TIMEZONES = [
  "UTC",
  "Europe/Istanbul",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function detectTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** ms to add to a UTC instant to get the wall-clock reading in `tz`. */
function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
  let hour = Number(m.hour);
  if (hour === 24) hour = 0;
  const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second);
  return asUTC - date.getTime();
}

/** Wall-clock time in `tz` → the matching UTC instant. */
export function zonedTimeToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(new Date(guess), tz);
  utc = guess - tzOffsetMs(new Date(utc), tz); // second pass settles DST edges
  return new Date(utc);
}

/** UTC of a specific hour boundary on a given calendar day in `tz`. */
export function hourBoundaryUtc(dayKey: string, hour: number, tz: string): Date {
  const [y, mo, d] = dayKey.split("-").map(Number);
  return zonedTimeToUtc(y, mo, d, hour, 0, tz);
}

export function formatTimeInZone(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
  });
}

/** YYYY-MM-DD of an instant as seen in `tz`. */
export function dayKeyInZone(iso: string | Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const m: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") m[p.type] = p.value;
  return `${m.year}-${m.month}-${m.day}`;
}

export function labelDay(dayKey: string): string {
  const [y, mo, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d, 12)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** A short, friendly zone label, e.g. "Europe/Istanbul (GMT+3)". */
export function tzLabel(tz: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    return `${tz.replace(/_/g, " ")}${name ? ` (${name})` : ""}`;
  } catch {
    return tz;
  }
}
