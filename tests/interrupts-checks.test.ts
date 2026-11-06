// IR2-02 (Codex): the interruption report must fail on inconsistent facts, not only pass on good ones. These are the
// report's own rules (scripts/verify/interrupts-checks.ts) fed with hand-made facts; no database, no network.

import { describe, expect, it } from 'vitest';
import { evaluate, type Facts, type Outcome } from '../scripts/verify/interrupts-checks.ts';

const USD = (minor: number) => ({ minor, currency: 'USD' });
const ORIGIN: [number, number] = [1_000, 2_000];
const DEST: [number, number] = [5_000, 6_000];

function good(outcome: Outcome): Facts {
  const swap = outcome === 'SWAP_COMPLETED';
  const bRefunded = outcome === 'B_REFUNDED';
  const voided = outcome === 'AUTH_VOIDED';
  const ops: Facts['ops'] = [
    { obligation: 'B_CHARGE', kind: 'ORDER_CREATE', status: 'SUCCEEDED', sends: 1, rid: 'r-order', res: 'ORDER-B' },
    { obligation: 'B_CHARGE', kind: 'ORDER_AUTHORIZE', status: 'SUCCEEDED', sends: 1, rid: 'r-auth', res: 'AUTH-B' },
    ...(voided ? [] : [{ obligation: 'B_CHARGE', kind: 'AUTH_CAPTURE', status: 'SUCCEEDED', sends: 1, rid: 'r-cap', res: 'CAP-B' }]),
    ...(swap ? [{ obligation: 'A_COMPENSATION_REFUND', kind: 'CAPTURE_REFUND', status: 'SUCCEEDED', sends: 2, rid: 'r-ref', res: 'REF-A' }] : []),
    ...(bRefunded ? [{ obligation: 'B_RECOVERY_REFUND', kind: 'CAPTURE_REFUND', status: 'SUCCEEDED', sends: 1, rid: 'r-bref', res: 'REF-B' }] : []),
    ...(voided ? [{ obligation: 'B_AUTH_VOID', kind: 'AUTH_VOID', status: 'SUCCEEDED', sends: 1, rid: 'r-void', res: 'AUTH-B' }] : []),
  ];
  return {
    outcome,
    caseStatus: swap ? 'COMPLETED' : bRefunded ? 'COMPENSATED' : 'REJECTED',
    terms: { aCaptureId: 'CAP-A', bPrice: USD(6000), aComp: USD(1000), origin: ORIGIN, dest: DEST, bSlot: ORIGIN },
    obligations: [
      { kind: 'B_CHARGE', status: voided ? 'CANCELLED' : 'SETTLED', amount: USD(6000), target: null },
      ...(swap ? [{ kind: 'A_COMPENSATION_REFUND', status: 'SETTLED', amount: USD(1000), target: 'CAP-A' }] : []),
      ...(bRefunded ? [{ kind: 'B_RECOVERY_REFUND', status: 'SETTLED', amount: USD(6000), target: 'CAP-B' }] : []),
      ...(voided ? [{ kind: 'B_AUTH_VOID', status: 'SETTLED', amount: USD(6000), target: 'AUTH-B' }] : []),
    ],
    ops,
    aOps: [
      { kind: 'ORDER_CREATE', rid: 'r-a-order' },
      { kind: 'ORDER_CAPTURE', rid: 'r-a-cap' },
    ],
    posts: [
      { route: 'ORDER_CAPTURE', rid: 'r-a-cap', sent: true },
      ...ops.flatMap((o) => Array.from({ length: o.sends }, () => ({ route: o.kind, rid: o.rid, sent: true }))),
    ],
    aBooking: { start: swap ? DEST[0] : ORIGIN[0], end: swap ? DEST[1] : ORIGIN[1], status: 'CONFIRMED' },
    bBooking: swap ? { start: ORIGIN[0], end: ORIGIN[1], status: 'CONFIRMED' } : null,
    grants: swap ? 1 : 0,
    paypal: {
      bOrder: {
        ok: true,
        value: {
          auths: [{ id: 'AUTH-B', status: voided ? 'VOIDED' : 'CAPTURED', amount: USD(6000) }],
          caps: voided ? [] : [{ id: 'CAP-B', status: bRefunded ? 'REFUNDED' : 'COMPLETED', amount: USD(6000) }],
          refunds: bRefunded ? [{ id: 'REF-B' }] : [],
        },
      },
      aOrderRefunds: { ok: true, value: swap ? [{ id: 'REF-A' }] : [] },
      aCapture: { ok: true, value: { status: swap ? 'PARTIALLY_REFUNDED' : 'COMPLETED' } },
      refunds: {
        ...(swap ? { 'REF-A': { ok: true as const, value: { status: 'COMPLETED', amount: USD(1000), parentCapture: 'CAP-A' } } } : {}),
        ...(bRefunded ? { 'REF-B': { ok: true as const, value: { status: 'COMPLETED', amount: USD(6000), parentCapture: 'CAP-B' } } } : {}),
      },
    },
  };
}

const failed = (f: Facts) => evaluate(f).filter((c) => !c.ok).map((c) => c.name);

describe('interruption report rules', () => {
  it.each(['SWAP_COMPLETED', 'B_REFUNDED', 'AUTH_VOIDED'] as const)('consistent facts pass (%s)', (outcome) => {
    expect(failed(good(outcome))).toEqual([]);
  });

  const cases: Array<[string, (f: Facts) => void, RegExp]> = [
    ['refund GET not found', (f) => (f.paypal.refunds['REF-A'] = { ok: false, why: 'NOT_FOUND' }), /refund is COMPLETED.*NOT_FOUND/],
    ['refund GET pending', (f) => (f.paypal.refunds['REF-A'] = { ok: true, value: { status: 'PENDING', amount: USD(1000), parentCapture: 'CAP-A' } }), /refund is COMPLETED/],
    ['refund in another currency and amount', (f) => (f.paypal.refunds['REF-A'] = { ok: true, value: { status: 'COMPLETED', amount: { minor: 100, currency: 'EUR' }, parentCapture: 'CAP-A' } }), /refund is COMPLETED/],
    ['refund of another capture', (f) => (f.paypal.refunds['REF-A'] = { ok: true, value: { status: 'COMPLETED', amount: USD(1000), parentCapture: 'CAP-OTHER' } }), /refund is COMPLETED/],
    ['refund without a parent link', (f) => (f.paypal.refunds['REF-A'] = { ok: true, value: { status: 'COMPLETED', amount: USD(1000), parentCapture: null } }), /refund is COMPLETED/],
    ["B's booking cancelled", (f) => (f.bBooking = { ...f.bBooking!, status: 'CANCELLED' }), /booking/],
    ["A's booking not moved", (f) => (f.aBooking = { start: ORIGIN[0], end: ORIGIN[1], status: 'CONFIRMED' }), /booking/],
    ['refund POST with the order-create request id', (f) => (f.posts = f.posts.map((p) => (p.route === 'CAPTURE_REFUND' ? { ...p, rid: 'r-order' } : p))), /same kind/],
    ['a POST logged more often than recorded', (f) => f.posts.push({ route: 'AUTH_CAPTURE', rid: 'r-cap', sent: true }), /more often/],
    ["B's order query failed", (f) => (f.paypal.bOrder = { ok: false, why: 'TRANSPORT_ERROR' }), /queried at PayPal|lists on the A and B orders/],
    ["A's capture query failed", (f) => (f.paypal.aCapture = { ok: false, why: 'NOT_FOUND' }), /original capture/],
    ['an extra refund listed on the A order', (f) => (f.paypal.aOrderRefunds = { ok: true, value: [{ id: 'REF-A' }, { id: 'REF-X' }] }), /none extra/],
    ['the same refund listed twice', (f) => (f.paypal.aOrderRefunds = { ok: true, value: [{ id: 'REF-A' }, { id: 'REF-A' }] }), /none twice/],
    ['A order refund list query failed', (f) => (f.paypal.aOrderRefunds = { ok: false, why: 'NOT_FOUND' }), /lists on the A and B orders/],
    ['a second capture at PayPal', (f) => f.paypal.bOrder.ok && f.paypal.bOrder.value.caps.push({ id: 'CAP-B2', status: 'COMPLETED', amount: USD(6000) }), /one capture for B/],
    ['capture for another amount', (f) => f.paypal.bOrder.ok && (f.paypal.bOrder.value.caps[0]!.amount = USD(5000)), /one capture for B/],
    ['compensation refund obligation not settled', (f) => (f.obligations = f.obligations.map((o) => (o.kind === 'A_COMPENSATION_REFUND' ? { ...o, status: 'NEEDS_ATTENTION' } : o))), /compensation refund is SETTLED/],
    ['no compensation grant', (f) => (f.grants = 0), /compensation grant/],
    ['case not completed', (f) => (f.caseStatus = 'REFUND_PENDING'), /case status/],
  ];
  it.each(cases)('fails when: %s', (_name, mutate, expected) => {
    const f = good('SWAP_COMPLETED');
    mutate(f);
    const names = failed(f);
    expect(names.length).toBeGreaterThan(0);
    expect(names.some((n) => expected.test(n))).toBe(true);
  });

  it('fails E-R and E-V facts that do not match their outcome', () => {
    const r = good('B_REFUNDED');
    r.paypal.refunds['REF-B'] = { ok: true, value: { status: 'COMPLETED', amount: USD(6000), parentCapture: 'CAP-A' } };
    expect(failed(r).some((n) => /B_RECOVERY_REFUND/.test(n))).toBe(true);
    const v = good('AUTH_VOIDED');
    v.bBooking = { start: ORIGIN[0], end: ORIGIN[1], status: 'CONFIRMED' };
    expect(failed(v).some((n) => /no booking for B/.test(n))).toBe(true);
    const v2 = good('AUTH_VOIDED');
    v2.paypal.bOrder.ok && (v2.paypal.bOrder.value.auths[0]!.status = 'CREATED');
    expect(failed(v2).some((n) => /authorization for B/.test(n))).toBe(true);
  });
});
