// Small timezone helpers built on Intl (no extra dependency).
// A "civil date" is a calendar day {y, m, d} with no time or zone attached.

export interface CivilDate {
  y: number;
  m: number; // 1-12
  d: number;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isValidTz(tz: string | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of `instant` in `tz`. */
function parts(instant: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, number> = {};
  for (const { type, value } of f.formatToParts(instant)) if (type !== 'literal') p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, min: p.minute, s: p.second };
}

/** Offset of `tz` from UTC at `instant`, in ms (positive east of UTC). */
function offsetMs(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Calendar date of `instant` as seen in `tz`. */
export function civilDateIn(instant: Date, tz: string): CivilDate {
  const p = parts(instant, tz);
  return { y: p.y, m: p.m, d: p.d };
}

/** The UTC instant of local midnight at the start of civil date `c` in `tz` (DST-safe). */
export function startOfCivilDay(c: CivilDate, tz: string): Date {
  const guess = Date.UTC(c.y, c.m - 1, c.d);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz); // second pass handles DST boundaries
  return new Date(t);
}

/** A specific local wall time on civil date `c` in `tz`, as a UTC instant. */
export function localTimeToUtc(c: CivilDate, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(c.y, c.m - 1, c.d, hour, minute);
  let t = guess - offsetMs(new Date(guess), tz);
  t = guess - offsetMs(new Date(t), tz);
  return new Date(t);
}

export function addDays(c: CivilDate, n: number): CivilDate {
  const t = new Date(Date.UTC(c.y, c.m - 1, c.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function weekday(c: CivilDate): number {
  return new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay();
}

export function compareCivil(a: CivilDate, b: CivilDate): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

export function diffDays(a: CivilDate, b: CivilDate): number {
  return Math.round((Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d)) / 86_400_000);
}

export function isoDate(c: CivilDate): string {
  return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

export function parseIsoDate(s: string): CivilDate {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/** "Mon 9 Nov 2026" */
export function prettyDate(c: CivilDate): string {
  return `${WEEKDAYS[weekday(c)].slice(0, 3)} ${c.d} ${MONTHS[c.m - 1]} ${c.y}`;
}

/** "Mon 9 Nov 2026, 10:02" in tz */
export function prettyInstant(instant: Date, tz: string): string {
  const p = parts(instant, tz);
  return `${prettyDate({ y: p.y, m: p.m, d: p.d })}, ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

export function weekdayName(i: number): string {
  return WEEKDAYS[i];
}

export const WEEKDAY_NAMES = WEEKDAYS.map((w) => w.toLowerCase());
