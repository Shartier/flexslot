// AC08 / AC10: fault injection and restart (DESIGN 7.2, 7.3, 7.5, D19, D20, IP1-04, 6.3 item 8).
// Mock PayPal only. "Crash" = a hook throws at a fixed point, the executor is dropped, the clock passes the
// lease, and a new executor (new owner) runs recover() on the same database and the same mock server.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { immediate } from '../src/db/database.ts';
import { acquireLease, getOp, writeUnderLease } from '../src/executor/ops.ts';
import type { ReplayModes } from '../src/paypal/mock-server.ts';
import {
  SimulatedCrash,
  audits,
  caseStatus,
  chargeAttempt,
  crashAt,
  e7Marker,
  expectCompletedSwap,
  gets,
  holdStatus,
  obligation,
  opsOf,
  posts,
  restart,
  swapWorld,
  toAuthorized,
  type SwapWorld,
} from './executor-helpers.ts';

const REPLAYS: ReplayModes[] = [
  { orders: 'ORIGINAL', payments: 'ORIGINAL' },
  { orders: 'CURRENT', payments: 'CURRENT' },
  { orders: 'CURRENT', payments: 'ORIGINAL' }, // what Sandbox showed on 2026-11-03 (STATUS F4)
  { orders: 'ORIGINAL', payments: 'CURRENT' },
];

const kindIs = (kind: string) => (i: { opKind?: string }) => i.opKind === kind;

describe('AC08: the four interruption points of DESIGN 7.5 (PayPal succeeded, DB not saved)', () => {
  it('OP1 order create: same request id, same order, no new operation; B_CHARGE stays open', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('after-send', kindIs('ORDER_CREATE')) });
    w.start(ex);
    await expect(ex.createOrder(w.caseId)).rejects.toThrow(SimulatedCrash);
    expect(opsOf(w)[0]).toMatchObject({ status: 'SENDING', result_external_id: null });
    const orders = w.server.count('orders');

    const ex2 = restart(w);
    const report = await ex2.recover();
    expect(report.recovered).toEqual([opsOf(w)[0]!.id]);
    const sends = posts(w, 'ORDER_CREATE');
    expect(sends).toHaveLength(2);
    expect(sends[1]!.requestId).toBe(sends[0]!.requestId);
    expect(w.server.count('orders')).toBe(orders);
    expect(opsOf(w)).toHaveLength(1);
    expect(opsOf(w)[0]).toMatchObject({ status: 'SUCCEEDED', prior_unknown: 1 });
    expect(chargeAttempt(w).status).toBe('ORDER_CREATED');
    expect(obligation(w, 'B_CHARGE')?.status).toBe('OPEN');
  });

  it('OP2 authorize: found by querying the order, not resent; B_CHARGE open, hold frozen, then completes', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('after-send', kindIs('ORDER_AUTHORIZE')) });
    w.start(ex);
    const o = await ex.createOrder(w.caseId);
    if (!o.ok) throw new Error('order');
    w.server.approveOrder(o.orderId);
    await expect(ex.onBuyerApproved(w.caseId)).rejects.toThrow(SimulatedCrash);
    expect(opsOf(w, 'ORDER_AUTHORIZE')[0]!.status).toBe('SENDING');

    const ex2 = restart(w);
    await ex2.recover();
    expect(posts(w, 'ORDER_AUTHORIZE')).toHaveLength(1);
    expect(opsOf(w, 'ORDER_AUTHORIZE')).toHaveLength(1);
    expect(opsOf(w, 'ORDER_AUTHORIZE')[0]).toMatchObject({ status: 'SUCCEEDED', reconcile_status: 'MATCHED' });
    expectCompletedSwap(w, expect);
  });

  it('OP3 capture: found via the authorization and the order, not resent, reconciled, then E7', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('after-send', kindIs('AUTH_CAPTURE')) });
    await toAuthorized(w, ex);
    await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
    expect(opsOf(w, 'AUTH_CAPTURE')[0]!.status).toBe('SENDING');
    expect(obligation(w, 'B_CHARGE')?.status).toBe('OPEN');
    expect(holdStatus(w)).toBe('FROZEN');
    expect(e7Marker(w).grant).toBe(false);

    const ex2 = restart(w);
    await ex2.recover();
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
    expect(opsOf(w, 'AUTH_CAPTURE')).toHaveLength(1);
    expect(gets(w, 'AUTH_GET').length).toBeGreaterThan(0);
    expectCompletedSwap(w, expect);
  });

  it('after OP3 is reconciled, before E7: the missing marker makes E7 run once', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('before-e7') });
    await toAuthorized(w, ex);
    await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
    expect(caseStatus(w)).toBe('CAPTURED');
    expect(obligation(w, 'B_CHARGE')?.status).toBe('SETTLED');
    expect(e7Marker(w)).toEqual({ grant: false, refundObligation: false, bBooking: false });

    await restart(w).recover();
    expectCompletedSwap(w, expect);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
  });

  it('after E7 committed, before the refund: resumes with the refund only', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('after-e7') });
    await toAuthorized(w, ex);
    await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
    expect(caseStatus(w)).toBe('BOOKING_COMMITTED');
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(0);
    await restart(w).recover();
    expectCompletedSwap(w, expect);
  });
});

describe('IP1-04: stops between the capture POST and its reconciliation (D20)', () => {
  const capturePostSaved = (i: { opKind?: string; status?: string; reconcile?: string | null }) =>
    i.opKind === 'AUTH_CAPTURE' && i.status === 'SUCCEEDED' && i.reconcile === 'AWAITING';

  function expectHeld(w: SwapWorld) {
    const cap = opsOf(w, 'AUTH_CAPTURE');
    expect(cap).toHaveLength(1);
    expect(cap[0]).toMatchObject({ status: 'SUCCEEDED', reconcile_status: 'AWAITING', external_status: 'COMPLETED' });
    expect(cap[0]!.result_external_id).toMatch(/^MOCK-CAPTURE-/);
    expect(chargeAttempt(w).status).toBe('AUTHORIZED');
    expect(obligation(w, 'B_CHARGE')?.status).toBe('OPEN');
    expect(holdStatus(w)).toBe('FROZEN');
    expect(e7Marker(w)).toEqual({ grant: false, refundObligation: false, bBooking: false });
  }

  it('stop right after the POST success is saved, before the GET: resumes from the GET only', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('after-result-saved', capturePostSaved) });
    await toAuthorized(w, ex);
    await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
    expectHeld(w);
    expect(caseStatus(w)).toBe('RECONCILING');
    expect(gets(w, 'CAPTURE_GET')).toHaveLength(0);
    const opCount = opsOf(w).length;

    const ex2 = restart(w);
    const report = await ex2.recover();
    expect(report.recovered).toEqual([opsOf(w, 'AUTH_CAPTURE')[0]!.id]);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1); // the POST is not repeated
    expect(gets(w, 'CAPTURE_GET')).toHaveLength(2); // the reconciliation GET, then the refund's pre-check GET
    expect(opsOf(w).length).toBe(opCount + 1); // only E7's refund operation is new
    expectCompletedSwap(w, expect);
  });

  it('stop after the reconciliation GET timed out: nothing settles until a later GET matches', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('after-query', (i) => i.opKind === 'AUTH_CAPTURE' && i.purpose === 'reconcile') });
    await toAuthorized(w, ex);
    w.server.inject('CAPTURE_GET', { type: 'TIMEOUT' });
    await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
    expectHeld(w);

    const ex2 = restart(w);
    await ex2.recover();
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
    expect(opsOf(w, 'AUTH_CAPTURE')).toHaveLength(1);
    expectCompletedSwap(w, expect);
  });

  it('a GET timeout that is saved keeps it awaiting; the queue retries the GET, never the POST', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    await toAuthorized(w, ex);
    w.server.inject('CAPTURE_GET', { type: 'TIMEOUT' }, 2);
    expect(await ex.advance(w.caseId)).toBe('RECONCILING');
    expectHeld(w);
    expect(opsOf(w, 'AUTH_CAPTURE')[0]!.last_error_class).toBe('CAPTURE_QUERY_TIMEOUT');
    await ex.processDue(); // not due yet
    expect(gets(w, 'CAPTURE_GET')).toHaveLength(1);
    w.clock.advance(10_000);
    await ex.processDue();
    expectHeld(w);
    w.clock.advance(10_000);
    await ex.processDue();
    expectCompletedSwap(w, expect);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
  });

  it.each([
    ['payee_missing', (j: Record<string, unknown>) => ({ ...j, payee: undefined })],
    ['payee', (j: Record<string, unknown>) => ({ ...j, payee: { merchant_id: 'SOMEONEELSE' } })],
    ['amount', (j: Record<string, unknown>) => ({ ...j, amount: { currency_code: 'USD', value: '59.00' } })],
  ])('GET capture with %s does not release anything; a later matching GET goes on exactly once', async (field, tamper) => {
    const w = await swapWorld();
    const ex = w.exec();
    await toAuthorized(w, ex);
    w.faulty.rewrite('CAPTURE_GET', tamper);
    expect(await ex.advance(w.caseId)).toBe('RECONCILING');
    expectHeld(w);
    expect(opsOf(w, 'AUTH_CAPTURE')[0]!.last_error_class).toBe(`MISMATCH:${field}`);
    expect(audits(w, 'ATTENTION').map((a) => a.reason)).toContain(`MISMATCH:${field}`);
    w.clock.advance(10_000);
    await ex.processDue();
    expectHeld(w);
    expect(audits(w, 'ATTENTION')).toHaveLength(1); // the same mismatch is not reported again

    w.faulty.clearRewrite('CAPTURE_GET');
    w.clock.advance(10_000);
    await ex.processDue();
    await ex.processDue();
    expectCompletedSwap(w, expect);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
    expect(w.db.prepare("SELECT count(*) AS n FROM bookings WHERE customer_id = ?").get(w.ids.customerBId)).toEqual({ n: 1 });
  });

  it('the DB refuses to settle B_CHARGE from a capture that is not reconciled', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('after-result-saved', capturePostSaved) });
    await toAuthorized(w, ex);
    await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
    const cap = opsOf(w, 'AUTH_CAPTURE')[0]!;
    expect(() =>
      w.db.prepare("UPDATE money_obligations SET status = 'SETTLED', settled_by_operation_id = ? WHERE kind = 'B_CHARGE'").run(cap.id),
    ).toThrow('SETTLEMENT_MISMATCH');
    expect(() => w.db.prepare("UPDATE payment_operations SET status = 'SENDING' WHERE id = ?").run(cap.id)).toThrow('OPERATION_STATUS_REGRESSION');
  });
});

describe('AC08 / D19: same-id resends answered with the original result or the current state', () => {
  it.each(REPLAYS)('order create lost, B approves meanwhile: identified either way (%o)', async (replay) => {
    const w = await swapWorld({ replay });
    const ex = w.exec();
    w.start(ex);
    w.server.inject('ORDER_CREATE', { type: 'RESPONSE_LOST' });
    expect(await ex.createOrder(w.caseId)).toEqual({ ok: false, reason: 'ORDER_CREATE_UNCONFIRMED' });
    expect(opsOf(w)[0]).toMatchObject({ status: 'UNKNOWN', last_error_class: 'NETWORK' });
    // The buyer reaches the order anyway (e.g. another tab); its id is only on the PayPal side.
    const orderId = lastOrderId(w);
    w.server.approveOrder(orderId);
    w.clock.advance(2_000);
    await ex.processDue();
    expect(opsOf(w)[0]).toMatchObject({ status: 'SUCCEEDED', result_external_id: orderId });
    expect(chargeAttempt(w).status).toBe('ORDER_CREATED');
    expect(w.server.count('orders')).toBe(2);
    expect(await ex.onBuyerApproved(w.caseId)).toEqual({ ok: true, status: 'AUTHORIZED' });
  });

  it.each(REPLAYS)('capture lost and the order query unavailable: the resend identifies the same capture (%o)', async (replay) => {
    const w = await swapWorld({ replay });
    const ex = w.exec();
    await toAuthorized(w, ex);
    w.server.inject('AUTH_CAPTURE', { type: 'RESPONSE_LOST' });
    expect(await ex.advance(w.caseId)).toBe('PAYMENT_UNKNOWN');
    w.server.inject('ORDER_GET', { type: 'HTTP_ERROR', status: 503 });
    w.clock.advance(2_000);
    await ex.processDue();
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(2);
    expect(posts(w, 'AUTH_CAPTURE')[1]!.requestId).toBe(posts(w, 'AUTH_CAPTURE')[0]!.requestId);
    expectCompletedSwap(w, expect);
  });

  it.each(REPLAYS)('capture lost, then refunded outside FlexSlot: identified but never used as B payment (%o)', async (replay) => {
    const w = await swapWorld({ replay });
    const ex = w.exec();
    await toAuthorized(w, ex);
    w.server.inject('AUTH_CAPTURE', { type: 'RESPONSE_LOST' });
    await ex.advance(w.caseId);
    const captureId = lastCaptureId(w);
    await w.paypal.refundCapture(captureId, { amount: { currency: 'USD', minor: 6000 } }, { requestId: randomUUID() });
    w.server.inject('ORDER_GET', { type: 'HTTP_ERROR', status: 503 });
    w.clock.advance(2_000);
    await ex.processDue();
    const cap = opsOf(w, 'AUTH_CAPTURE')[0]!;
    expect(cap).toMatchObject({ status: 'SUCCEEDED', result_external_id: captureId, reconcile_status: 'AWAITING', last_error_class: 'HOLD:CAPTURE_REFUNDED' });
    expect(obligation(w, 'B_CHARGE')?.status).toBe('NEEDS_ATTENTION');
    expect(holdStatus(w)).toBe('FROZEN');
    expect(e7Marker(w).grant).toBe(false);
    w.clock.advance(60_000);
    await ex.processDue();
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(2);
    expect(caseStatus(w)).toBe('RECONCILING');
  });

  it.each(REPLAYS)('refund lost: the same-id resend finds the same refund (%o)', async (replay) => {
    const w = await swapWorld({ replay });
    const ex = w.exec();
    await toAuthorized(w, ex);
    w.server.inject('CAPTURE_REFUND', { type: 'RESPONSE_LOST' });
    expect(await ex.advance(w.caseId)).toBe('REFUND_PENDING');
    w.clock.advance(2_000);
    await ex.processDue();
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(2);
    expectCompletedSwap(w, expect);
  });
});

describe('AC08: PENDING, unidentified resources, mismatches', () => {
  it('a PENDING capture is polled, never committed early, and goes on once COMPLETED', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    await toAuthorized(w, ex);
    w.server.inject('AUTH_CAPTURE', { type: 'PENDING' });
    expect(await ex.advance(w.caseId)).toBe('PAYMENT_PENDING');
    const cap = opsOf(w, 'AUTH_CAPTURE')[0]!;
    expect(cap).toMatchObject({ status: 'PENDING', external_status: 'PENDING' });
    w.clock.advance(10_000);
    await ex.processDue();
    expect(caseStatus(w)).toBe('PAYMENT_PENDING');
    expect(e7Marker(w).grant).toBe(false);
    w.server.settle(cap.result_external_id!, 'COMPLETED');
    w.clock.advance(10_000);
    await ex.processDue();
    expectCompletedSwap(w, expect);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
  });

  it('an authorize answer that cannot be identified is not used; the order query identifies it', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    w.start(ex);
    const o = await ex.createOrder(w.caseId);
    if (!o.ok) throw new Error('order');
    w.server.approveOrder(o.orderId);
    w.faulty.rewrite('ORDER_AUTHORIZE', (j) => {
      const pu = (j.purchase_units as Array<{ payments: { authorizations: Array<{ custom_id?: string }> } }>)[0]!;
      pu.payments.authorizations[0]!.custom_id = 'case:OTHER:v1:att:x';
      return j;
    });
    expect(await ex.onBuyerApproved(w.caseId)).toEqual({ ok: true, status: 'PAYMENT_STARTED' });
    expect(opsOf(w, 'ORDER_AUTHORIZE')[0]).toMatchObject({ status: 'UNKNOWN', prior_unknown: 1, result_external_id: null });
    expect(opsOf(w, 'ORDER_AUTHORIZE')[0]!.last_error_class).toMatch(/^UNIDENTIFIED:/);
    w.clock.advance(10_000);
    await ex.processDue();
    expect(posts(w, 'ORDER_AUTHORIZE')).toHaveLength(1);
    expectCompletedSwap(w, expect);
  });

  it('an authorization whose order shows another payee is held for the owner, not captured', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    w.start(ex);
    const o = await ex.createOrder(w.caseId);
    if (!o.ok) throw new Error('order');
    w.server.approveOrder(o.orderId);
    w.faulty.rewrite('ORDER_GET', (j) => {
      (j.purchase_units as Array<{ payee: unknown }>)[0]!.payee = { merchant_id: 'SOMEONEELSE' };
      return j;
    });
    expect(await ex.onBuyerApproved(w.caseId)).toEqual({ ok: true, status: 'PAYMENT_STARTED' });
    expect(opsOf(w, 'ORDER_AUTHORIZE')[0]).toMatchObject({ status: 'SUCCEEDED', reconcile_status: 'AWAITING', last_error_class: 'MISMATCH:payee' });
    expect(chargeAttempt(w).status).toBe('ORDER_CREATED');
    await ex.advance(w.caseId);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(0);
  });
});

describe('DESIGN 7.2: leases and forward-only results', () => {
  it('an answer that arrives after the lease expired is ignored; the new holder recovered by querying', async () => {
    const w = await swapWorld({ timeoutMs: 5_000 });
    const x = w.exec({ owner: 'exec-X' });
    await toAuthorized(w, x);
    const gate = w.faulty.hold('AUTH_CAPTURE', 'RESPONSE');
    const slow = x.advance(w.caseId);
    await gate.arrived; // PayPal has captured; X's answer is still on the way
    w.clock.advance(61_000);
    const y = w.exec({ owner: 'exec-Y' });
    await y.recover();
    expectCompletedSwap(w, expect);
    gate.release();
    await slow;
    expectCompletedSwap(w, expect);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
    expect(audits(w, 'STALE_RESULT_IGNORED').map((a) => a.opKind)).toContain('AUTH_CAPTURE');
  });

  it('a late PENDING query result never moves a COMPLETED refund back', async () => {
    const w = await swapWorld({ timeoutMs: 5_000 });
    const x = w.exec({ owner: 'exec-X' });
    await toAuthorized(w, x);
    w.server.inject('CAPTURE_REFUND', { type: 'PENDING' });
    expect(await x.advance(w.caseId)).toBe('REFUND_PENDING');
    const refund = opsOf(w, 'CAPTURE_REFUND')[0]!;
    w.clock.advance(10_000);
    const gate = w.faulty.hold('REFUND_GET', 'RESPONSE'); // Q1 is answered PENDING now, delivered later
    const slow = x.processDue();
    await gate.arrived;
    w.server.settle(refund.result_external_id!, 'COMPLETED');
    w.clock.advance(61_000);
    await w.exec({ owner: 'exec-Y' }).processDue(); // Q2: COMPLETED
    expect(caseStatus(w)).toBe('COMPLETED');
    gate.release();
    await slow;
    expect(getOp(w.db, 'payment_operations', refund.id)).toMatchObject({ status: 'SUCCEEDED', external_status: 'COMPLETED' });
    expectCompletedSwap(w, expect);
  });

  it('under a valid lease, a lower status or an older update_time is refused', async () => {
    const w = await swapWorld();
    const x = w.exec();
    await toAuthorized(w, x);
    w.server.inject('CAPTURE_REFUND', { type: 'PENDING' });
    await x.advance(w.caseId);
    const refund = opsOf(w, 'CAPTURE_REFUND')[0]!;
    const now = w.clock.now();
    immediate(w.db, () => {
      w.db.prepare("UPDATE payment_operations SET external_update_time = '2026-11-03T05:00:00Z' WHERE id = ?").run(refund.id);
      const lease = acquireLease(w.db, 'payment_operations', refund.id, 'test', now)!;
      expect(writeUnderLease(w.db, lease, { status: 'UNKNOWN' }, now, true)).toBe('REGRESSION');
      expect(writeUnderLease(w.db, lease, { status: 'SUCCEEDED', external_update_time: '2026-11-03T04:00:00Z' }, now, true)).toBe('REGRESSION');
      expect(writeUnderLease(w.db, { ...lease, gen: lease.gen - 1 }, { status: 'SUCCEEDED' }, now)).toBe('LEASE_LOST');
      expect(writeUnderLease(w.db, lease, { status: 'SUCCEEDED', external_update_time: '2026-11-03T06:00:00Z' }, now)).toBe('WRITTEN');
    });
    expect(() => w.db.prepare("UPDATE payment_operations SET status = 'PENDING' WHERE id = ?").run(refund.id)).toThrow('OPERATION_STATUS_REGRESSION');
  });

  it('a second executor cannot take an operation whose lease is live', async () => {
    const w = await swapWorld({ timeoutMs: 5_000 });
    const x = w.exec({ owner: 'exec-X' });
    await toAuthorized(w, x);
    const gate = w.faulty.hold('AUTH_CAPTURE', 'REQUEST');
    const slow = x.advance(w.caseId);
    await gate.arrived;
    const report = await w.exec({ owner: 'exec-Y' }).recover();
    expect(report.recovered).toEqual([]); // the SENDING row is leased by X, so it is not even picked up
    expect(await w.exec({ owner: 'exec-Y' }).advance(w.caseId)).toBe('CAPTURING');
    gate.release();
    await slow;
    expectCompletedSwap(w, expect);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
  });
});

describe('DESIGN 6.3 item 8 (I07): unknown order creation left on an EXPIRED attempt', () => {
  it('without an order id: left out of the scan and audited; nothing is resent', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('after-sending-saved', kindIs('ORDER_CREATE')) });
    w.start(ex);
    await expect(ex.createOrder(w.caseId)).rejects.toThrow(SimulatedCrash);
    const create = opsOf(w)[0]!;
    expect(create.status).toBe('SENDING');
    w.clock.advance(16 * 60_000);
    const ex2 = w.exec({ owner: 'exec-2' });
    expect(ex2.expireAttempts()).toEqual([chargeAttempt(w).id]);
    expect([caseStatus(w), holdStatus(w), obligation(w, 'B_CHARGE')?.status]).toEqual(['EXPIRED', 'RELEASED', 'CANCELLED']);
    const report = await ex2.recover();
    expect(report).toEqual({ recovered: [], excluded: [create.id], busy: [] });
    await ex2.processDue();
    // Even a direct request (B reloads the page) does not touch the excluded row.
    expect(await ex2.createOrder(w.caseId)).toEqual({ ok: false, reason: 'ORDER_CREATE_UNCONFIRMED' });
    expect(posts(w, 'ORDER_CREATE')).toHaveLength(0);
    expect(getOp(w.db, 'payment_operations', create.id)).toMatchObject({ status: 'SENDING', last_error_class: null, prior_unknown: 0, lease_owner: 'exec-1' });
    expect(audits(w, 'RECOVERY_EXCLUDED')).toEqual([{ opId: create.id, opKind: 'ORDER_CREATE', reason: 'ATTEMPT_EXPIRED_WITHOUT_ORDER_ID' }]);
  });

  it('with an order id: queried, not resent; an order without money just closes the operation', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    w.start(ex);
    w.faulty.rewrite('ORDER_CREATE', (j) => ({ ...j, status: 'SOMETHING_NEW' }));
    await ex.createOrder(w.caseId);
    w.faulty.clearRewrite('ORDER_CREATE');
    const create = opsOf(w)[0]!;
    expect(create).toMatchObject({ status: 'UNKNOWN', last_error_class: 'UNEXPECTED_STATUS:SOMETHING_NEW' });
    expect(create.result_external_id).toMatch(/^MOCK-ORDER-/);
    w.clock.advance(16 * 60_000);
    ex.expireAttempts();
    await w.exec({ owner: 'exec-2' }).recover();
    expect(posts(w, 'ORDER_CREATE')).toHaveLength(1);
    expect(getOp(w.db, 'payment_operations', create.id)).toMatchObject({ status: 'SUCCEEDED', external_status: 'PAYER_ACTION_REQUIRED' });
    expect(obligation(w, 'B_AUTH_VOID')).toBeUndefined();
    expect(caseStatus(w)).toBe('EXPIRED');
  });

  it('with an order id and an authorization found on it (should not happen): voided and shown to the owner', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    w.start(ex);
    w.faulty.rewrite('ORDER_CREATE', (j) => ({ ...j, status: 'SOMETHING_NEW' }));
    await ex.createOrder(w.caseId);
    w.faulty.clearRewrite('ORDER_CREATE');
    const orderId = opsOf(w)[0]!.result_external_id!;
    w.clock.advance(16 * 60_000);
    ex.expireAttempts();
    // Someone authorizes the ended attempt's order outside FlexSlot.
    w.server.approveOrder(orderId);
    const outside = await w.paypal.authorizeOrder(orderId, { requestId: randomUUID() });
    expect(outside.kind).toBe('SUCCEEDED');
    const ex2 = w.exec({ owner: 'exec-2' });
    await ex2.recover();
    await ex2.processDue();
    expect(audits(w, 'ATTENTION').map((a) => a.reason)).toContain('MONEY_ON_ENDED_ATTEMPT');
    expect(obligation(w, 'B_AUTH_VOID')?.status).toBe('SETTLED');
    if (outside.kind === 'SUCCEEDED') expect(w.server.statusOf(outside.resource.authorization.id)).toBe('VOIDED');
    expect(caseStatus(w)).toBe('EXPIRED');
    expect(posts(w, 'ORDER_AUTHORIZE')).toHaveLength(1); // only the outside one
  });
});

describe('DESIGN 7.5: the stored hash is checked before any send', () => {
  it('a request whose stored input no longer matches its hash is not sent and is held for the owner', async () => {
    const w = await swapWorld();
    const ex = w.exec({ hooks: crashAt('after-e7') });
    await toAuthorized(w, ex);
    await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
    const refund = opsOf(w, 'CAPTURE_REFUND')[0]!;
    // The schema forbids changing a stored request; drop that guard to simulate corruption.
    w.db.exec('DROP TRIGGER payment_operations_request_immutable');
    w.db.prepare('UPDATE payment_operations SET request_json = ? WHERE id = ?').run(JSON.stringify({ amount: { currency: 'USD', minor: 2000 } }), refund.id);
    await restart(w).recover();
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(0);
    expect(getOp(w.db, 'payment_operations', refund.id)).toMatchObject({ status: 'PREPARED', last_error_class: 'HOLD:HASH_MISMATCH' });
    expect(obligation(w, 'A_COMPENSATION_REFUND')?.status).toBe('NEEDS_ATTENTION');
  });

  it('the schema refuses to change a stored request, its id or an identified resource', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    await toAuthorized(w, ex);
    const auth = opsOf(w, 'ORDER_AUTHORIZE')[0]!;
    for (const sql of [
      'UPDATE payment_operations SET request_hash = ? WHERE id = ?',
      'UPDATE payment_operations SET paypal_request_id = ? WHERE id = ?',
      'UPDATE payment_operations SET result_external_id = ? WHERE id = ?',
      'UPDATE payment_operations SET target_external_id = ? WHERE id = ?',
    ]) {
      expect(() => w.db.prepare(sql).run('f'.repeat(64), auth.id)).toThrow('OPERATION_IMMUTABLE');
    }
  });
});

describe('AC10: restart at every crash point in turn', () => {
  it('reaches the same single, consistent result', async () => {
    const w = await swapWorld();
    const points = ['after-sending-saved', 'after-send', 'after-result-saved', 'after-query', 'before-e7', 'after-e7'] as const;
    let crashes = 0;
    let ex = w.exec({ hooks: crashAt('after-send', kindIs('ORDER_CREATE')) });
    w.start(ex);
    await expect(ex.createOrder(w.caseId)).rejects.toThrow(SimulatedCrash);
    crashes++;
    for (const point of points) {
      w.clock.advance(61_000);
      ex = w.exec({ owner: `exec-${point}`, hooks: crashAt(point) });
      try {
        await ex.recover();
        const create = opsOf(w, 'ORDER_CREATE')[0]!;
        if (create.status === 'SUCCEEDED' && chargeAttempt(w).status === 'ORDER_CREATED') {
          if (w.server.statusOf(create.result_external_id!) !== 'APPROVED' && w.server.statusOf(create.result_external_id!) !== 'COMPLETED') {
            w.server.approveOrder(create.result_external_id!);
          }
          await ex.onBuyerApproved(w.caseId);
        }
        await ex.advance(w.caseId);
      } catch (e) {
        if (!(e instanceof SimulatedCrash)) throw e;
        crashes++;
      }
    }
    w.clock.advance(61_000);
    const last = w.exec({ owner: 'exec-final' });
    await last.recover();
    if (chargeAttempt(w).status === 'ORDER_CREATED') {
      await last.onBuyerApproved(w.caseId);
      await last.advance(w.caseId);
    }
    expect(crashes).toBeGreaterThanOrEqual(5);
    expectCompletedSwap(w, expect);
    expect(opsOf(w).map((o) => o.op_kind)).toEqual(['ORDER_CREATE', 'ORDER_AUTHORIZE', 'AUTH_CAPTURE', 'CAPTURE_REFUND']);
  });
});

/** The newest MOCK order id (the mock numbers its ids in creation order). */
function lastOrderId(w: SwapWorld): string {
  for (let n = 50; n > 0; n--) {
    const id = `MOCK-ORDER-${String(n).padStart(6, '0')}`;
    if (w.server.statusOf(id)) return id;
  }
  throw new Error('no order');
}

function lastCaptureId(w: SwapWorld): string {
  for (let n = 50; n > 0; n--) {
    const id = `MOCK-CAPTURE-${String(n).padStart(6, '0')}`;
    if (w.server.statusOf(id)) return id;
  }
  throw new Error('no capture');
}
