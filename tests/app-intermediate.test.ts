// What the three screens show at the stop points of the Sandbox interruption checks R1 and R2 (mock AI, mock PayPal
// only; the Sandbox runs themselves are recorded in STATUS). Codex asked that a state in between is never shown as
// completed: each snapshot below is taken while the flow is stopped or waiting, before anything resumes it.

import { describe, expect, it } from 'vitest';
import type { CrashPoint, ExecutorHooks, HookInfo } from '../src/executor/engine.ts';
import { SimulatedCrash } from './executor-helpers.ts';
import { aPaysMock, decisionOf, harness, intake, loggedIn, texts, type Harness } from './app-helpers.ts';

const AFTER_LEASE_MS = 61_000;

function stopper() {
  const s: { next: { point: CrashPoint; match: (i: HookInfo) => boolean } | null; fired: CrashPoint[] } = { next: null, fired: [] };
  const hooks: ExecutorHooks = {
    at(point, info) {
      if (s.next && s.next.point === point && s.next.match(info)) {
        s.next = null;
        s.fired.push(point);
        throw new SimulatedCrash(point);
      }
    },
  };
  return { s, hooks };
}

type World = Awaited<ReturnType<typeof loggedIn>>;

async function readyToPay(h: Harness) {
  const w = await loggedIn(h);
  const t = texts(w.baseDate);
  await aPaysMock(w.a);
  await intake(w.a, t.a, 'A');
  await intake(w.b, t.b, 'B');
  const cs = (await w.b.state()).cases[0];
  expect((await w.owner.post('cases/approve', decisionOf(cs))).status).toBe(200);
  expect((await w.a.post('cases/approve', decisionOf(cs))).status).toBe(200);
  const b = (await w.b.state()).cases[0];
  expect((await w.b.post('cases/pay', decisionOf(b))).json).toEqual({ approval: { kind: 'MOCK' } });
  return { w, t, caseId: cs.id as string };
}

/** The three screens' view of the case, as the browser receives it, plus A's booking time and the owner's lists. */
async function screens(w: World) {
  const [b, a, o] = [await w.b.state(), await w.a.state(), await w.owner.state()];
  const pick = (c: { status: string; statusLabel: string; steps: Record<string, { state: string; text: string } | string | null> }) => ({
    status: c.status,
    label: c.statusLabel,
    bPayment: (c.steps.bPayment as { text: string }).text,
    aRefund: (c.steps.aRefund as { text: string }).text,
    bookings: c.steps.bookings as string,
  });
  return { b: pick(b.cases[0]), a: pick(a.cases[0]), owner: pick(o.cases[0]), aBookingTime: a.booking.time as string, ownerAttention: o.needsAttentionObligations as string[] };
}

/** Nothing on any screen claims more than has happened. */
function notCompleted(v: Awaited<ReturnType<typeof screens>>, origin: string) {
  for (const r of [v.b, v.a, v.owner]) {
    expect(r.label).not.toBe('Swap completed');
    expect(r.aRefund).not.toBe('Refunded');
  }
  if (v.b.bookings === 'Not changed') expect(v.aBookingTime).toBe(origin);
}

/** A restart: the stopped holder's lease runs out, then startup recovery and the queue run. */
async function restart(h: Harness, ticks = 0) {
  h.clock.advance(AFTER_LEASE_MS);
  // Startup recovery may itself reach the next stop point; that stop is the simulated process ending again.
  await h.executors.MOCK!.recover().catch((e: unknown) => {
    if (!(e instanceof SimulatedCrash)) throw e;
  });
  if (ticks) await h.ticks(ticks);
}

/**
 * Runs queue ticks one at a time until `done()` holds (at most `max`). In one test process the stopped executor
 * would carry on at its next tick, so each snapshot is taken right after the tick in which the stop happened.
 */
async function tickUntil(h: Harness, done: () => boolean, max = 12) {
  for (let i = 0; i < max && !done(); i++) await h.ticks(1);
  expect(done()).toBe(true);
}

describe('screens at the R1 stop points (capture answer lost, stops around E7, refund answer lost)', () => {
  it('shows each state in between as not completed, and completes once', async () => {
    const st = stopper();
    const h = harness({ hooks: st.hooks });
    const { w, t, caseId } = await readyToPay(h);
    const origin = `${t.aDay} 14:00–15:00`;

    // 1. The capture answer is lost (PayPal captured): the screens say it is being checked, not paid.
    h.mock.inject('AUTH_CAPTURE', { type: 'RESPONSE_LOST' });
    st.s.next = { point: 'before-e7', match: () => true };
    expect((await w.b.post('cases/mock-approve', { caseId })).status).toBe(200);
    await h.app.idle();
    let v = await screens(w);
    expect(v.b).toMatchObject({ status: 'PAYMENT_UNKNOWN', label: 'Checking the payment result', bPayment: 'Checking the payment result with PayPal', bookings: 'Not changed' });
    expect(v.owner.label).toBe('Checking the payment result');
    expect(v.a.label).toBe('Checking the payment result');
    notCompleted(v, origin);

    // 2. The query identifies the capture; the process stops before E7: paid, booking not yet changed.
    await tickUntil(h, () => st.s.fired.length === 1);
    expect(st.s.fired).toEqual(['before-e7']);
    v = await screens(w);
    expect(v.b).toMatchObject({ status: 'CAPTURED', label: 'Confirming the booking', bPayment: 'Paid', bookings: 'Not changed', aRefund: 'Not started' });
    expect(v.a).toMatchObject({ label: 'Confirming the booking', bookings: 'Not changed' });
    notCompleted(v, origin);

    // 3. Restart; stop right after E7: bookings changed, compensation refund not done.
    st.s.next = { point: 'after-e7', match: () => true };
    await restart(h);
    await tickUntil(h, () => st.s.fired.length === 2);
    expect(st.s.fired).toEqual(['before-e7', 'after-e7']);
    v = await screens(w);
    expect(v.b).toMatchObject({ status: 'BOOKING_COMMITTED', label: 'Booking changed · compensation refund pending', bookings: 'Changed: the existing booking moved and the new booking is confirmed' });
    expect(v.a).toMatchObject({ label: 'Booking changed · compensation refund pending', aRefund: 'Preparing the refund' });
    expect(v.aBookingTime).toBe(`${t.moveDay} 10:00–11:00`);
    notCompleted(v, origin);

    // 4. Restart; the refund answer is lost (PayPal refunded): still "pending", the refund is being checked.
    h.mock.inject('CAPTURE_REFUND', { type: 'RESPONSE_LOST' });
    await restart(h);
    await tickUntil(h, () => h.mock.requests.some((q) => q.route === 'CAPTURE_REFUND'));
    v = await screens(w);
    expect(v.a).toMatchObject({ status: 'REFUND_PENDING', label: 'Booking changed · compensation refund pending', aRefund: 'Checking the result with PayPal' });
    notCompleted(v, origin);

    // 5. Resent with the same request id; one refund at PayPal; then completed on all three screens.
    await h.ticks(10);
    v = await screens(w);
    for (const r of [v.b, v.a, v.owner]) expect(r).toMatchObject({ status: 'COMPLETED', label: 'Swap completed', bPayment: 'Paid', aRefund: 'Refunded' });
    const refunds = h.mock.requests.filter((q) => q.route === 'CAPTURE_REFUND');
    expect(new Set(refunds.map((q) => q.requestId)).size).toBe(1);
    expect(h.mock.requests.filter((q) => q.route === 'AUTH_CAPTURE')).toHaveLength(1);
  });
});

describe('screens at the R2 stop points (stopped before reconciliation, refund refused, owner recovery)', () => {
  it('shows "checking" and "needs attention" as such, and the owner recovery completes the swap', async () => {
    const st = stopper();
    const h = harness({ hooks: st.hooks });
    const { w, t, caseId } = await readyToPay(h);
    const origin = `${t.aDay} 14:00–15:00`;

    // 1. Stop right after the capture success is saved, before reconciliation.
    st.s.next = { point: 'after-result-saved', match: (i) => i.opKind === 'AUTH_CAPTURE' && i.reconcile === 'AWAITING' };
    expect((await w.b.post('cases/mock-approve', { caseId })).status).toBe(200);
    await h.app.idle();
    expect(st.s.fired).toEqual(['after-result-saved']);
    let v = await screens(w);
    expect(v.b).toMatchObject({ status: 'RECONCILING', label: 'Checking the payment result', bPayment: 'Checking the payment result with PayPal', bookings: 'Not changed' });
    notCompleted(v, origin);

    // 2. Restart: reconciled by a query, E7, then the refund is refused (422, not processed).
    h.mock.inject('CAPTURE_REFUND', { type: 'HTTP_ERROR', status: 422 });
    await restart(h, 5);
    v = await screens(w);
    expect(v.a).toMatchObject({ status: 'REFUND_FAILED', label: 'Booking changed · compensation refund needs attention', aRefund: 'Needs attention by the shop' });
    expect(v.b.label).toBe('Booking changed · compensation refund needs attention');
    expect(v.ownerAttention).toEqual(['A_COMPENSATION_REFUND']);
    notCompleted(v, origin);

    // 3. The owner recovers (same amount, new attempt): completed, the attention list is empty.
    const o = await w.owner.state();
    const ob = o.cases[0].obligations.find((x: { kind: string }) => x.kind === 'A_COMPENSATION_REFUND');
    expect((await w.owner.post('obligations/retry', { obligationId: ob.id })).status).toBe(200);
    // Codex P3: the owner's request is in the audit log as the owner's, besides the executor's OBLIGATION_RETRY.
    expect(
      h.db.prepare("SELECT actor, json_extract(detail_json, '$.accepted') AS accepted FROM audit_log WHERE action = 'OWNER_RECOVERY_REQUESTED'").all().map((r) => ({ ...r })),
    ).toEqual([{ actor: 'OWNER', accepted: 1 }]);
    await h.ticks(5);
    v = await screens(w);
    for (const r of [v.b, v.a, v.owner]) expect(r).toMatchObject({ status: 'COMPLETED', label: 'Swap completed', aRefund: 'Refunded' });
    expect(v.ownerAttention).toEqual([]);
  });
});
