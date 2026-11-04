// Executor: one swap from E1 to E8 on the mock PayPal, E1's re-checks, E-V and E-R (DESIGN 6.2, 8).
// Mock only; no external connection.

import { describe, expect, it } from 'vitest';
import { Executor } from '../src/executor/executor.ts';
import type { PayPalPort } from '../src/paypal/port.ts';
import { buildCreateOrder, type CreateOrderInput } from '../src/paypal/requests.ts';
import { at } from './helpers.ts';
import {
  caseStatus,
  chargeAttempt,
  e7Marker,
  expectCompletedSwap,
  holdStatus,
  obligation,
  opsOf,
  posts,
  swapWorld,
  toAuthorized,
} from './executor-helpers.ts';

describe('executor: one swap end to end (E1-E8)', () => {
  it('starts, authorizes, captures, reconciles, commits the booking and refunds A once', async () => {
    const w = await swapWorld();
    const ex = w.exec();

    // E1: frozen hold, B_CHARGE, attempt and the order-create operation, in one transaction.
    w.start(ex);
    expect(caseStatus(w)).toBe('PAYMENT_STARTED');
    expect(holdStatus(w)).toBe('FROZEN');
    expect(obligation(w, 'B_CHARGE')?.status).toBe('OPEN');
    const [create] = opsOf(w);
    expect(create).toMatchObject({ op_kind: 'ORDER_CREATE', status: 'PREPARED', result_external_id: null, target_external_id: null, sends: 0 });
    // DESIGN 6.1/7.5: before the send only the request id, the fixed input and its hash are stored.
    expect(create!.request_hash).toBe(buildCreateOrder(JSON.parse(create!.request_json) as CreateOrderInput).hash);
    expect(JSON.parse(create!.request_json)).toMatchObject({ intent: 'AUTHORIZE', customId: `case:C1:v1:att:${chargeAttempt(w).id}`, amount: { currency: 'USD', minor: 6000 } });

    // E2, E3, E4.
    const order = await ex.createOrder(w.caseId);
    expect(order.ok).toBe(true);
    expect(chargeAttempt(w).status).toBe('ORDER_CREATED');
    if (!order.ok) return;
    w.server.approveOrder(order.orderId);
    expect(await ex.onBuyerApproved(w.caseId)).toEqual({ ok: true, status: 'AUTHORIZED' });
    expect(obligation(w, 'B_CHARGE')?.status).toBe('OPEN');

    // E5-E8.
    expect(await ex.advance(w.caseId)).toBe('COMPLETED');
    expectCompletedSwap(w, expect);

    const ops = opsOf(w).map((o) => [o.op_kind, o.status, o.reconcile_status]);
    expect(ops).toEqual([
      ['ORDER_CREATE', 'SUCCEEDED', null],
      ['ORDER_AUTHORIZE', 'SUCCEEDED', 'MATCHED'],
      ['AUTH_CAPTURE', 'SUCCEEDED', 'MATCHED'],
      ['CAPTURE_REFUND', 'SUCCEEDED', null],
    ]);
    const capture = opsOf(w, 'AUTH_CAPTURE')[0]!;
    expect(obligation(w, 'B_CHARGE')?.settled_by_operation_id).toBe(capture.id);
    expect(new Set(opsOf(w).map((o) => o.paypal_request_id)).size).toBe(4);
    expect(w.db.prepare("SELECT capture_id, amount_minor, payee_merchant_id FROM payments WHERE kind = 'B_SWAP'").get()).toEqual({
      capture_id: capture.result_external_id,
      amount_minor: 6000,
      payee_merchant_id: 'MOCKMERCHANT01',
    });
    for (const route of ['ORDER_CREATE', 'ORDER_AUTHORIZE', 'AUTH_CAPTURE', 'CAPTURE_REFUND'] as const) expect(posts(w, route)).toHaveLength(1);
    // Every POST carries its own operation's request id.
    expect(posts(w, 'AUTH_CAPTURE')[0]!.requestId).toBe(capture.paypal_request_id);
  });

  it('does nothing more once completed', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    await toAuthorized(w, ex);
    await ex.advance(w.caseId);
    const before = w.server.requests.length;
    await ex.processDue();
    await ex.recover();
    expect(w.server.requests.length).toBe(before);
    expectCompletedSwap(w, expect);
  });
});

describe('executor: E1 re-checks everything before freezing (DESIGN 6.2)', () => {
  const start = (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor, over: Partial<{ version: number; termsHash: string; bPartyId: string }> = {}) =>
    ex.startPayment({ caseId: w.caseId, version: 1, termsHash: w.termsHash, bPartyId: w.ids.customerBId, ...over });

  it.each([
    ['TERMS_CHANGED', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => start(w, ex, { version: 2 })],
    ['TERMS_CHANGED', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => start(w, ex, { termsHash: '0'.repeat(64) })],
    ['NOT_B', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => start(w, ex, { bPartyId: w.ids.customerAId })],
    ['PAYEE_NOT_SET', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => {
      w.db.prepare('UPDATE shops SET expected_payee_merchant_id = NULL').run();
      return start(w, ex);
    }],
    ['PAYEE_CHANGED', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => {
      w.db.prepare("UPDATE shops SET expected_payee_merchant_id = 'OTHERMERCHANT'").run();
      return start(w, ex);
    }],
    ['NOT_APPROVED', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => {
      w.db.prepare("DELETE FROM approvals WHERE role = 'OWNER'").run();
      return start(w, ex);
    }],
    ['HOLD_INVALID', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => {
      w.clock.advance(30 * 60_000); // the ACTIVE hold's expiry (offer still valid)
      return start(w, ex);
    }],
    ['A_PAYMENT_NOT_CONFIRMED', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => {
      w.db.prepare('UPDATE payments SET verified_at = NULL').run();
      return start(w, ex);
    }],
    ['A_BOOKING_CHANGED', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => {
      w.db.prepare('UPDATE bookings SET version = 2 WHERE id = ?').run(w.ids.aBookingId);
      return start(w, ex);
    }],
    ['OFFER_EXPIRED', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => {
      w.clock.advance(3 * 3_600_000);
      return start(w, ex);
    }],
    ['TERMS_INVALID', (w: Awaited<ReturnType<typeof swapWorld>>, ex: Executor) => {
      w.db.prepare('UPDATE swap_cases SET b_price_minor = 5000').run(); // column no longer matches the snapshot
      return start(w, ex);
    }],
  ])('refuses with %s and changes nothing', async (reason, act) => {
    const w = await swapWorld();
    const ex = w.exec();
    expect(act(w, ex)).toEqual({ ok: false, reason });
    expect(caseStatus(w)).toBe('A_ACCEPTED');
    expect(holdStatus(w)).toBe('ACTIVE');
    expect(w.db.prepare('SELECT count(*) AS n FROM money_obligations').get()).toEqual({ n: 0 });
  });

  it('refuses a port whose payment mode differs from the world (AC12)', async () => {
    const w = await swapWorld();
    const sandboxLike = { mode: 'SANDBOX' } as PayPalPort;
    const ex = new Executor({ db: w.db, paypal: sandboxLike, clock: w.clock });
    expect(ex.startPayment({ caseId: w.caseId, version: 1, termsHash: w.termsHash, bPartyId: w.ids.customerBId })).toEqual({ ok: false, reason: 'MODE_MISMATCH' });
  });
});

describe('executor: E5 failure voids the authorization (E-V)', () => {
  it('voids, confirms VOIDED by a query, releases the hold and rejects the case without capturing', async () => {
    const w = await swapWorld();
    const ex = w.exec();
    await toAuthorized(w, ex);
    w.db.prepare('UPDATE bookings SET version = 2 WHERE id = ?').run(w.ids.aBookingId); // A's booking changed before the capture
    expect(await ex.advance(w.caseId)).toBe('REJECTED');
    expect(posts(w, 'AUTH_CAPTURE')).toHaveLength(0);
    expect(posts(w, 'AUTH_VOID')).toHaveLength(1);
    expect(opsOf(w, 'AUTH_VOID')[0]).toMatchObject({ status: 'SUCCEEDED', reconcile_status: 'MATCHED' });
    expect(obligation(w, 'B_AUTH_VOID')?.status).toBe('SETTLED');
    expect(obligation(w, 'B_CHARGE')?.status).toBe('CANCELLED');
    expect(chargeAttempt(w).status).toBe('FAILED');
    expect(holdStatus(w)).toBe('RELEASED');
    const auth = opsOf(w, 'ORDER_AUTHORIZE')[0]!.result_external_id!;
    expect(w.server.statusOf(auth)).toBe('VOIDED');
    expect(e7Marker(w)).toEqual({ grant: false, refundObligation: false, bBooking: false });
  });
});

describe('executor: E7 definitively impossible refunds B in full (E-R)', () => {
  it('keeps A in the original slot, starts no compensation and refunds the whole capture', async () => {
    const w = await swapWorld();
    const ex = w.exec({
      hooks: {
        at(point) {
          // Right before E7, A's booking is changed underneath (stands in for any definitive DB refusal).
          if (point === 'before-e7') w.db.prepare('UPDATE bookings SET version = 3 WHERE id = ?').run(w.ids.aBookingId);
        },
      },
    });
    await toAuthorized(w, ex);
    expect(await ex.advance(w.caseId)).toBe('COMPENSATED');
    const recovery = obligation(w, 'B_RECOVERY_REFUND')!;
    expect(recovery).toMatchObject({ status: 'SETTLED', amount_minor: 6000 });
    expect(e7Marker(w)).toEqual({ grant: false, refundObligation: false, bBooking: false });
    expect(w.db.prepare('SELECT start_ms FROM bookings WHERE id = ?').get(w.ids.aBookingId)).toEqual({ start_ms: at('2026-11-07', '14:00') });
    expect(holdStatus(w)).toBe('RELEASED');
    const bCapture = opsOf(w, 'AUTH_CAPTURE')[0]!.result_external_id!;
    expect(w.server.statusOf(bCapture)).toBe('REFUNDED');
    expect(w.server.statusOf(w.aCaptureId)).toBe('COMPLETED');
  });
});
