import { describe, expect, it } from 'vitest';
import {
  evaluateSwap,
  findSwapCandidates,
  withinBusinessHours,
  type ACandidate,
  type BookingSlot,
  type ShopRules,
  type SlotHold,
  type SwapEvaluation,
  type SwapSearchInput,
} from '../src/domain/candidates.ts';
import { SAMPLE_NOW_MS } from '../src/sample.ts';
import { formatLocal, localInterval, localToUtcMs, type Interval } from '../src/time.ts';

const TZ = 'Asia/Tokyo';
const L = (date: string, start: string, end: string) => localInterval(date, start, end, TZ);
const shop: ShopRules = { timeZone: TZ, businessOpenMinute: 10 * 60, businessCloseMinute: 18 * 60 };
const services = [
  { id: 'cut', durationMin: 60 },
  { id: 'cut-color', durationMin: 120 },
];
const aBooking: BookingSlot = { id: 'A', stylistId: 'mika', serviceId: 'cut', status: 'CONFIRMED', ...L('2026-11-07', '14:00', '15:00') };

function input(over: Partial<SwapSearchInput> = {}): SwapSearchInput {
  return {
    nowMs: SAMPLE_NOW_MS,
    shop,
    services,
    bRequest: { serviceId: 'cut', windows: [L('2026-11-07', '14:00', '15:00')] },
    bookings: [aBooking],
    holds: [],
    ...over,
  };
}

function candidate(windows: Interval[] | null = [L('2026-11-10', '10:00', '12:00')], over: Partial<ACandidate> = {}): ACandidate {
  return { booking: aBooking, paymentVerified: true, acceptableWindows: windows, ...over };
}

const local = (i: Interval, tz = TZ) => `${formatLocal(i.startMs, tz)}-${formatLocal(i.endMs, tz).slice(11)}`;

function feasible(e: SwapEvaluation) {
  if (!e.feasible) throw new Error(`expected feasible, got ${e.reasons.join(', ')}`);
  return e;
}

function infeasible(e: SwapEvaluation) {
  if (e.feasible) throw new Error(`expected infeasible, got destination ${local(e.destination)}`);
  return e;
}

function hold(over: Partial<SlotHold> & Interval): SlotHold {
  return { id: 'H', caseId: 'other-case', stylistId: 'mika', status: 'ACTIVE', expiresAtMs: SAMPLE_NOW_MS + 900_000, ...over };
}

describe('SPEC 4 sample', () => {
  it('moves A to 2026-11-10 10:00-11:00 and gives B the original 14:00-15:00', () => {
    const e = feasible(evaluateSwap(input(), candidate()));
    expect(local(e.destination)).toBe('2026-11-10 10:00-11:00');
    expect(local(e.bSlot)).toBe('2026-11-07 14:00-15:00');
    expect(e.stylistId).toBe('mika');
    // Stored as UTC: 10:00 in Tokyo is 01:00Z.
    expect(e.destination).toEqual({ startMs: Date.UTC(2026, 10, 10, 1, 0), endMs: Date.UTC(2026, 10, 10, 2, 0) });
    expect(e.destinations.map((d) => local(d))).toEqual([
      '2026-11-10 10:00-11:00',
      '2026-11-10 10:15-11:15',
      '2026-11-10 10:30-11:30',
      '2026-11-10 10:45-11:45',
      '2026-11-10 11:00-12:00',
    ]);
  });
});

describe('AC02 / C10 boundaries', () => {
  it('rejects B with the 120-minute service when only 14:00-15:00 works for B', () => {
    const e = infeasible(evaluateSwap(input({ bRequest: { serviceId: 'cut-color', windows: [L('2026-11-07', '14:00', '15:00')] } }), candidate()));
    expect(e.reasons).toContain('B_SERVICE_LONGER_THAN_REQUEST_WINDOW');
    expect(e.reasons).toContain('B_SERVICE_LONGER_THAN_ORIGIN_SLOT');
  });

  it('A "finish by 10:30" cannot hold a 60-minute service; "finish by 11:00" can', () => {
    const by1030 = infeasible(evaluateSwap(input(), candidate([L('2026-11-10', '10:00', '10:30')])));
    expect(by1030.reasons).toEqual(['A_SERVICE_LONGER_THAN_WINDOW']);

    const by1100 = feasible(evaluateSwap(input(), candidate([L('2026-11-10', '10:00', '11:00')])));
    expect(by1100.destinations.map((d) => local(d))).toEqual(['2026-11-10 10:00-11:00']);
  });

  it('an adjacent booking starting at 11:00 does not conflict with 10:00-11:00', () => {
    const next: BookingSlot = { ...aBooking, id: 'X', ...L('2026-11-10', '11:00', '12:00') };
    const e = feasible(evaluateSwap(input({ bookings: [aBooking, next] }), candidate([L('2026-11-10', '10:00', '11:00')])));
    expect(local(e.destination)).toBe('2026-11-10 10:00-11:00');

    // Within 10:00-12:00 only 10:00 remains: every later start overlaps the 11:00 booking.
    const wide = feasible(evaluateSwap(input({ bookings: [aBooking, next] }), candidate()));
    expect(wide.destinations.map((d) => local(d))).toEqual(['2026-11-10 10:00-11:00']);
  });

  it('a booking starting at 10:30 conflicts, and leaves no 60-minute gap in 10:00-12:00', () => {
    const overlapping: BookingSlot = { ...aBooking, id: 'X', ...L('2026-11-10', '10:30', '11:30') };
    const e = infeasible(evaluateSwap(input({ bookings: [aBooking, overlapping] }), candidate()));
    expect(e.reasons).toEqual(['DESTINATION_CONFLICT']);
    expect(e.rejectedDestinations[0]).toMatchObject({ reasons: ['DESTINATION_CONFLICT'], conflictsWith: ['X'] });
    expect(local(e.rejectedDestinations[0]!.slot)).toBe('2026-11-10 10:00-11:00');
  });

  it('only the same stylist blocks: another stylist at 10:00 does not', () => {
    const otherStylist: BookingSlot = { ...aBooking, id: 'Y', stylistId: 'other', ...L('2026-11-10', '10:00', '11:00') };
    const e = feasible(evaluateSwap(input({ bookings: [aBooking, otherStylist] }), candidate()));
    expect(local(e.destination)).toBe('2026-11-10 10:00-11:00');
  });

  it('cancelled bookings do not block', () => {
    const cancelled: BookingSlot = { ...aBooking, id: 'Z', status: 'CANCELLED', ...L('2026-11-10', '10:00', '11:00') };
    expect(evaluateSwap(input({ bookings: [aBooking, cancelled] }), candidate()).feasible).toBe(true);
  });

  it('B can take part of a longer original slot when B is shorter', () => {
    const longA: BookingSlot = { ...aBooking, serviceId: 'cut-color', ...L('2026-11-07', '14:00', '16:00') };
    const e = feasible(
      evaluateSwap(
        input({ bookings: [longA], bRequest: { serviceId: 'cut', windows: [L('2026-11-07', '15:00', '16:00')] } }),
        candidate([L('2026-11-10', '10:00', '12:00')], { booking: longA }),
      ),
    );
    expect(local(e.bSlot)).toBe('2026-11-07 15:00-16:00');
    expect(local(e.destination)).toBe('2026-11-10 10:00-12:00');
  });

  it('A cannot move into its own original slot (B takes it)', () => {
    const e = infeasible(evaluateSwap(input(), candidate([L('2026-11-07', '13:30', '15:30')])));
    expect(e.reasons).toEqual(['DESTINATION_OVERLAPS_ORIGIN']);
  });
});

describe('slot holds', () => {
  const window1011 = [L('2026-11-10', '10:00', '11:00')];
  const at1011 = L('2026-11-10', '10:00', '11:00');

  it('an unexpired ACTIVE hold of another case blocks', () => {
    const e = infeasible(evaluateSwap(input({ holds: [hold(at1011)] }), candidate(window1011)));
    expect(e.reasons).toEqual(['DESTINATION_CONFLICT']);
    expect(e.rejectedDestinations[0]!.conflictsWith).toEqual(['H']);
  });

  it('an ACTIVE hold stops blocking at its expiry instant', () => {
    expect(evaluateSwap(input({ holds: [hold({ ...at1011, expiresAtMs: SAMPLE_NOW_MS + 1 })] }), candidate(window1011)).feasible).toBe(false);
    expect(evaluateSwap(input({ holds: [hold({ ...at1011, expiresAtMs: SAMPLE_NOW_MS })] }), candidate(window1011)).feasible).toBe(true);
  });

  it('a FROZEN hold blocks even after its expiry time', () => {
    const frozen = hold({ ...at1011, status: 'FROZEN', expiresAtMs: SAMPLE_NOW_MS - 1 });
    expect(evaluateSwap(input({ holds: [frozen] }), candidate(window1011)).feasible).toBe(false);
  });

  it('RELEASED and CONVERTED holds do not block', () => {
    for (const status of ['RELEASED', 'CONVERTED'] as const) {
      expect(evaluateSwap(input({ holds: [hold({ ...at1011, status })] }), candidate(window1011)).feasible).toBe(true);
    }
  });

  it("the case's own hold is ignored when re-checking that case", () => {
    const own = hold({ ...at1011, caseId: 'C7', status: 'FROZEN' });
    expect(evaluateSwap(input({ holds: [own], ownCaseId: 'C7' }), candidate(window1011)).feasible).toBe(true);
    expect(evaluateSwap(input({ holds: [own], ownCaseId: 'C8' }), candidate(window1011)).feasible).toBe(false);
  });
});

describe('business hours and time zone', () => {
  it('rejects slots before opening', () => {
    const e = infeasible(evaluateSwap(input(), candidate([L('2026-11-10', '08:00', '10:30')])));
    expect(e.reasons).toEqual(['DESTINATION_OUTSIDE_BUSINESS_HOURS']);
  });

  it('accepts a slot ending exactly at closing time, rejects one past it', () => {
    const e = feasible(evaluateSwap(input(), candidate([L('2026-11-10', '17:00', '19:00')])));
    expect(e.destinations.map((d) => local(d))).toEqual(['2026-11-10 17:00-18:00']);
  });

  it('applies business hours in the shop time zone, not UTC', () => {
    // 20:00-21:00 in Tokyo is 11:00-12:00Z, which would look "open" if hours were read in UTC.
    const evening = [L('2026-11-10', '20:00', '21:00')];
    expect(infeasible(evaluateSwap(input(), candidate(evening))).reasons).toEqual(['DESTINATION_OUTSIDE_BUSINESS_HOURS']);

    // The same instants are inside 10:00-18:00 for a shop whose zone is UTC.
    const utcShop: ShopRules = { ...shop, timeZone: 'UTC' };
    expect(withinBusinessHours(evening[0]!, shop)).toBe(false);
    expect(withinBusinessHours(evening[0]!, utcShop)).toBe(true);
  });

  it('a slot crossing local midnight is outside even for a 24-hour shop', () => {
    const allDay: ShopRules = { ...shop, businessOpenMinute: 0, businessCloseMinute: 1440 };
    const crossing = [{ startMs: localToUtcMs('2026-11-10', '23:30', TZ), endMs: localToUtcMs('2026-11-11', '00:30', TZ) }];
    expect(infeasible(evaluateSwap(input({ shop: allDay }), candidate(crossing))).reasons).toEqual([
      'DESTINATION_OUTSIDE_BUSINESS_HOURS',
    ]);
    const beforeMidnight = [L('2026-11-10', '23:00', '23:59')];
    expect(evaluateSwap(input({ shop: allDay }), candidate(beforeMidnight)).feasible).toBe(false); // 59 min < 60
    const lastHour = [{ startMs: localToUtcMs('2026-11-10', '23:00', TZ), endMs: localToUtcMs('2026-11-11', '00:00', TZ) }];
    expect(evaluateSwap(input({ shop: allDay }), candidate(lastHour)).feasible).toBe(true);
  });

  it('follows the offset change at a DST boundary (America/Los_Angeles, 2026-11-01)', () => {
    const la: ShopRules = { ...shop, timeZone: 'America/Los_Angeles' };
    const laBooking: BookingSlot = { ...aBooking, ...localInterval('2026-11-06', '14:00', '15:00', la.timeZone) };
    const run = (window: Interval) =>
      evaluateSwap(
        input({
          shop: la,
          bookings: [laBooking],
          bRequest: { serviceId: 'cut', windows: [localInterval('2026-11-06', '14:00', '15:00', la.timeZone)] },
        }),
        candidate([window], { booking: laBooking }),
      );
    // 17:00Z on 2026-11-05 is 09:00 PST, before opening. Under the summer offset (PDT) it would have read 10:00.
    expect(run({ startMs: Date.UTC(2026, 10, 5, 17), endMs: Date.UTC(2026, 10, 5, 18) }).feasible).toBe(false);
    expect(run({ startMs: Date.UTC(2026, 10, 5, 18), endMs: Date.UTC(2026, 10, 5, 19) }).feasible).toBe(true);
  });
});

describe('preconditions and time', () => {
  it('requires a confirmed, paid booking with a registered preference', () => {
    expect(infeasible(evaluateSwap(input(), candidate(undefined, { paymentVerified: false }))).reasons).toEqual(['A_PAYMENT_NOT_VERIFIED']);
    expect(infeasible(evaluateSwap(input(), candidate(null))).reasons).toEqual(['A_NO_FLEX_PREFERENCE']);
    expect(infeasible(evaluateSwap(input(), candidate([]))).reasons).toEqual(['A_NO_FLEX_PREFERENCE']);
    const cancelled = { ...aBooking, status: 'CANCELLED' as const };
    expect(infeasible(evaluateSwap(input(), candidate(undefined, { booking: cancelled }))).reasons).toEqual(['A_BOOKING_NOT_CONFIRMED']);
  });

  it('rejects once A has started, using the given current time', () => {
    expect(evaluateSwap(input({ nowMs: aBooking.startMs - 1 }), candidate()).feasible).toBe(true);
    expect(infeasible(evaluateSwap(input({ nowMs: aBooking.startMs }), candidate())).reasons).toEqual(['A_BOOKING_ALREADY_STARTED']);
  });

  it('rejects destinations that already started', () => {
    const now = localToUtcMs('2026-11-07', '13:00', TZ);
    const e = infeasible(evaluateSwap(input({ nowMs: now }), candidate([L('2026-11-07', '10:00', '12:00')])));
    expect(e.reasons).toEqual(['DESTINATION_IN_PAST']);
  });

  it('rejects a B request for another stylist', () => {
    const e = infeasible(evaluateSwap(input({ bRequest: { serviceId: 'cut', windows: [L('2026-11-07', '14:00', '15:00')], stylistId: 'other' } }), candidate()));
    expect(e.reasons).toEqual(['B_STYLIST_MISMATCH']);
  });

  it('reports every reason once, in a fixed order', () => {
    const e = infeasible(
      evaluateSwap(
        input({ bRequest: { serviceId: 'cut-color', windows: [L('2026-11-07', '14:00', '15:00')] } }),
        candidate([L('2026-11-10', '08:00', '09:30'), L('2026-11-10', '09:00', '10:30')]),
      ),
    );
    expect(e.reasons).toEqual([
      'B_SERVICE_LONGER_THAN_REQUEST_WINDOW',
      'B_SERVICE_LONGER_THAN_ORIGIN_SLOT',
      'DESTINATION_OUTSIDE_BUSINESS_HOURS',
    ]);
  });
});

describe('B slot search starts from B’s own window (IP1-03, I02)', () => {
  const longA: BookingSlot = { ...aBooking, serviceId: 'cut-color', ...L('2026-11-07', '14:00', '16:00') };
  const evalB = (windows: Interval[], booking: BookingSlot = longA) =>
    evaluateSwap(
      input({ bookings: [booking], bRequest: { serviceId: 'cut', windows } }),
      candidate([L('2026-11-10', '10:00', '12:00')], { booking }),
    );

  it('a 14:10-15:10 request inside a 14:00-16:00 origin is feasible at 14:10 (not snapped to 14:00/14:15)', () => {
    expect(local(feasible(evalB([L('2026-11-07', '14:10', '15:10')])).bSlot)).toBe('2026-11-07 14:10-15:10');
  });

  it('with several windows, the earliest feasible start across windows wins', () => {
    const e = feasible(evalB([L('2026-11-07', '14:20', '15:00'), L('2026-11-07', '15:05', '16:00'), L('2026-11-07', '14:50', '16:00')]));
    expect(local(e.bSlot)).toBe('2026-11-07 14:50-15:50');
  });

  it('a window ending exactly at the origin end is accepted', () => {
    expect(local(feasible(evalB([L('2026-11-07', '15:00', '16:00')])).bSlot)).toBe('2026-11-07 15:00-16:00');
  });

  it('a window wider than the origin is searched only inside the origin', () => {
    expect(local(feasible(evalB([L('2026-11-07', '13:50', '15:20')], aBooking)).bSlot)).toBe('2026-11-07 14:00-15:00');
  });

  it('a window that leaves too little time inside the origin is rejected with its own reason', () => {
    const e = infeasible(evalB([L('2026-11-07', '14:30', '15:30')], aBooking));
    expect(e.reasons).toEqual(['B_WINDOW_OUTSIDE_ORIGIN_SLOT']);
    expect(e.rejectedBSlots).toEqual([]);
  });
});

describe('findSwapCandidates', () => {
  it('evaluates bookings that occupy B’s window', () => {
    const result = findSwapCandidates(input(), [candidate()]);
    expect(result.reasons).toEqual([]);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0]!.feasible).toBe(true);
  });

  it('reports when nothing occupies B’s window', () => {
    const result = findSwapCandidates(input({ bRequest: { serviceId: 'cut', windows: [L('2026-11-07', '15:00', '16:00')] } }), [candidate()]);
    expect(result).toEqual({ evaluations: [], reasons: ['NO_BOOKING_IN_REQUESTED_WINDOW'] });
  });
});
