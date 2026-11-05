// Regression tests for Codex's review of impl-executor-1 (IE1-01..IE1-03). Mock PayPal only: the late answers and
// the clock moves are fault injection, not something observed in the Sandbox.

import { describe, expect, it } from 'vitest';
import { buildCaseTerms, readTerms, termsHash, type CaseRow } from '../src/executor/terms.ts';
import {
  audits,
  caseStatus,
  chargeAttempt,
  crashAt,
  expectCompletedSwap,
  holdStatus,
  obligation,
  opsOf,
  posts,
  restart,
  sampleFixedTerms,
  SimulatedCrash,
  swapWorld,
  toAuthorized,
  type SwapWorld,
} from './executor-helpers.ts';
import { at } from './helpers.ts';

const authorizationsAtPayPal = async (w: SwapWorld, orderId: string) => {
  const q = await w.paypal.getOrder(orderId);
  if (q.kind !== 'FOUND') throw new Error('order query');
  return (q.resource.purchase_units ?? []).flatMap((u) => u.payments?.authorizations ?? []);
};

describe('IE1-01: a negative query never ends an unconfirmed send', () => {
  it('late_authorize_after_negative_query_and_expiry: the attempt stays open, the late authorization is used once', async () => {
    const w = await swapWorld({ timeoutMs: 5000 });
    const ex = w.exec();
    w.start(ex);
    const order = await ex.createOrder(w.caseId);
    if (!order.ok) throw new Error('order');
    const gate = w.faulty.hold('ORDER_AUTHORIZE', 'REQUEST');
    const pending = ex.onBuyerApproved(w.caseId); // a browser signal before the PayPal approval
    await gate.arrived;
    w.clock.advance(61_000);
    const ex2 = w.exec({ owner: 'recovered' });
    await ex2.recover();
    const op = opsOf(w, 'ORDER_AUTHORIZE')[0]!;
    expect(op.status).not.toBe('NOT_ACCEPTED');
    expect(op).toMatchObject({ prior_unknown: 1, last_error_class: 'ORDER_NOT_APPROVED' });
    // The deadline passes: nothing is ended or released while the authorization may still happen.
    w.clock.set(chargeAttempt(w).expires_at);
    expect(ex2.expireAttempts()).toEqual([]);
    expect([caseStatus(w), holdStatus(w), obligation(w, 'B_CHARGE')?.status, chargeAttempt(w).status]).toEqual(['PAYMENT_STARTED', 'FROZEN', 'OPEN', 'ORDER_CREATED']);
    // The buyer approves and the delayed POST arrives. The stale answer is not adopted (lease lost)...
    w.server.approveOrder(order.orderId);
    gate.release();
    await pending;
    // ...recovery finds the authorization with the same operation and goes on.
    w.clock.advance(11_000);
    await ex2.processDue();
    await ex2.advance(w.caseId);
    expect(opsOf(w, 'ORDER_AUTHORIZE')).toHaveLength(1);
    const ids = new Set(w.server.requests.filter((r) => r.route === 'ORDER_AUTHORIZE').map((r) => r.requestId));
    expect([...ids]).toEqual([op.paypal_request_id]);
    expect(caseStatus(w)).toBe('COMPLETED');
    expect((await authorizationsAtPayPal(w, order.orderId)).map((a) => a.status)).toEqual(['CAPTURED']);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
    expect(posts(w, 'AUTH_VOID')).toHaveLength(0);
  });

  it('the order is approved before the recovery: a same-id resend, never a new operation', async () => {
    const w = await swapWorld({ timeoutMs: 5000 });
    const ex = w.exec();
    w.start(ex);
    const order = await ex.createOrder(w.caseId);
    if (!order.ok) throw new Error('order');
    w.server.inject('ORDER_AUTHORIZE', { type: 'RESPONSE_LOST' }); // processed: 422 ORDER_NOT_APPROVED, answer lost
    await ex.onBuyerApproved(w.caseId);
    const op = opsOf(w, 'ORDER_AUTHORIZE')[0]!;
    expect(op).toMatchObject({ status: 'UNKNOWN', prior_unknown: 1 });
    w.clock.advance(11_000);
    await ex.processDue(); // GET: not approved -> keep waiting
    expect(opsOf(w, 'ORDER_AUTHORIZE')[0]).toMatchObject({ status: 'UNKNOWN', last_error_class: 'ORDER_NOT_APPROVED' });
    w.server.approveOrder(order.orderId);
    w.clock.advance(11_000);
    await ex.processDue();
    await ex.advance(w.caseId);
    expect(opsOf(w, 'ORDER_AUTHORIZE')).toHaveLength(1);
    expectCompletedSwap(w, expect);
  });

  it('an order that is never approved: after the deadline and a grace period the owner is told; nothing is released', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    w.start(ex);
    await ex.createOrder(w.caseId);
    w.server.inject('ORDER_AUTHORIZE', { type: 'TIMEOUT', processed: true });
    await ex.onBuyerApproved(w.caseId);
    w.clock.set(chargeAttempt(w).expires_at + 30 * 60_000);
    expect(ex.expireAttempts()).toEqual([]);
    await ex.processDue();
    const op = opsOf(w, 'ORDER_AUTHORIZE')[0]!;
    expect(op).toMatchObject({ status: 'UNKNOWN', last_error_class: 'HOLD:UNCONFIRMED_ORDER_NOT_APPROVED' });
    expect(obligation(w, 'B_CHARGE')?.status).toBe('NEEDS_ATTENTION');
    expect([caseStatus(w), holdStatus(w)]).toEqual(['PAYMENT_STARTED', 'FROZEN']);
    expect(audits(w, 'ATTENTION').map((a) => a.reason)).toContain('HOLD:UNCONFIRMED_ORDER_NOT_APPROVED');
    const sent = w.server.requests.length;
    w.clock.advance(60_000);
    await ex.processDue();
    expect(w.server.requests.length).toBe(sent); // held: the queue leaves it alone
    expect(opsOf(w)).toHaveLength(2);
  });

  it('late_a_capture_after_negative_query: the capture of A is found and recorded, with the same operation', async () => {
    const w = await swapWorld({ timeoutMs: 5000 });
    w.db.prepare('DELETE FROM payments').run();
    const ex = w.exec();
    expect(ex.prepareAPayment(w.ids.aBookingId).ok).toBe(true);
    const order = await ex.createAOrder(w.ids.aBookingId);
    if (!order.ok) throw new Error('order');
    const gate = w.faulty.hold('ORDER_CAPTURE', 'REQUEST');
    const pending = ex.captureAPayment(w.ids.aBookingId);
    await gate.arrived;
    w.clock.advance(61_000);
    const ex2 = w.exec({ owner: 'recovered' });
    await ex2.recover();
    const capOp = () => w.db.prepare("SELECT * FROM a_payment_operations WHERE op_kind = 'ORDER_CAPTURE'").all() as Array<{ status: string; reconcile_status: string | null; paypal_request_id: string }>;
    expect(capOp()[0]!.status).not.toBe('NOT_ACCEPTED');
    w.server.approveOrder(order.orderId);
    gate.release();
    await pending;
    w.clock.advance(11_000);
    await ex2.processDue();
    await ex2.processDue();
    expect(capOp()).toHaveLength(1);
    expect(capOp()[0]).toMatchObject({ status: 'SUCCEEDED', reconcile_status: 'MATCHED' });
    expect(w.db.prepare("SELECT count(*) AS n FROM payments WHERE kind = 'A_ORIGINAL'").get()).toEqual({ n: 1 });
    const ids = new Set(w.server.requests.filter((r) => r.route === 'ORDER_CAPTURE').map((r) => r.requestId));
    expect([...ids]).toEqual([capOp()[0]!.paypal_request_id]);
  });

  it('I29: an authorization that turns up for an attempt that already ended is voided and shown to the owner', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    w.start(ex);
    const order = await ex.createOrder(w.caseId);
    if (!order.ok) throw new Error('order');
    w.server.approveOrder(order.orderId);
    w.server.inject('ORDER_AUTHORIZE', { type: 'TIMEOUT', processed: true });
    await ex.onBuyerApproved(w.caseId);
    // A state the executor no longer produces (IE1-01), forced here to exercise the defence.
    w.db.prepare("UPDATE payment_attempts SET status = 'EXPIRED' WHERE id = ?").run(chargeAttempt(w).id);
    w.db.prepare("UPDATE swap_cases SET status = 'EXPIRED' WHERE id = ?").run(w.caseId);
    w.db.prepare("UPDATE slot_holds SET status = 'RELEASED' WHERE case_id = ?").run(w.caseId);
    w.clock.advance(61_000);
    const ex2 = w.exec({ owner: 'recovered' });
    await ex2.recover();
    await ex2.processDue();
    w.clock.advance(11_000);
    await ex2.processDue();
    expect(audits(w, 'ATTENTION').map((a) => a.reason)).toContain('MONEY_ON_ENDED_ATTEMPT');
    expect(obligation(w, 'B_AUTH_VOID')?.status).toBe('SETTLED');
    expect((await authorizationsAtPayPal(w, order.orderId)).map((a) => a.status)).toEqual(['VOIDED']);
    expect(caseStatus(w)).toBe('EXPIRED');
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(0);
  });
});

describe('IE1-02: the approved snapshot fixes the request, services, parties and versions', () => {
  it('b_request_service_changed_after_authorization: the freeze is broken before the capture -> void, no booking', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    await toAuthorized(w, ex);
    const row = w.db.prepare('SELECT structured_json FROM b_requests WHERE id = ?').get(w.ids.bRequestId) as { structured_json: string };
    const changed = { ...JSON.parse(row.structured_json), serviceId: w.ids.cutColorServiceId };
    w.db.prepare('UPDATE b_requests SET version = version + 1, structured_json = ? WHERE id = ?').run(JSON.stringify(changed), w.ids.bRequestId);
    await ex.advance(w.caseId);
    expect(caseStatus(w)).toBe('REJECTED');
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(0);
    expect(obligation(w, 'B_AUTH_VOID')?.status).toBe('SETTLED');
    expect(audits(w, 'PRE_CAPTURE_CHECK_FAILED')[0]).toMatchObject({ problems: ['B_REQUEST_CHANGED'] });
    expect(w.db.prepare('SELECT 1 FROM bookings WHERE id = ?').get(`${w.caseId}:booking:b`)).toBeUndefined();
  });

  it('before the payment starts, any change of request, service, parties or A conditions refuses E1 (re-approval needed)', async () => {
    const cases: Array<[string, (w: SwapWorld) => void, string]> = [
      ['new request version', (w) => {
        w.db.prepare("INSERT INTO b_requests (id, world_id, customer_id, version, raw_text, structured_json, input_source, confirmed_at) VALUES ('R2', ?, ?, 2, 't', ?, 'MANUAL', 1)").run(
          w.ids.worldId, w.ids.customerBId, JSON.stringify({ serviceId: w.ids.cutServiceId, windows: [] }),
        );
      }, 'B_REQUEST_CHANGED'],
      ['request service', (w) => {
        w.db.prepare('UPDATE b_requests SET structured_json = ? WHERE id = ?').run(JSON.stringify({ serviceId: w.ids.cutColorServiceId, windows: [] }), w.ids.bRequestId);
      }, 'B_REQUEST_CHANGED'],
      ['service duration', (w) => {
        w.db.prepare('UPDATE services SET duration_min = 90 WHERE id = ?').run(w.ids.cutServiceId);
      }, 'B_SERVICE_CHANGED'],
      ['A conditions', (w) => {
        w.db.prepare("INSERT INTO flex_preferences (id, booking_id, version, raw_text, structured_json, input_source, confirmed_at, compensation_minor) VALUES ('P2', ?, 2, 't', '{}', 'MANUAL', 1, 1000)").run(w.ids.aBookingId);
      }, 'A_PREFERENCE_CHANGED'],
      ['A party', (w) => {
        w.db.prepare("INSERT INTO customers (id, world_id, display_name) VALUES ('other', ?, 'X')").run(w.ids.worldId);
        w.db.prepare("UPDATE bookings SET customer_id = 'other' WHERE id = ?").run(w.ids.aBookingId);
      }, 'A_BOOKING_CHANGED'],
    ];
    for (const [name, change, reason] of cases) {
      const w = await swapWorld();
      change(w);
      const r = w.exec().startPayment({ caseId: w.caseId, version: 1, termsHash: w.termsHash, bPartyId: w.ids.customerBId });
      expect([name, r]).toEqual([name, { ok: false, reason }]);
      expect(caseStatus(w)).toBe('A_ACCEPTED');
      expect(obligation(w, 'B_CHARGE')).toBeUndefined();
    }
  });

  it('a snapshot without the fixed fields (or another B) is refused', async () => {
    const w = await swapWorld();
    const c = w.db.prepare('SELECT * FROM swap_cases WHERE id = ?').get(w.caseId) as unknown as CaseRow;
    const old = JSON.parse(c.terms_json) as Record<string, unknown>;
    delete old.bServiceId;
    const oldHash = termsHash(old as never);
    w.db.prepare('UPDATE swap_cases SET terms_json = ?, terms_hash = ? WHERE id = ?').run(JSON.stringify(old), oldHash, w.caseId);
    w.db.prepare('UPDATE approvals SET terms_hash = ? WHERE case_id = ?').run(oldHash, w.caseId);
    expect(readTerms({ ...c, terms_json: JSON.stringify(old), terms_hash: oldHash })).toBeNull();
    expect(w.exec().startPayment({ caseId: w.caseId, version: 1, termsHash: oldHash, bPartyId: w.ids.customerBId })).toEqual({ ok: false, reason: 'TERMS_INVALID' });

    const w2 = await swapWorld();
    const c2 = w2.db.prepare('SELECT * FROM swap_cases WHERE id = ?').get(w2.caseId) as unknown as CaseRow;
    const other = buildCaseTerms(c2, { ...sampleFixedTerms(w2.ids), bCustomerId: w2.ids.customerAId });
    const h = termsHash(other);
    w2.db.prepare('UPDATE swap_cases SET terms_json = ?, terms_hash = ? WHERE id = ?').run(JSON.stringify(other), h, w2.caseId);
    w2.db.prepare('UPDATE approvals SET terms_hash = ? WHERE case_id = ?').run(h, w2.caseId);
    expect(w2.exec().startPayment({ caseId: w2.caseId, version: 1, termsHash: h, bPartyId: w2.ids.customerBId })).toEqual({ ok: false, reason: 'NOT_B' });
  });

  it('after the capture, E7 books from the snapshot and does not follow a changed request', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('before-e7') });
    await toAuthorized(w, ex);
    await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
    expect(caseStatus(w)).toBe('CAPTURED');
    w.db.prepare('UPDATE b_requests SET version = 2, customer_id = ?, structured_json = ? WHERE id = ?').run(
      w.ids.customerAId, JSON.stringify({ serviceId: w.ids.cutColorServiceId, windows: [] }), w.ids.bRequestId,
    );
    await restart(w).recover();
    expect(caseStatus(w)).toBe('COMPLETED');
    expect(w.db.prepare('SELECT customer_id, service_id, (end_ms - start_ms) / 60000 AS minutes, price_minor FROM bookings WHERE id = ?').get(`${w.caseId}:booking:b`)).toEqual({
      customer_id: w.ids.customerBId, service_id: w.ids.cutServiceId, minutes: 60, price_minor: 6000,
    });
  });
});

describe('IE1-03: slots that have started are never swapped (server clock, half-open)', () => {
  it('E1: one millisecond before the start is fine; at the start and after it the payment does not start', async () => {
    for (const [t, ok] of [[at('2026-11-07', '14:00') - 1, true], [at('2026-11-07', '14:00'), false], [at('2026-11-07', '15:01'), false]] as const) {
      const w = await swapWorld();
      // Keep the offer and the hold valid at that time, so only the slot time decides.
      w.db.prepare('UPDATE slot_holds SET expires_at = ? WHERE case_id = ?').run(t + 3_600_000, w.caseId);
      const c = w.db.prepare('SELECT * FROM swap_cases WHERE id = ?').get(w.caseId) as unknown as CaseRow;
      const terms = buildCaseTerms({ ...c, offer_expires_at: t + 3_600_000 }, sampleFixedTerms(w.ids));
      const h = termsHash(terms);
      w.db.prepare('UPDATE swap_cases SET offer_expires_at = ?, terms_json = ?, terms_hash = ? WHERE id = ?').run(t + 3_600_000, JSON.stringify(terms), h, w.caseId);
      w.db.prepare('UPDATE approvals SET terms_hash = ? WHERE case_id = ?').run(h, w.caseId);
      w.clock.set(t);
      const r = w.exec().startPayment({ caseId: w.caseId, version: 1, termsHash: h, bPartyId: w.ids.customerBId });
      expect(r.ok).toBe(ok);
      if (!r.ok) expect(r.reason).toBe('SLOT_TIME_PASSED');
    }
  });

  it('past_service_time_before_capture: E5 at the start instant voids the authorization; nothing is captured or booked', async () => {
    for (const t of [at('2026-11-07', '14:00'), at('2026-11-07', '15:01')]) {
      const w = await swapWorld();
      const ex = w.exec();
      await toAuthorized(w, ex);
      w.clock.set(t);
      await ex.advance(w.caseId);
      expect(caseStatus(w)).toBe('REJECTED');
      expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(0);
      expect(audits(w, 'PRE_CAPTURE_CHECK_FAILED')[0]).toMatchObject({ problems: ['SLOT_TIME_PASSED'] });
      expect(obligation(w, 'A_COMPENSATION_REFUND')).toBeUndefined();
      expect(holdStatus(w)).toBe('RELEASED');
    }
  });

  it('just before the start the capture and the swap still go through', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    await toAuthorized(w, ex);
    w.clock.set(at('2026-11-07', '14:00') - 1);
    await ex.advance(w.caseId);
    expectCompletedSwap(w, expect);
  });

  it('past_service_time_after_capture_before_e7: A keeps the booking, B is refunded in full, no compensation', async () => {
    for (const t of [at('2026-11-07', '14:00'), at('2026-11-07', '15:01')]) {
      const w = await swapWorld();
      const ex = w.exec({ hooks: crashAt('before-e7') });
      await toAuthorized(w, ex);
      await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
      w.clock.set(t);
      const ex2 = w.exec({ owner: 'recovered' });
      await ex2.recover();
      await ex2.processDue();
      expect(caseStatus(w)).toBe('COMPENSATED');
      expect(obligation(w, 'B_RECOVERY_REFUND')).toMatchObject({ status: 'SETTLED', amount_minor: 6000 });
      expect(obligation(w, 'A_COMPENSATION_REFUND')).toBeUndefined();
      expect(w.db.prepare('SELECT count(*) AS n FROM compensation_grants').get()).toEqual({ n: 0 });
      expect(w.db.prepare('SELECT start_ms, version FROM bookings WHERE id = ?').get(w.ids.aBookingId)).toEqual({ start_ms: at('2026-11-07', '14:00'), version: 1 });
      expect(w.db.prepare('SELECT 1 FROM bookings WHERE id = ?').get(`${w.caseId}:booking:b`)).toBeUndefined();
    }
  });

  it('a capture whose result is unknown when the slot starts is not timed out: it is resolved, then refunded', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    await toAuthorized(w, ex);
    w.server.inject('AUTH_CAPTURE', { type: 'TIMEOUT', processed: true });
    await ex.advance(w.caseId);
    expect(opsOf(w, 'AUTH_CAPTURE')[0]).toMatchObject({ status: 'UNKNOWN' });
    w.clock.set(at('2026-11-07', '15:01'));
    await ex.processDue();
    await ex.processDue();
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
    expect(obligation(w, 'B_CHARGE')?.status).toBe('SETTLED');
    expect(caseStatus(w)).toBe('COMPENSATED');
    expect(obligation(w, 'B_RECOVERY_REFUND')?.status).toBe('SETTLED');
  });
});
