// AC05: B's payment deadline against the start of the authorization (DESIGN 6.3, D12, DR1-01).
// AC06: concurrent requests to E1 and E4, and leases between executors. Mock only.

import { describe, expect, it } from 'vitest';
import {
  caseStatus,
  chargeAttempt,
  expectCompletedSwap,
  holdStatus,
  obligation,
  opsOf,
  posts,
  swapWorld,
  toAuthorized,
  type SwapWorld,
} from './executor-helpers.ts';
import type { Executor } from '../src/executor/executor.ts';

async function ordered(w: SwapWorld, ex: Executor): Promise<string> {
  w.start(ex);
  const o = await ex.createOrder(w.caseId);
  if (!o.ok) throw new Error(o.reason);
  return o.orderId;
}

describe('AC05: payment deadline (DESIGN 6.3)', () => {
  it('ends an attempt that never started an authorization, releases the hold, and refuses a late approval', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    const orderId = await ordered(w, ex);
    w.clock.set(chargeAttempt(w).expires_at);
    expect(ex.expireAttempts()).toEqual([chargeAttempt(w).id]);
    expect([chargeAttempt(w).status, caseStatus(w), holdStatus(w), obligation(w, 'B_CHARGE')?.status]).toEqual(['EXPIRED', 'EXPIRED', 'RELEASED', 'CANCELLED']);
    // B approves on an old PayPal page afterwards: FlexSlot never authorizes, so no money moves (6.3 item 4).
    w.server.approveOrder(orderId);
    expect(await ex.onBuyerApproved(w.caseId)).toEqual({ ok: false, reason: 'PAYMENT_EXPIRED' });
    await ex.processDue();
    expect(posts(w, 'ORDER_AUTHORIZE')).toHaveLength(0);
    expect(w.server.count('authorizations')).toBe(0);
    // The A booking is free for a new case (the partial unique index only counts unfinished cases).
    expect(w.db.prepare("SELECT count(*) AS n FROM swap_cases WHERE a_booking_id = ? AND status NOT IN ('COMPLETED','REJECTED','EXPIRED','COMPENSATED')").get(w.ids.aBookingId)).toEqual({ n: 0 });
  });

  it('is exact at the boundary: valid while now < expires_at', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    const orderId = await ordered(w, ex);
    w.server.approveOrder(orderId);
    w.clock.set(chargeAttempt(w).expires_at - 1);
    expect(ex.expireAttempts()).toEqual([]);
    expect(await ex.onBuyerApproved(w.caseId)).toEqual({ ok: true, status: 'AUTHORIZED' });

    const w2 = await swapWorld();
    const ex2 = w2.exec();
    const order2 = await ordered(w2, ex2);
    w2.server.approveOrder(order2);
    w2.clock.set(chargeAttempt(w2).expires_at); // the sweeper has not run yet
    expect(await ex2.onBuyerApproved(w2.caseId)).toEqual({ ok: false, reason: 'PAYMENT_EXPIRED' });
    expect(posts(w2, 'ORDER_AUTHORIZE')).toHaveLength(0);
  });

  it('the authorization recorded first wins: an authorize in flight is never cut off by the deadline', async () => {
    const w = await swapWorld({ timeoutMs: 5_000 });
    const ex = w.exec();
    const orderId = await ordered(w, ex);
    w.server.approveOrder(orderId);
    w.clock.set(chargeAttempt(w).expires_at - 1);
    const gate = w.faulty.hold('ORDER_AUTHORIZE', 'REQUEST');
    const inFlight = ex.onBuyerApproved(w.caseId); // SENDING is committed before the POST
    await gate.arrived;
    w.clock.advance(5 * 60_000);
    expect(ex.expireAttempts()).toEqual([]);
    expect(holdStatus(w)).toBe('FROZEN');
    gate.release();
    expect(await inFlight).toEqual({ ok: true, status: 'AUTHORIZED' });
    expect(await ex.advance(w.caseId)).toBe('COMPLETED');
  });

  it('the deadline recorded first wins: a concurrent approval at the deadline is refused', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    const orderId = await ordered(w, ex);
    w.server.approveOrder(orderId);
    w.clock.set(chargeAttempt(w).expires_at);
    const [expired, approved] = await Promise.all([Promise.resolve().then(() => ex.expireAttempts()), ex.onBuyerApproved(w.caseId)]);
    expect(approved).toEqual({ ok: false, reason: 'PAYMENT_EXPIRED' });
    expect(expired).toEqual([chargeAttempt(w).id]);
    expect(opsOf(w, 'ORDER_AUTHORIZE')).toHaveLength(0);
  });

  it('an unknown authorization keeps the attempt alive past the deadline and is recovered by a query', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    const orderId = await ordered(w, ex);
    w.server.approveOrder(orderId);
    w.server.inject('ORDER_AUTHORIZE', { type: 'TIMEOUT', processed: true });
    expect(await ex.onBuyerApproved(w.caseId)).toEqual({ ok: true, status: 'PAYMENT_STARTED' });
    expect(opsOf(w, 'ORDER_AUTHORIZE')[0]).toMatchObject({ status: 'UNKNOWN', last_error_class: 'TIMEOUT' });
    w.clock.set(chargeAttempt(w).expires_at + 60_000);
    expect(ex.expireAttempts()).toEqual([]); // 6.3 item 3; the I07 exclusion does not extend to authorizations
    const report = await w.exec({ owner: 'exec-2' }).recover();
    expect(report.recovered).toEqual([opsOf(w, 'ORDER_AUTHORIZE')[0]!.id]);
    expect(posts(w, 'ORDER_AUTHORIZE')).toHaveLength(1);
    expectCompletedSwap(w, expect);
  });

  it('an authorize that PayPal did not accept (order not approved) lets B approve and authorize again, or the attempt expire', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    const orderId = await ordered(w, ex);
    expect(await ex.onBuyerApproved(w.caseId)).toEqual({ ok: true, status: 'PAYMENT_STARTED' }); // too early
    const first = opsOf(w, 'ORDER_AUTHORIZE')[0]!;
    expect(first.status).toBe('NOT_ACCEPTED');
    w.server.approveOrder(orderId);
    expect(await ex.onBuyerApproved(w.caseId)).toEqual({ ok: true, status: 'AUTHORIZED' });
    const second = opsOf(w, 'ORDER_AUTHORIZE')[1]!;
    expect(second).toMatchObject({ op_seq: 2, previous_operation_id: first.id, status: 'SUCCEEDED' });
    expect(second.paypal_request_id).not.toBe(first.paypal_request_id);

    const w2 = await swapWorld();
    const ex2 = w2.exec();
    await ordered(w2, ex2);
    await ex2.onBuyerApproved(w2.caseId); // NOT_ACCEPTED: nothing was authorized
    w2.clock.set(chargeAttempt(w2).expires_at);
    expect(ex2.expireAttempts()).toEqual([chargeAttempt(w2).id]);
  });
});

describe('AC06: concurrent requests (DESIGN 6.2, 7.5)', () => {
  it('E1: of two concurrent starts exactly one gets the execution right', async () => {
    const w = await swapWorld();
    const req = { caseId: w.caseId, version: 1, termsHash: w.termsHash, bPartyId: w.ids.customerBId };
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => w.exec({ owner: 'x' }).startPayment(req)),
      Promise.resolve().then(() => w.exec({ owner: 'y' }).startPayment(req)),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, reason: 'ALREADY_STARTED' });
    expect(w.db.prepare('SELECT count(*) AS n FROM money_obligations').get()).toEqual({ n: 1 });
    expect(opsOf(w)).toHaveLength(1);
  });

  it('E4: browser signal, webhook and the queue at once send one authorize', async () => {
    const w = await swapWorld();
    const x = w.exec({ owner: 'browser' });
    const orderId = await ordered(w, x);
    w.server.approveOrder(orderId);
    const y = w.exec({ owner: 'webhook' });
    const z = w.exec({ owner: 'queue' });
    const results = await Promise.all([x.onBuyerApproved(w.caseId), y.onBuyerApproved(w.caseId), z.processDue(), x.onBuyerApproved(w.caseId)]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: true });
    expect(posts(w, 'ORDER_AUTHORIZE')).toHaveLength(1);
    expect(opsOf(w, 'ORDER_AUTHORIZE')).toHaveLength(1);
    expect(await x.advance(w.caseId)).toBe('COMPLETED');
  });

  it('two executors advancing the same case capture once and commit once', async () => {
    const w = await swapWorld();
    const x = w.exec({ owner: 'x' });
    await toAuthorized(w, x);
    const y = w.exec({ owner: 'y' });
    await Promise.all([x.advance(w.caseId), y.advance(w.caseId), y.processDue()]);
    await x.advance(w.caseId);
    expectCompletedSwap(w, expect);
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(1);
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(1);
    expect(opsOf(w, 'AUTH_CAPTURE')).toHaveLength(1);
  });
});
