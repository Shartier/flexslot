// Time intervals and shop-timezone conversion (DESIGN 3: UTC epoch ms stored, shop timezone kept separately).
// No code here reads the process timezone: every local value names its IANA zone explicitly.

export const MINUTE_MS = 60_000;

/** Half-open interval [startMs, endMs) in UTC epoch milliseconds. */
export interface Interval {
  startMs: number;
  endMs: number;
}

export function interval(startMs: number, endMs: number): Interval {
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs)) {
    throw new RangeError('interval bounds must be safe integers');
  }
  if (endMs <= startMs) {
    throw new RangeError(`interval end must be after start (${startMs} .. ${endMs})`);
  }
  return { startMs, endMs };
}

/** Start inclusive, end exclusive: touching intervals do not overlap. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

export function contains(outer: Interval, inner: Interval): boolean {
  return outer.startMs <= inner.startMs && inner.endMs <= outer.endMs;
}

export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    // Throws RangeError for an unknown zone.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function assertTimeZone(timeZone: string): void {
  formatterFor(timeZone);
}

/** Wall-clock fields of an instant in the given zone (seconds dropped). */
export function toLocal(ms: number, timeZone: string): LocalDateTime {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(ms)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year ?? NaN,
    month: fields.month ?? NaN,
    day: fields.day ?? NaN,
    hour: fields.hour ?? NaN,
    minute: fields.minute ?? NaN,
  };
}

function zoneOffsetMs(ms: number, timeZone: string): number {
  const floored = Math.floor(ms / MINUTE_MS) * MINUTE_MS;
  const l = toLocal(floored, timeZone);
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute) - floored;
}

/**
 * Wall-clock time in a zone -> UTC epoch ms. A wall time that does not exist (DST gap) is rejected
 * rather than silently shifted.
 */
export function fromLocal(local: LocalDateTime, timeZone: string): number {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  const secondOffset = zoneOffsetMs(utc, timeZone);
  if (naive - secondOffset !== utc) utc = naive - secondOffset;
  const check = toLocal(utc, timeZone);
  if (
    check.year !== local.year ||
    check.month !== local.month ||
    check.day !== local.day ||
    check.hour !== local.hour ||
    check.minute !== local.minute
  ) {
    throw new RangeError(`local time ${formatLocalFields(local)} does not exist in ${timeZone}`);
  }
  return utc;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export function parseLocal(date: string, time: string): LocalDateTime {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) throw new RangeError(`expected YYYY-MM-DD and HH:MM, got "${date}" "${time}"`);
  const local = { year: Number(d[1]), month: Number(d[2]), day: Number(d[3]), hour: Number(t[1]), minute: Number(t[2]) };
  const roundTrip = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (
    roundTrip.getUTCFullYear() !== local.year ||
    roundTrip.getUTCMonth() !== local.month - 1 ||
    roundTrip.getUTCDate() !== local.day ||
    local.hour > 23 ||
    local.minute > 59
  ) {
    throw new RangeError(`invalid local date/time "${date} ${time}"`);
  }
  return local;
}

/** "2026-11-10", "10:00", "Asia/Tokyo" -> UTC epoch ms. */
export function localToUtcMs(date: string, time: string, timeZone: string): number {
  return fromLocal(parseLocal(date, time), timeZone);
}

/** Interval given as a local date with start/end wall times on that date. */
export function localInterval(date: string, start: string, end: string, timeZone: string): Interval {
  return interval(localToUtcMs(date, start, timeZone), localToUtcMs(date, end, timeZone));
}

/** UTC epoch ms of `minuteOfDay` minutes after local midnight on the given local date (1440 = next midnight). */
export function localMinuteOfDayToUtcMs(
  local: Pick<LocalDateTime, 'year' | 'month' | 'day'>,
  minuteOfDay: number,
  timeZone: string,
): number {
  if (!Number.isInteger(minuteOfDay) || minuteOfDay < 0 || minuteOfDay > 1440) {
    throw new RangeError(`minute of day must be 0..1440, got ${minuteOfDay}`);
  }
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day + Math.floor(minuteOfDay / 1440)));
  const minute = minuteOfDay % 1440;
  return fromLocal(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: Math.floor(minute / 60),
      minute: minute % 60,
    },
    timeZone,
  );
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

function formatLocalFields(l: LocalDateTime): string {
  return `${pad(l.year, 4)}-${pad(l.month)}-${pad(l.day)} ${pad(l.hour)}:${pad(l.minute)}`;
}

/** "YYYY-MM-DD HH:MM" in the given zone, for display and test readability. */
export function formatLocal(ms: number, timeZone: string): string {
  return formatLocalFields(toLocal(ms, timeZone));
}
