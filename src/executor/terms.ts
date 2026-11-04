// The immutable terms snapshot of a swap case (DESIGN 3, SPEC 6) and its hash.
// The case creation step (later) writes terms_json with buildCaseTerms; E1 re-checks it against the row.

import { createHash } from 'node:crypto';
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

export interface CaseTerms {
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
  /** The shop's PayPal merchant id fixed with the terms; every PayPal answer is matched against it. */
  payeeMerchantId: string;
}

type CaseFields = Omit<CaseRow, 'world_id' | 'status' | 'terms_json' | 'terms_hash'>;

export function buildCaseTerms(c: CaseFields, payeeMerchantId: string): CaseTerms {
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
    payeeMerchantId,
  };
}

export function termsHash(terms: CaseTerms): string {
  return createHash('sha256').update(canonicalJson(terms)).digest('hex');
}

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
  if (typeof terms.payeeMerchantId !== 'string' || terms.payeeMerchantId === '') return null;
  if (termsHash(terms) !== c.terms_hash) return null;
  return terms;
}

/** Names of the case columns that differ from the snapshot. */
export function termsMismatches(c: CaseRow, terms: CaseTerms): string[] {
  const expected = buildCaseTerms(c, terms.payeeMerchantId);
  return (Object.keys(expected) as Array<keyof CaseTerms>).filter((k) => expected[k] !== terms[k]);
}
