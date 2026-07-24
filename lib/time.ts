/**
 * "HH:MM" time helpers. Everything in the scheduler happens on one Saturday, so
 * a minutes-since-midnight integer is enough and keeps the optimizer pure.
 */

export function toMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`Not a HH:MM time: ${JSON.stringify(hhmm)}`);
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) throw new Error(`Out of range time: ${hhmm}`);
  return hours * 60 + minutes;
}

export function toHHMM(minutes: number): string {
  const clamped = Math.max(0, Math.round(minutes));
  const h = Math.floor(clamped / 60) % 24;
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "14:30" -> "2:30pm". Used wherever a human reads a time. */
export function to12Hour(hhmm: string): string {
  const total = toMinutes(hhmm);
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const suffix = h24 >= 12 ? "pm" : "am";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

/** "10:00"–"15:00" -> "10-3". The compact form the scheduler already thinks in. */
export function windowLabel(start: string, end: string): string {
  const short = (hhmm: string) => {
    const total = toMinutes(hhmm);
    const h24 = Math.floor(total / 60);
    const m = total % 60;
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return m === 0 ? String(h12) : `${h12}:${String(m).padStart(2, "0")}`;
  };
  return `${short(start)}-${short(end)}`;
}

export function isValidTime(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,2}:\d{2}$/.test(value.trim());
}

/** Parses a date cell like "7/25/2026 10:00" or "2026-07-25" into an ISO date. */
export function parseExportDate(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(trimmed);
  if (us) {
    const month = us[1].padStart(2, "0");
    const day = us[2].padStart(2, "0");
    const year = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${year}-${month}-${day}`;
  }

  return null;
}

/** "2026-07-25" -> "Saturday, July 25". */
export function formatDateLong(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  // Construct at noon UTC so the local-timezone offset can never roll the date.
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}
