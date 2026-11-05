// Candidate check, proposal and approvals (DESIGN 6.1 steps 4-6, D08). Payment starts in the executor (E1).
// Every decision reads the database only: the browser sends a case id and the version/terms hash it displayed
// (to bind the approval to what the person saw), never amounts, ids of bookings or payments (DESIGN 5, AC11).

import { randomUUID } from 'node:crypto';
import { immediate, isSlotConflict, type Db } from '../db/database.ts';
import { findSwapCandidates, type ACandidate, type BookingSlot, type SlotHold, type SwapEvaluation, type SwapSearchInput } from '../domain/candidates.ts';
import { TERMINAL_CASE_STATUSES } from '../db/schema.ts';
import { audit, getCase, releaseHolds, setCase } from '../executor/store.ts';
import { buildCaseTerms, termsHash, type CaseRow } from '../executor/terms.ts';
import { formatLocal, localInterval, type Interval } from '../time.ts';
import { latestPreference, latestRequest, type LocalWindow } from './intake.ts';
import { idsFor, servicesOf, shopOf } from './world.ts';

export const OFFER_TTL_MS = 2 * 3_600_000;
const TERMINAL = TERMINAL_CASE_STATUSES.map((s) => `'${s}'`).join(', ');

export type Refusal = { ok: false; reason: string };
const no = (reason: string): Refusal => ({ ok: false, reason });

export interface Proposal {
  evaluationId: string;
  feasible: boolean;
  caseId: string | null;
  reasons: string[];
}

const toIntervals = (ws: LocalWindow[], tz: string): Interval[] => ws.map((w) => localInterval(w.date, w.start, w.end, tz));

export function activeCaseId(db: Db, worldId: string): string | null {
  const r = db.prepare(`SELECT id FROM swap_cases WHERE world_id = ? AND status NOT IN (${TERMINAL}) ORDER BY rowid DESC LIMIT 1`).get(worldId) as { id: string } | undefined;
  return r?.id ?? null;
}

/**
 * DESIGN 6.1 steps 4-5 for one confirmed B request, inside an open transaction: the program checks every paid
 * booking with confirmed move conditions that occupies B's time, records the verdict, and for the first feasible
 * one creates the case (terms snapshot + hash, version 1) with an ACTIVE hold on A's destination.
 */
export function proposeInTx(db: Db, now: number, worldId: string, bRequestId: string, offerTtlMs = OFFER_TTL_MS): Proposal {
  const shop = shopOf(db, worldId);
  const tz = shop.timezone;
  const services = servicesOf(db, shop.id);
  const req = db.prepare('SELECT * FROM b_requests WHERE id = ? AND world_id = ?').get(bRequestId, worldId) as
    | { id: string; customer_id: string; version: number; structured_json: string }
    | undefined;
  if (!req) throw new Error('unknown request');
  const bReq = JSON.parse(req.structured_json) as { serviceId: string; windows: LocalWindow[]; stylistId: string | null };
  const evaluationId = randomUUID();
  const record = (feasible: boolean, caseId: string | null, reasons: string[], detail: unknown): Proposal => {
    db.prepare('INSERT INTO candidate_evaluations (id, world_id, b_request_id, evaluated_at, feasible, case_id, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      evaluationId, worldId, bRequestId, now, feasible ? 1 : 0, caseId, JSON.stringify({ reasons, detail }),
    );
    audit(db, now, { worldId, caseId, actor: 'system', action: feasible ? 'CANDIDATE_FOUND' : 'CANDIDATE_NONE', detail: { bRequestId, reasons } });
    return { evaluationId, feasible, caseId, reasons };
  };
  if (activeCaseId(db, worldId)) return record(false, null, ['CASE_IN_PROGRESS'], null);

  const bookings = (
    db.prepare('SELECT id, stylist_id, service_id, status, start_ms, end_ms, customer_id, version FROM bookings WHERE shop_id = ?').all(shop.id) as Array<{
      id: string; stylist_id: string; service_id: string; status: 'CONFIRMED' | 'CANCELLED'; start_ms: number; end_ms: number; customer_id: string; version: number;
    }>
  );
  const slots: BookingSlot[] = bookings.map((b) => ({ id: b.id, stylistId: b.stylist_id, serviceId: b.service_id, status: b.status, startMs: b.start_ms, endMs: b.end_ms }));
  const holds: SlotHold[] = (
    db.prepare('SELECT h.* FROM slot_holds h JOIN stylists s ON s.id = h.stylist_id WHERE s.shop_id = ?').all(shop.id) as Array<{
      id: string; case_id: string; stylist_id: string; status: SlotHold['status']; start_ms: number; end_ms: number; expires_at: number;
    }>
  ).map((h) => ({ id: h.id, caseId: h.case_id, stylistId: h.stylist_id, status: h.status, startMs: h.start_ms, endMs: h.end_ms, expiresAtMs: h.expires_at }));
  const candidates: ACandidate[] = bookings
    .filter((b) => b.status === 'CONFIRMED' && b.customer_id !== req.customer_id)
    .map((b) => {
      const pref = latestPreference(db, b.id);
      const paid = db.prepare("SELECT 1 FROM payments WHERE booking_id = ? AND kind = 'A_ORIGINAL' AND verified_at IS NOT NULL").get(b.id);
      return { booking: slots.find((s) => s.id === b.id)!, paymentVerified: !!paid, acceptableWindows: pref ? toIntervals(pref.structured.windows, tz) : null };
    });
  const input: SwapSearchInput = {
    nowMs: now,
    shop: { timeZone: tz, businessOpenMinute: shop.business_open_min, businessCloseMinute: shop.business_close_min },
    services: services.map((s) => ({ id: s.id, durationMin: s.duration_min })),
    bRequest: { serviceId: bReq.serviceId, windows: toIntervals(bReq.windows, tz), ...(bReq.stylistId ? { stylistId: bReq.stylistId } : {}) },
    bookings: slots,
    holds,
  };
  const found = findSwapCandidates(input, candidates);
  const detail = found.evaluations.map((e) => describeEvaluation(e, tz));
  const feasible = found.evaluations.find((e): e is Extract<SwapEvaluation, { feasible: true }> => e.feasible);
  if (!feasible) {
    const reasons = found.reasons.length ? found.reasons : [...new Set(found.evaluations.flatMap((e) => (e.feasible ? [] : e.reasons)))];
    return record(false, null, reasons, detail);
  }

  const a = bookings.find((b) => b.id === feasible.aBookingId)!;
  if (db.prepare('SELECT 1 FROM compensation_grants WHERE booking_id = ?').get(a.id)) return record(false, null, ['A_ALREADY_COMPENSATED'], detail);
  if (!shop.expected_payee_merchant_id) return record(false, null, ['PAYEE_NOT_SET'], detail);
  const pref = latestPreference(db, a.id)!;
  const capture = db.prepare("SELECT capture_id FROM payments WHERE booking_id = ? AND kind = 'A_ORIGINAL' AND verified_at IS NOT NULL").get(a.id) as { capture_id: string };
  const bService = services.find((s) => s.id === bReq.serviceId)!;
  const n = (db.prepare('SELECT count(*) AS n FROM swap_cases WHERE world_id = ?').get(worldId) as { n: number }).n + 1;
  const caseId = `${worldId}:case:${n}`;
  const row: Omit<CaseRow, 'world_id' | 'status' | 'terms_json' | 'terms_hash'> = {
    id: caseId,
    version: 1,
    a_booking_id: a.id,
    a_booking_version: a.version,
    b_request_id: bRequestId,
    stylist_id: feasible.stylistId,
    origin_start_ms: a.start_ms,
    origin_end_ms: a.end_ms,
    b_start_ms: feasible.bSlot.startMs,
    b_end_ms: feasible.bSlot.endMs,
    dest_start_ms: feasible.destination.startMs,
    dest_end_ms: feasible.destination.endMs,
    b_price_minor: bService.price_minor,
    a_comp_minor: pref.compensation_minor,
    currency: shop.currency,
    a_capture_id: capture.capture_id,
    offer_expires_at: now + offerTtlMs,
  };
  // IE1-02 / D22: the approvals are bound to the parties, both services, B's duration and the versions of B's
  // request and A's conditions this proposal was computed from; the executor re-checks them at E1 and E5.
  const terms = buildCaseTerms(row, {
    payeeMerchantId: shop.expected_payee_merchant_id,
    aCustomerId: a.customer_id,
    bCustomerId: req.customer_id,
    aServiceId: a.service_id,
    bServiceId: bService.id,
    bServiceDurationMin: bService.duration_min,
    bRequestVersion: req.version,
    aPreferenceVersion: pref.version,
  });
  db.exec('SAVEPOINT propose');
  try {
    db.prepare(
      `INSERT INTO swap_cases (id, world_id, version, status, terms_json, terms_hash, a_booking_id, a_booking_version, b_request_id, stylist_id,
         origin_start_ms, origin_end_ms, b_start_ms, b_end_ms, dest_start_ms, dest_end_ms, b_price_minor, a_comp_minor, currency, a_capture_id, offer_expires_at)
       VALUES (?, ?, ?, 'AWAITING_APPROVAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      caseId, worldId, row.version, JSON.stringify(terms), termsHash(terms), row.a_booking_id, row.a_booking_version, row.b_request_id, row.stylist_id,
      row.origin_start_ms, row.origin_end_ms, row.b_start_ms, row.b_end_ms, row.dest_start_ms, row.dest_end_ms, row.b_price_minor, row.a_comp_minor,
      row.currency, row.a_capture_id, row.offer_expires_at,
    );
    db.prepare("INSERT INTO slot_holds (id, case_id, stylist_id, start_ms, end_ms, status, expires_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?)").run(
      `${caseId}:hold`, caseId, row.stylist_id, row.dest_start_ms, row.dest_end_ms, row.offer_expires_at,
    );
    db.exec('RELEASE propose');
  } catch (e) {
    db.exec('ROLLBACK TO propose');
    db.exec('RELEASE propose');
    if (!isSlotConflict(e) && !/constraint failed/i.test(String((e as Error).message))) throw e;
    return record(false, null, ['DESTINATION_CONFLICT'], detail);
  }
  audit(db, now, { worldId, caseId, actor: 'system', action: 'CASE_PROPOSED', detail: { version: 1 } });
  return record(true, caseId, [], detail);
}

export function propose(db: Db, now: number, worldId: string, bRequestId: string, offerTtlMs = OFFER_TTL_MS): Proposal {
  return immediate(db, () => proposeInTx(db, now, worldId, bRequestId, offerTtlMs));
}

/**
 * After A's conditions or A's payment change: re-check B's latest request if it never had a case and nothing is
 * in progress (a rejected or expired proposal is not offered again automatically).
 */
export function reevaluateInTx(db: Db, now: number, worldId: string, offerTtlMs = OFFER_TTL_MS): Proposal | null {
  const ids = idsFor(worldId);
  const req = latestRequest(db, ids.customerBId);
  if (!req) return null;
  if (activeCaseId(db, worldId)) return null;
  if (db.prepare("SELECT 1 FROM swap_cases WHERE world_id = ? AND (b_request_id = ? OR status = 'COMPLETED')").get(worldId, req.id)) return null;
  return proposeInTx(db, now, worldId, req.id, offerTtlMs);
}

function describeEvaluation(e: SwapEvaluation, tz: string): Record<string, unknown> {
  const fmt = (i: Interval) => `${formatLocal(i.startMs, tz)}-${formatLocal(i.endMs, tz).slice(11)}`;
  return e.feasible
    ? { feasible: true, bSlot: fmt(e.bSlot), destination: fmt(e.destination) }
    : {
        feasible: false,
        reasons: e.reasons,
        rejectedBSlots: e.rejectedBSlots.slice(0, 6).map((r) => ({ slot: fmt(r.slot), reasons: r.reasons })),
        rejectedDestinations: e.rejectedDestinations.slice(0, 12).map((r) => ({ slot: fmt(r.slot), reasons: r.reasons })),
      };
}

// ---- approvals (D08: owner -> A -> B; B's approval is E1 in the executor) ----------------------------------------

export type ApproverRole = 'OWNER' | 'A' | 'B';

interface Decision {
  worldId: string;
  caseId: string;
  role: ApproverRole;
  partyId: string;
  version: number;
  termsHash: string;
}

/** Whether `partyId` is the case's party for `role` (server-side owner check, DESIGN 5). */
export function isCaseParty(db: Db, c: CaseRow, role: ApproverRole, partyId: string): boolean {
  if (role === 'OWNER') return partyId === idsFor(c.world_id).ownerPartyId;
  if (role === 'A') return !!db.prepare('SELECT 1 FROM bookings WHERE id = ? AND customer_id = ?').get(c.a_booking_id, partyId);
  return !!db.prepare('SELECT 1 FROM b_requests WHERE id = ? AND customer_id = ?').get(c.b_request_id, partyId);
}

function loadForDecision(db: Db, d: Decision, now: number): CaseRow | Refusal {
  const c = getCase(db, d.caseId);
  if (!c || c.world_id !== d.worldId) return no('CASE_NOT_FOUND');
  if (!isCaseParty(db, c, d.role, d.partyId)) return no('NOT_YOUR_CASE');
  if (c.version !== d.version || c.terms_hash !== d.termsHash) return no('TERMS_CHANGED');
  if (now >= c.offer_expires_at) return no('OFFER_EXPIRED');
  return c;
}

export function approveCase(db: Db, now: number, d: Decision): { ok: true; status: string } | Refusal {
  if (d.role === 'B') return no('USE_PAYMENT_START');
  return immediate(db, () => {
    const c = loadForDecision(db, d, now);
    if ('ok' in c) return c;
    if (c.status !== 'AWAITING_APPROVAL') return no('NOT_AWAITING_APPROVAL');
    if (db.prepare('SELECT 1 FROM approvals WHERE case_id = ? AND role = ? AND terms_hash = ?').get(c.id, d.role, c.terms_hash)) return no('ALREADY_DECIDED');
    if (d.role === 'A') {
      const owner = db.prepare("SELECT 1 FROM approvals WHERE case_id = ? AND role = 'OWNER' AND terms_hash = ? AND decision = 'APPROVED'").get(c.id, c.terms_hash);
      if (!owner) return no('OWNER_FIRST');
    }
    db.prepare("INSERT INTO approvals (case_id, role, party_id, terms_hash, decision, decided_at) VALUES (?, ?, ?, ?, 'APPROVED', ?)").run(c.id, d.role, d.partyId, c.terms_hash, now);
    if (d.role === 'A' && !setCase(db, c, ['AWAITING_APPROVAL'], 'A_ACCEPTED')) throw new Error('case moved during approval');
    audit(db, now, { worldId: c.world_id, caseId: c.id, actor: d.role, action: `${d.role}_APPROVED`, detail: { version: c.version } });
    return { ok: true, status: getCase(db, c.id)!.status };
  });
}

/**
 * Rejection before the payment starts (SPEC 7: A keeps the booking, B is not charged, the hold is released).
 * Serialized with E1 by BEGIN IMMEDIATE and the conditional status update: whichever commits first wins.
 */
export function rejectCase(db: Db, now: number, d: Decision): { ok: true; status: string } | Refusal {
  return immediate(db, () => {
    const c = getCase(db, d.caseId);
    if (!c || c.world_id !== d.worldId) return no('CASE_NOT_FOUND');
    if (!isCaseParty(db, c, d.role, d.partyId)) return no('NOT_YOUR_CASE');
    if (c.version !== d.version || c.terms_hash !== d.termsHash) return no('TERMS_CHANGED');
    if (c.status !== 'AWAITING_APPROVAL' && c.status !== 'A_ACCEPTED') return no('NOT_REJECTABLE');
    const existing = db.prepare('SELECT decision FROM approvals WHERE case_id = ? AND role = ? AND terms_hash = ?').get(c.id, d.role, c.terms_hash) as
      | { decision: string }
      | undefined;
    if (existing?.decision === 'REJECTED') return no('ALREADY_DECIDED');
    if (existing) {
      db.prepare("UPDATE approvals SET decision = 'REJECTED', decided_at = ? WHERE case_id = ? AND role = ? AND terms_hash = ?").run(now, c.id, d.role, c.terms_hash);
    } else {
      db.prepare("INSERT INTO approvals (case_id, role, party_id, terms_hash, decision, decided_at) VALUES (?, ?, ?, ?, 'REJECTED', ?)").run(c.id, d.role, d.partyId, c.terms_hash, now);
    }
    if (!setCase(db, c, ['AWAITING_APPROVAL', 'A_ACCEPTED'], 'REJECTED')) return no('NOT_REJECTABLE');
    releaseHolds(db, c.id);
    audit(db, now, { worldId: c.world_id, caseId: c.id, actor: d.role, action: `${d.role}_REJECTED`, detail: { version: c.version } });
    return { ok: true, status: 'REJECTED' };
  });
}

/** Proposals past their deadline before the payment started: EXPIRED, hold released (SPEC 7). */
export function expireOffers(db: Db, now: number): string[] {
  const due = db
    .prepare("SELECT id FROM swap_cases WHERE status IN ('AWAITING_APPROVAL', 'A_ACCEPTED') AND offer_expires_at <= ?")
    .all(now) as Array<{ id: string }>;
  const out: string[] = [];
  for (const { id } of due) {
    immediate(db, () => {
      const c = getCase(db, id)!;
      if (now < c.offer_expires_at) return;
      if (!setCase(db, c, ['AWAITING_APPROVAL', 'A_ACCEPTED'], 'EXPIRED')) return;
      releaseHolds(db, c.id);
      audit(db, now, { worldId: c.world_id, caseId: c.id, actor: 'system', action: 'OFFER_EXPIRED', detail: { version: c.version } });
      out.push(id);
    });
  }
  return out;
}
