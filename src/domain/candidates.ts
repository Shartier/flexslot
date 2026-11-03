// Swap candidate check (SPEC 4, DESIGN 6.1 step 4). Pure functions: no DB, no clock, no AI.
// The caller passes the current time and every booking/hold of the shop; the result is decided here only.

import { interval, localMinuteOfDayToUtcMs, MINUTE_MS, overlaps, toLocal, type Interval } from '../time.ts';

export type BookingStatus = 'CONFIRMED' | 'CANCELLED';
export type HoldStatus = 'ACTIVE' | 'FROZEN' | 'RELEASED' | 'CONVERTED';

export interface BookingSlot extends Interval {
  id: string;
  stylistId: string;
  serviceId: string;
  status: BookingStatus;
}

export interface SlotHold extends Interval {
  id: string;
  caseId: string;
  stylistId: string;
  status: HoldStatus;
  expiresAtMs: number;
}

export interface ShopRules {
  timeZone: string;
  /** Minutes after local midnight, same every day in this MVP. */
  businessOpenMinute: number;
  businessCloseMinute: number;
}

export interface ServiceSpec {
  id: string;
  durationMin: number;
}

/** An existing booking that might move, with what the server has verified about it. */
export interface ACandidate {
  booking: BookingSlot;
  paymentVerified: boolean;
  /** Windows from A's latest confirmed preference; the whole service must fit inside one. Null if none registered. */
  acceptableWindows: Interval[] | null;
}

export interface BRequestSpec {
  serviceId: string;
  /** B's whole service must fit inside one of these. */
  windows: Interval[];
  /** Absent means "the stylist of the booking being swapped". */
  stylistId?: string;
}

export interface SwapSearchInput {
  nowMs: number;
  shop: ShopRules;
  services: ServiceSpec[];
  bRequest: BRequestSpec;
  /** Every booking of the shop, any stylist and status. */
  bookings: BookingSlot[];
  /** Every slot hold of the shop, any status. */
  holds: SlotHold[];
  /** Holds of this case are ignored (re-checking a case that already holds its destination). */
  ownCaseId?: string;
  /**
   * Granularity of start times tried inside a window. A's destinations count from the start of each acceptable
   * window; B's slots count from the start of each (request window ∩ A's original slot). Times are never rounded.
   */
  stepMinutes?: number;
}

/** Ordered as reported. */
export const REASONS = [
  'NO_BOOKING_IN_REQUESTED_WINDOW',
  'A_BOOKING_NOT_CONFIRMED',
  'A_BOOKING_ALREADY_STARTED',
  'A_PAYMENT_NOT_VERIFIED',
  'A_NO_FLEX_PREFERENCE',
  'B_STYLIST_MISMATCH',
  'B_SERVICE_LONGER_THAN_REQUEST_WINDOW',
  'B_SERVICE_LONGER_THAN_ORIGIN_SLOT',
  'B_WINDOW_OUTSIDE_ORIGIN_SLOT',
  'B_SLOT_OUTSIDE_BUSINESS_HOURS',
  'B_SLOT_CONFLICT',
  'A_SERVICE_LONGER_THAN_WINDOW',
  'DESTINATION_IN_PAST',
  'DESTINATION_OUTSIDE_BUSINESS_HOURS',
  'DESTINATION_OVERLAPS_ORIGIN',
  'DESTINATION_CONFLICT',
] as const;

export type Reason = (typeof REASONS)[number];

export interface RejectedSlot {
  slot: Interval;
  reasons: Reason[];
  /** Ids of bookings/holds that overlap, when the reason is a conflict. */
  conflictsWith: string[];
}

export type SwapEvaluation =
  | {
      feasible: true;
      aBookingId: string;
      stylistId: string;
      /** Where B would be booked: inside A's original slot. */
      bSlot: Interval;
      /** Where A would move: the earliest feasible destination. */
      destination: Interval;
      /** Every feasible destination, ascending; destination is the first. */
      destinations: Interval[];
    }
  | {
      feasible: false;
      aBookingId: string;
      reasons: Reason[];
      rejectedBSlots: RejectedSlot[];
      rejectedDestinations: RejectedSlot[];
    };

const DEFAULT_STEP_MINUTES = 15;

/**
 * Evaluates moving one existing booking (A) so that B takes A's original slot.
 *
 * Rules (SPEC 4): half-open intervals; the whole service inside business hours (shop timezone) and inside the
 * person's acceptable window; same stylist; no overlap with confirmed bookings or with ACTIVE (unexpired) /
 * FROZEN holds of other cases. B's slot must lie inside A's original slot, which is the only place A's booking
 * protects until the swap commits (DESIGN 4).
 */
export function evaluateSwap(input: SwapSearchInput, a: ACandidate): SwapEvaluation {
  const stepMs = stepMsOf(input);
  const aBooking = a.booking;
  const fail = (
    reasons: Reason[],
    rejectedBSlots: RejectedSlot[] = [],
    rejectedDestinations: RejectedSlot[] = [],
  ): SwapEvaluation => ({
    feasible: false,
    aBookingId: aBooking.id,
    reasons: sortReasons(reasons),
    rejectedBSlots,
    rejectedDestinations,
  });

  const preconditions: Reason[] = [];
  if (aBooking.status !== 'CONFIRMED') preconditions.push('A_BOOKING_NOT_CONFIRMED');
  if (aBooking.startMs <= input.nowMs) preconditions.push('A_BOOKING_ALREADY_STARTED');
  if (!a.paymentVerified) preconditions.push('A_PAYMENT_NOT_VERIFIED');
  if (a.acceptableWindows === null || a.acceptableWindows.length === 0) preconditions.push('A_NO_FLEX_PREFERENCE');
  if (input.bRequest.stylistId !== undefined && input.bRequest.stylistId !== aBooking.stylistId) {
    preconditions.push('B_STYLIST_MISMATCH');
  }
  if (preconditions.length > 0) return fail(preconditions);

  const stylistId = aBooking.stylistId;
  const origin = interval(aBooking.startMs, aBooking.endMs);
  const bDurationMs = durationMsOf(input.services, input.bRequest.serviceId);
  const aDurationMs = durationMsOf(input.services, aBooking.serviceId);
  const blockers = blockersFor(input, stylistId, aBooking.id);

  // B's slot (I01, I02): start times from the start of each (request window ∩ A's original slot), so B's slot
  // always lies inside both. A requested 14:10 start is tried as 14:10, not snapped to a grid from 14:00.
  const bReasons: Reason[] = [];
  const windowFits = input.bRequest.windows.some((w) => w.endMs - w.startMs >= bDurationMs);
  const originFits = origin.endMs - origin.startMs >= bDurationMs;
  if (!windowFits) bReasons.push('B_SERVICE_LONGER_THAN_REQUEST_WINDOW');
  if (!originFits) bReasons.push('B_SERVICE_LONGER_THAN_ORIGIN_SLOT');
  const bSeen = new Set<number>();
  const bCandidates: Interval[] = [];
  for (const w of input.bRequest.windows) {
    const start = Math.max(w.startMs, origin.startMs);
    const end = Math.min(w.endMs, origin.endMs);
    if (end <= start) continue;
    for (const slot of slotsWithin(interval(start, end), bDurationMs, stepMs)) {
      if (bSeen.has(slot.startMs)) continue;
      bSeen.add(slot.startMs);
      bCandidates.push(slot);
    }
  }
  if (windowFits && originFits && bCandidates.length === 0) bReasons.push('B_WINDOW_OUTSIDE_ORIGIN_SLOT');
  bCandidates.sort((x, y) => x.startMs - y.startMs);
  const feasibleB: Interval[] = [];
  const rejectedBSlots: RejectedSlot[] = [];
  for (const slot of bCandidates) {
    const reasons: Reason[] = [];
    if (!withinBusinessHours(slot, input.shop)) reasons.push('B_SLOT_OUTSIDE_BUSINESS_HOURS');
    const conflictsWith = blockers.filter((b) => overlaps(b, slot)).map((b) => b.id);
    if (conflictsWith.length > 0) reasons.push('B_SLOT_CONFLICT');
    if (reasons.length === 0) feasibleB.push(slot);
    else rejectedBSlots.push({ slot, reasons, conflictsWith });
  }

  // A's destination: start times inside each acceptable window.
  const aReasons: Reason[] = [];
  const windows = a.acceptableWindows ?? [];
  if (!windows.some((w) => w.endMs - w.startMs >= aDurationMs)) aReasons.push('A_SERVICE_LONGER_THAN_WINDOW');
  const seen = new Set<number>();
  const feasibleDestinations: Interval[] = [];
  const rejectedDestinations: RejectedSlot[] = [];
  for (const window of windows) {
    for (const slot of slotsWithin(window, aDurationMs, stepMs)) {
      if (seen.has(slot.startMs)) continue;
      seen.add(slot.startMs);
      const reasons: Reason[] = [];
      if (slot.startMs <= input.nowMs) reasons.push('DESTINATION_IN_PAST');
      if (!withinBusinessHours(slot, input.shop)) reasons.push('DESTINATION_OUTSIDE_BUSINESS_HOURS');
      if (overlaps(slot, origin)) reasons.push('DESTINATION_OVERLAPS_ORIGIN');
      const conflictsWith = blockers.filter((b) => overlaps(b, slot)).map((b) => b.id);
      if (conflictsWith.length > 0) reasons.push('DESTINATION_CONFLICT');
      if (reasons.length === 0) feasibleDestinations.push(slot);
      else rejectedDestinations.push({ slot, reasons, conflictsWith });
    }
  }
  feasibleDestinations.sort((x, y) => x.startMs - y.startMs);

  const bSlot = feasibleB[0];
  const destination = feasibleDestinations[0];
  if (bSlot === undefined || destination === undefined) {
    const reasons = [
      ...(bSlot === undefined ? [...bReasons, ...rejectedBSlots.flatMap((r) => r.reasons)] : []),
      ...(destination === undefined ? [...aReasons, ...rejectedDestinations.flatMap((r) => r.reasons)] : []),
    ];
    return fail(reasons, rejectedBSlots, rejectedDestinations);
  }
  return { feasible: true, aBookingId: aBooking.id, stylistId, bSlot, destination, destinations: feasibleDestinations };
}

/**
 * DESIGN 6.1 step 4: among confirmed bookings occupying B's requested time, evaluate each.
 * Returns one evaluation per occupying booking, or a single reason when nothing occupies B's windows.
 */
export function findSwapCandidates(
  input: SwapSearchInput,
  candidates: ACandidate[],
): { evaluations: SwapEvaluation[]; reasons: Reason[] } {
  const occupying = candidates.filter(
    (c) =>
      c.booking.status === 'CONFIRMED' &&
      (input.bRequest.stylistId === undefined || c.booking.stylistId === input.bRequest.stylistId) &&
      input.bRequest.windows.some((w) => overlaps(w, c.booking)),
  );
  if (occupying.length === 0) return { evaluations: [], reasons: ['NO_BOOKING_IN_REQUESTED_WINDOW'] };
  const evaluations = occupying
    .sort((x, y) => x.booking.startMs - y.booking.startMs)
    .map((c) => evaluateSwap(input, c));
  return { evaluations, reasons: [] };
}

export function withinBusinessHours(slot: Interval, shop: ShopRules): boolean {
  const day = toLocal(slot.startMs, shop.timeZone);
  const open = localMinuteOfDayToUtcMs(day, shop.businessOpenMinute, shop.timeZone);
  const close = localMinuteOfDayToUtcMs(day, shop.businessCloseMinute, shop.timeZone);
  return open <= slot.startMs && slot.endMs <= close;
}

/** Bookings and holds that block the stylist's time, excluding A's own booking (it is what moves). */
function blockersFor(input: SwapSearchInput, stylistId: string, aBookingId: string): Array<Interval & { id: string }> {
  const bookings = input.bookings.filter(
    (b) => b.stylistId === stylistId && b.status === 'CONFIRMED' && b.id !== aBookingId,
  );
  const holds = input.holds.filter(
    (h) =>
      h.stylistId === stylistId &&
      h.caseId !== input.ownCaseId &&
      // FROZEN never lapses by time (SPEC 6); ACTIVE lapses at expiresAtMs.
      (h.status === 'FROZEN' || (h.status === 'ACTIVE' && input.nowMs < h.expiresAtMs)),
  );
  return [...bookings, ...holds];
}

function slotsWithin(window: Interval, durationMs: number, stepMs: number): Interval[] {
  const slots: Interval[] = [];
  for (let start = window.startMs; start + durationMs <= window.endMs; start += stepMs) {
    slots.push(interval(start, start + durationMs));
  }
  return slots;
}

function durationMsOf(services: ServiceSpec[], serviceId: string): number {
  const service = services.find((s) => s.id === serviceId);
  if (!service) throw new Error(`unknown service ${serviceId}`);
  if (!Number.isInteger(service.durationMin) || service.durationMin <= 0) {
    throw new RangeError(`service ${serviceId} has invalid duration ${service.durationMin}`);
  }
  return service.durationMin * MINUTE_MS;
}

function stepMsOf(input: SwapSearchInput): number {
  const step = input.stepMinutes ?? DEFAULT_STEP_MINUTES;
  if (!Number.isInteger(step) || step <= 0) throw new RangeError(`stepMinutes must be a positive integer, got ${step}`);
  return step * MINUTE_MS;
}

function sortReasons(reasons: Reason[]): Reason[] {
  return [...new Set(reasons)].sort((x, y) => REASONS.indexOf(x) - REASONS.indexOf(y));
}
