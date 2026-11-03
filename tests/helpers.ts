import { createHash } from 'node:crypto';
import { openDatabase, type Db } from '../src/db/database.ts';
import { SAMPLE, SAMPLE_NOW_MS, seedSampleWorld, type SampleWorldIds } from '../src/sample.ts';
import { localToUtcMs } from '../src/time.ts';

export const TZ = SAMPLE.shop.timeZone;

/** Local wall time in the sample shop's zone -> UTC ms. */
export const at = (date: string, time: string) => localToUtcMs(date, time, TZ);

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export function seeded(): { db: Db; ids: SampleWorldIds } {
  const db = openDatabase(':memory:');
  const ids = seedSampleWorld(db, 'w1', SAMPLE_NOW_MS);
  return { db, ids };
}

export function insertBooking(
  db: Db,
  ids: SampleWorldIds,
  b: { id: string; start: number; end: number; stylistId?: string; status?: 'CONFIRMED' | 'CANCELLED' },
): void {
  db.prepare(
    `INSERT INTO bookings (id, shop_id, stylist_id, customer_id, service_id, start_ms, end_ms, status, version, price_minor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 6000)`,
  ).run(b.id, ids.shopId, b.stylistId ?? ids.stylistId, ids.customerBId, ids.cutServiceId, b.start, b.end, b.status ?? 'CONFIRMED');
}

export function insertStylist(db: Db, ids: SampleWorldIds, id: string): void {
  db.prepare('INSERT INTO stylists (id, shop_id, name) VALUES (?, ?, ?)').run(id, ids.shopId, id);
}

/** A swap case for the sample: A 2026-11-07 14:00-15:00 -> 2026-11-10 10:00-11:00, B takes 14:00-15:00. */
export function insertCase(db: Db, ids: SampleWorldIds, c: { id: string; status?: string; version?: number }): string {
  const terms = { caseId: c.id, version: c.version ?? 1 };
  db.prepare(
    `INSERT INTO swap_cases (id, world_id, version, status, terms_json, terms_hash, a_booking_id, a_booking_version,
       b_request_id, stylist_id, origin_start_ms, origin_end_ms, b_start_ms, b_end_ms, dest_start_ms, dest_end_ms,
       b_price_minor, a_comp_minor, currency, a_capture_id, offer_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 6000, 1000, 'USD', ?, ?)`,
  ).run(
    c.id, ids.worldId, terms.version, c.status ?? 'AWAITING_APPROVAL', JSON.stringify(terms), sha256(JSON.stringify(terms)),
    ids.aBookingId, ids.bRequestId, ids.stylistId,
    at('2026-11-07', '14:00'), at('2026-11-07', '15:00'), at('2026-11-07', '14:00'), at('2026-11-07', '15:00'),
    at('2026-11-10', '10:00'), at('2026-11-10', '11:00'),
    `MOCK-CAPTURE-${ids.worldId}-A`, SAMPLE_NOW_MS + 3_600_000,
  );
  return sha256(JSON.stringify(terms));
}

export function insertHold(
  db: Db,
  ids: SampleWorldIds,
  h: { id: string; caseId: string; start: number; end: number; status?: string; expiresAt?: number; stylistId?: string },
): void {
  db.prepare(
    'INSERT INTO slot_holds (id, case_id, stylist_id, start_ms, end_ms, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(h.id, h.caseId, h.stylistId ?? ids.stylistId, h.start, h.end, h.status ?? 'ACTIVE', h.expiresAt ?? SAMPLE_NOW_MS + 900_000);
}

export function insertObligation(
  db: Db,
  o: { id: string; caseId: string; kind: string; amount: number; target?: string | null },
): void {
  db.prepare(
    `INSERT INTO money_obligations (id, case_id, kind, amount_minor, currency, target_external_id, status)
     VALUES (?, ?, ?, ?, 'USD', ?, 'OPEN')`,
  ).run(o.id, o.caseId, o.kind, o.amount, o.target ?? null);
}

export function insertAttempt(
  db: Db,
  a: {
    id: string;
    obligationId: string;
    attemptNo?: number;
    previous?: string | null;
    status?: string;
    termsHash: string;
    caseVersion?: number;
  },
): void {
  db.prepare(
    `INSERT INTO payment_attempts (id, obligation_id, attempt_no, previous_attempt_id, case_version, terms_hash, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.id, a.obligationId, a.attemptNo ?? 1, a.previous ?? null, a.caseVersion ?? 1, a.termsHash, SAMPLE_NOW_MS + 900_000,
    a.status ?? 'OPEN',
  );
}

export function insertOperation(
  db: Db,
  o: {
    id: string;
    attemptId: string;
    kind: string;
    seq?: number;
    previous?: string | null;
    target?: string | null;
    status?: string;
    requestId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO payment_operations (id, attempt_id, op_kind, op_seq, previous_operation_id, target_external_id,
       paypal_request_id, request_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id, o.attemptId, o.kind, o.seq ?? 1, o.previous ?? null, o.target ?? null,
    o.requestId ?? `rid-${o.id}`, sha256(`body-${o.id}`), o.status ?? 'PREPARED',
  );
}
