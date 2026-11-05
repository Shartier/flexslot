// The immutable terms snapshot of a swap case (DESIGN 3, SPEC 6) and its hash.
// The case creation step writes terms_json with buildCaseTerms; E1 and E5 re-check it against the row and against
// the current database (IE1-02), and E7 books from the snapshot only, never from the mutable request.

import { createHash } from 'node:crypto';
import type { Db } from '../db/database.ts';
import { canonicalJson } from '../paypal/requests.ts';

export interface CaseRow {
  id: string;
  world_id: string;
  version: number;
  status: string;
  terms_json: string;
  terms_hash: string;
  a_booking_id: string;
  a_booking_version: number;
  b_request_id: string;
  stylist_id: string;
  origin_start_ms: number;
  origin_end_ms: number;
  b_start_ms: number;
  b_end_ms: number;
  dest_start_ms: number;
  dest_end_ms: number;
  b_price_minor: number;
  a_comp_minor: number;
  currency: string;
  a_capture_id: string;
  offer_expires_at: number;
}

/**
 * What the approvals are bound to, beyond the case columns (IE1-02): the parties, both services with B's
 * duration, and the versions of B's request and A's move conditions that the proposal was computed from.
 */
export interface FixedTerms {
  /** The shop's PayPal merchant id; every PayPal answer is matched against it. */
  payeeMerchantId: string;
  aCustomerId: string;
  bCustomerId: string;
  aServiceId: string;
  bServiceId: string;
  bServiceDurationMin: number;
  bRequestVersion: number;
  aPreferenceVersion: number;
}

export interface CaseTerms extends FixedTerms {
  caseId: string;
  version: number;
  aBookingId: string;
  aBookingVersion: number;
  bRequestId: string;
  stylistId: string;
  originStartMs: number;
  originEndMs: number;
  bStartMs: number;
  bEndMs: number;
  destStartMs: number;
  destEndMs: number;
  bPriceMinor: number;
  aCompMinor: number;
  currency: string;
  aCaptureId: string;
  offerExpiresAt: number;
}

type CaseFields = Omit<CaseRow, 'world_id' | 'status' | 'terms_json' | 'terms_hash'>;

export function buildCaseTerms(c: CaseFields, fixed: FixedTerms): CaseTerms {
  return {
    caseId: c.id,
    version: c.version,
    aBookingId: c.a_booking_id,
    aBookingVersion: c.a_booking_version,
    bRequestId: c.b_request_id,
    stylistId: c.stylist_id,
    originStartMs: c.origin_start_ms,
    originEndMs: c.origin_end_ms,
    bStartMs: c.b_start_ms,
    bEndMs: c.b_end_ms,
    destStartMs: c.dest_start_ms,
    destEndMs: c.dest_end_ms,
    bPriceMinor: c.b_price_minor,
    aCompMinor: c.a_comp_minor,
    currency: c.currency,
    aCaptureId: c.a_capture_id,
    offerExpiresAt: c.offer_expires_at,
    payeeMerchantId: fixed.payeeMerchantId,
    aCustomerId: fixed.aCustomerId,
    bCustomerId: fixed.bCustomerId,
    aServiceId: fixed.aServiceId,
    bServiceId: fixed.bServiceId,
    bServiceDurationMin: fixed.bServiceDurationMin,
    bRequestVersion: fixed.bRequestVersion,
    aPreferenceVersion: fixed.aPreferenceVersion,
  };
}

export function termsHash(terms: CaseTerms): string {
  return createHash('sha256').update(canonicalJson(terms)).digest('hex');
}

const STRING_FIELDS = ['payeeMerchantId', 'aCustomerId', 'bCustomerId', 'aServiceId', 'bServiceId'] as const;
const INT_FIELDS = ['bServiceDurationMin', 'bRequestVersion', 'aPreferenceVersion'] as const;

/** Parses terms_json; null if it is not a complete snapshot or does not hash to terms_hash. */
export function readTerms(c: CaseRow): CaseTerms | null {
  let t: unknown;
  try {
    t = JSON.parse(c.terms_json);
  } catch {
    return null;
  }
  if (t === null || typeof t !== 'object') return null;
  const terms = t as CaseTerms;
  for (const k of STRING_FIELDS) if (typeof terms[k] !== 'string' || terms[k] === '') return null;
  for (const k of INT_FIELDS) if (!Number.isSafeInteger(terms[k]) || terms[k] < 1) return null;
  if (termsHash(terms) !== c.terms_hash) return null;
  return terms;
}

/** Names of the case columns that differ from the snapshot. */
export function termsMismatches(c: CaseRow, terms: CaseTerms): string[] {
  const expected = buildCaseTerms(c, terms);
  return (Object.keys(expected) as Array<keyof CaseTerms>).filter((k) => expected[k] !== terms[k]);
}

/**
 * IE1-02: what in the database no longer matches the approved snapshot. Before the payment starts (E1) any of these
 * refuses the start (the parties must approve new terms); after it (E5) they break the freeze and the
 * authorization is voided. E7 never reads these rows: it books from the snapshot.
 */
export function frozenTermsProblems(db: Db, terms: CaseTerms): string[] {
  const out: string[] = [];
  const req = db.prepare('SELECT customer_id, version, structured_json FROM b_requests WHERE id = ?').get(terms.bRequestId) as
    | { customer_id: string; version: number; structured_json: string }
    | undefined;
  let serviceId: unknown = null;
  try {
    serviceId = req ? (JSON.parse(req.structured_json) as { serviceId?: unknown }).serviceId : null;
  } catch {
    serviceId = null;
  }
  const latest = req
    ? (db.prepare('SELECT max(version) AS v FROM b_requests WHERE customer_id = ? AND confirmed_at IS NOT NULL').get(req.customer_id) as { v: number | null }).v
    : null;
  if (!req || req.customer_id !== terms.bCustomerId || req.version !== terms.bRequestVersion || serviceId !== terms.bServiceId || (latest ?? req.version) !== req.version) {
    out.push('B_REQUEST_CHANGED');
  }
  const svc = db.prepare('SELECT duration_min FROM services WHERE id = ?').get(terms.bServiceId) as { duration_min: number } | undefined;
  if (!svc || svc.duration_min !== terms.bServiceDurationMin || terms.bEndMs - terms.bStartMs !== terms.bServiceDurationMin * 60_000) out.push('B_SERVICE_CHANGED');
  const a = db.prepare('SELECT customer_id, service_id FROM bookings WHERE id = ?').get(terms.aBookingId) as { customer_id: string; service_id: string } | undefined;
  if (!a || a.customer_id !== terms.aCustomerId || a.service_id !== terms.aServiceId) out.push('A_BOOKING_CHANGED');
  const pref = db.prepare('SELECT max(version) AS v FROM flex_preferences WHERE booking_id = ? AND confirmed_at IS NOT NULL').get(terms.aBookingId) as { v: number | null };
  if (pref.v !== terms.aPreferenceVersion) out.push('A_PREFERENCE_CHANGED');
  return out;
}

/**
 * IE1-03: the swap can still be carried out only while none of the three slots has started (server clock).
 * Half-open slots: at the start instant the slot has started, so `now === start` is already too late.
 */
export function slotTimeProblems(c: Pick<CaseRow, 'origin_start_ms' | 'b_start_ms' | 'dest_start_ms'>, now: number): string[] {
  return now < Math.min(c.origin_start_ms, c.b_start_ms, c.dest_start_ms) ? [] : ['SLOT_TIME_PASSED'];
}
