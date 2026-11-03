import { describe, expect, it } from 'vitest';
import { ManualClock, systemClock } from '../src/clock.ts';
import { assertTimeZone, formatLocal, interval, localInterval, localToUtcMs, overlaps, parseLocal } from '../src/time.ts';

describe('Clock', () => {
  it('ManualClock stays fixed until set or advanced', () => {
    const clock = new ManualClock(Date.UTC(2026, 10, 3, 3, 0));
    expect(clock.now()).toBe(Date.UTC(2026, 10, 3, 3, 0));
    expect(clock.now()).toBe(Date.UTC(2026, 10, 3, 3, 0));
    clock.advance(15 * 60_000);
    expect(clock.now()).toBe(Date.UTC(2026, 10, 3, 3, 15));
    clock.set(Date.UTC(2026, 10, 7, 5, 0));
    expect(clock.now()).toBe(Date.UTC(2026, 10, 7, 5, 0));
  });

  it('ManualClock rejects negative or fractional steps', () => {
    const clock = new ManualClock(0);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(0.5)).toThrow(RangeError);
    expect(() => new ManualClock(Number.NaN)).toThrow(RangeError);
  });

  it('systemClock returns the current epoch ms', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('intervals', () => {
  it('are half-open: touching intervals do not overlap', () => {
    expect(overlaps(interval(10, 11), interval(11, 12))).toBe(false);
    expect(overlaps(interval(11, 12), interval(10, 11))).toBe(false);
    expect(overlaps(interval(10, 11), interval(10, 11))).toBe(true);
    expect(overlaps(interval(10, 12), interval(11, 13))).toBe(true);
    expect(overlaps(interval(10, 13), interval(11, 12))).toBe(true);
  });

  it('must end after they start', () => {
    expect(() => interval(10, 10)).toThrow(RangeError);
    expect(() => interval(11, 10)).toThrow(RangeError);
  });
});

describe('shop time zone conversion', () => {
  it('converts Asia/Tokyo wall time to UTC and back', () => {
    expect(localToUtcMs('2026-11-10', '10:00', 'Asia/Tokyo')).toBe(Date.UTC(2026, 10, 10, 1, 0));
    // Local date differs from the UTC date before 09:00 in Tokyo.
    expect(localToUtcMs('2026-11-11', '08:30', 'Asia/Tokyo')).toBe(Date.UTC(2026, 10, 10, 23, 30));
    expect(formatLocal(Date.UTC(2026, 10, 10, 23, 30), 'Asia/Tokyo')).toBe('2026-11-11 08:30');
    expect(localInterval('2026-11-07', '14:00', '15:00', 'Asia/Tokyo')).toEqual({
      startMs: Date.UTC(2026, 10, 7, 5, 0),
      endMs: Date.UTC(2026, 10, 7, 6, 0),
    });
  });

  it('uses the offset in force on each date across a DST change', () => {
    // America/Los_Angeles leaves daylight time on 2026-11-01.
    expect(localToUtcMs('2026-10-31', '10:00', 'America/Los_Angeles')).toBe(Date.UTC(2026, 9, 31, 17, 0));
    expect(localToUtcMs('2026-11-02', '10:00', 'America/Los_Angeles')).toBe(Date.UTC(2026, 10, 2, 18, 0));
  });

  it('rejects wall times that do not exist', () => {
    // 2026-03-08 02:30 is skipped in Los Angeles (clocks jump from 02:00 to 03:00).
    expect(() => localToUtcMs('2026-03-08', '02:30', 'America/Los_Angeles')).toThrow(RangeError);
  });

  it('rejects malformed dates, times and zones', () => {
    expect(() => parseLocal('2026-02-30', '10:00')).toThrow(RangeError);
    expect(() => parseLocal('2026-11-10', '24:00')).toThrow(RangeError);
    expect(() => parseLocal('2026-11-10', '9:00')).toThrow(RangeError);
    expect(() => assertTimeZone('Mars/Olympus_Mons')).toThrow(RangeError);
  });
});
