// PENDING results and query timeouts, seen through the three screens (Codex: next step after the P2 fixes).
// Mock PayPal with injected faults only — labelled as such; the Sandbox cannot be made to answer PENDING on purpose.
// For each case: the screens never show it as done, FlexSlot only keeps querying (no new capture or refund), and once
// PayPal settles it the swap completes exactly once.

import { describe, expect, it } from 'vitest';
import { aPaysMock, decisionOf, harness, intake, loggedIn, texts, type Harness } from './app-helpers.ts';

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
  expect((await w.b.post('cases/pay', decisionOf((await w.b.state()).cases[0]))).status).toBe(200);
  return { w, caseId: cs.id as string };
}

const posts = (h: Harness, route: string) => h.mock.requests.filter((r) => r.route === route).length;

/** The three screens' case views (English and Japanese) plus the owner's attention lists. */
async function views(w: World) {
  const en = await Promise.all([w.b, w.a, w.owner].map(async (c) => (await c.state()).cases[0]));
  const ja = await Promise.all([w.b, w.a, w.owner].map(async (c) => (await c.get('state?lang=ja')).json.cases[0]));
  const owner = await w.owner.state();
  return { en, ja, owner };
}

function notDone(v: Awaited<ReturnType<typeof views>>) {
  for (const c of [...v.en, ...v.ja]) {
    expect(c.status).not.toBe('COMPLETED');
    expect(c.statusLabel).not.toMatch(/Swap completed|振替が完了しました/);
  }
}

describe('A compensation refund that PayPal reports as PENDING (mock, injected)', () => {
  it('shows pending on all screens, only queries (also through a query timeout), and completes once when PayPal completes it', async () => {
    const h = harness();
    const { w, caseId } = await readyToPay(h);
    h.mock.inject('CAPTURE_REFUND', { type: 'PENDING' });
    expect((await w.b.post('cases/mock-approve', { caseId })).status).toBe(200);
    await h.app.idle();
    await h.ticks(4);

    let v = await views(w);
    notDone(v);
    expect(v.en[1]).toMatchObject({ status: 'REFUND_PENDING', statusLabel: 'Booking changed · compensation refund pending', steps: { aRefund: { state: 'WORKING', text: 'PayPal reports it as pending; checking again' }, bookingsChanged: true } });
    expect(v.ja[1].steps.aRefund).toEqual({ state: 'WORKING', text: 'PayPalで保留中・再確認します' });
    expect(v.owner.stopped).toEqual([]);
    expect(v.owner.needsAttentionObligations).toEqual([]);
    expect(posts(h, 'CAPTURE_REFUND')).toBe(1);

    // The status queries time out twice (injected): still pending, still no new refund.
    const queriesBefore = posts(h, 'REFUND_GET');
    h.mock.inject('REFUND_GET', { type: 'TIMEOUT' }, 2);
    await h.ticks(8);
    expect(posts(h, 'REFUND_GET')).toBeGreaterThan(queriesBefore);
    v = await views(w);
    notDone(v);
    expect(v.en[1].steps.aRefund.text).toBe('PayPal reports it as pending; checking again');
    expect(posts(h, 'CAPTURE_REFUND')).toBe(1);

    // PayPal completes the refund later.
    const refundId = h.db.prepare("SELECT o.result_external_id AS id FROM payment_operations o WHERE o.op_kind = 'CAPTURE_REFUND'").get() as { id: string };
    h.mock.settle(refundId.id, 'COMPLETED');
    await h.ticks(8);
    v = await views(w);
    for (const c of v.en) expect(c).toMatchObject({ status: 'COMPLETED', statusLabel: 'Swap completed', steps: { aRefund: { state: 'DONE', text: 'Refunded' } } });
    for (const c of v.ja) expect(c.steps.aRefund).toEqual({ state: 'DONE', text: '返金済み' });
    expect(posts(h, 'CAPTURE_REFUND')).toBe(1);
    expect(h.mock.count('refunds')).toBe(1);
    expect(h.db.prepare("SELECT count(*) AS n FROM compensation_grants").get()).toEqual({ n: 1 });
  });

  it('a pending refund that PayPal later fails needs the owner; Recover sends one new refund and the swap completes once', async () => {
    const h = harness();
    const { w, caseId } = await readyToPay(h);
    h.mock.inject('CAPTURE_REFUND', { type: 'PENDING' });
    expect((await w.b.post('cases/mock-approve', { caseId })).status).toBe(200);
    await h.app.idle();
    await h.ticks(4);
    const first = h.db.prepare("SELECT result_external_id AS id FROM payment_operations WHERE op_kind = 'CAPTURE_REFUND'").get() as { id: string };
    h.mock.settle(first.id, 'FAILED');
    await h.ticks(6);

    let v = await views(w);
    notDone(v);
    expect(v.en[1]).toMatchObject({ status: 'REFUND_FAILED', statusLabel: 'Booking changed · compensation refund needs attention', steps: { aRefund: { state: 'ATTENTION', text: 'Needs attention by the shop' } } });
    expect(v.ja[1].steps.aRefund).toEqual({ state: 'ATTENTION', text: 'お店の対応が必要' });
    expect(v.owner.needsAttentionObligations).toEqual(['A_COMPENSATION_REFUND']);
    const ob = v.owner.cases[0].obligations.find((o: { kind: string }) => o.kind === 'A_COMPENSATION_REFUND');
    expect(ob.retryable).toBe(true);
    // Nothing is sent again by itself.
    await h.ticks(6);
    expect(posts(h, 'CAPTURE_REFUND')).toBe(1);

    expect((await w.owner.post('obligations/retry', { obligationId: ob.id })).status).toBe(200);
    await h.ticks(6);
    v = await views(w);
    for (const c of v.en) expect(c).toMatchObject({ status: 'COMPLETED', steps: { aRefund: { state: 'DONE', text: 'Refunded' } } });
    expect(v.owner.needsAttentionObligations).toEqual([]);
    expect(posts(h, 'CAPTURE_REFUND')).toBe(2);
    const refunds = h.db.prepare("SELECT status, external_status FROM payment_operations WHERE op_kind = 'CAPTURE_REFUND' ORDER BY rowid").all().map((r) => ({ ...r }));
    expect(refunds).toEqual([
      { status: 'FAILED', external_status: 'FAILED' },
      { status: 'SUCCEEDED', external_status: 'COMPLETED' },
    ]);
    expect(h.mock.statusOf(first.id)).toBe('FAILED');
  });
});

describe("B's capture that PayPal reports as PENDING (mock, injected)", () => {
  it('keeps the bookings unchanged and shows pending until PayPal completes the capture; one capture only', async () => {
    const h = harness();
    const { w, caseId } = await readyToPay(h);
    const origin = (await w.a.state()).booking.time;
    h.mock.inject('AUTH_CAPTURE', { type: 'PENDING' });
    expect((await w.b.post('cases/mock-approve', { caseId })).status).toBe(200);
    await h.app.idle();
    await h.ticks(3);

    let v = await views(w);
    notDone(v);
    expect(v.en[0]).toMatchObject({ statusLabel: 'Confirming payment', steps: { bPayment: { state: 'WORKING', text: 'PayPal reports it as pending; checking again' }, bookingsChanged: false } });
    expect(v.ja[0].steps.bPayment).toEqual({ state: 'WORKING', text: 'PayPalで保留中・再確認します' });
    expect((await w.a.state()).booking.time).toBe(origin);

    // A capture query times out (injected): still pending, no second capture.
    h.mock.inject('CAPTURE_GET', { type: 'TIMEOUT' }, 2);
    await h.ticks(8);
    v = await views(w);
    notDone(v);
    expect(v.en[0].steps.bookingsChanged).toBe(false);
    expect(posts(h, 'AUTH_CAPTURE')).toBe(1);

    const cap = h.db.prepare("SELECT result_external_id AS id FROM payment_operations WHERE op_kind = 'AUTH_CAPTURE'").get() as { id: string };
    h.mock.settle(cap.id, 'COMPLETED');
    await h.ticks(10);
    v = await views(w);
    for (const c of v.en) expect(c).toMatchObject({ status: 'COMPLETED', steps: { bPayment: { state: 'DONE' }, aRefund: { state: 'DONE' }, bookingsChanged: true } });
    expect(posts(h, 'AUTH_CAPTURE')).toBe(1);
    expect(posts(h, 'CAPTURE_REFUND')).toBe(1);
  });

  it('an unknown capture whose queries time out stays "checking" with no new capture, then completes once', async () => {
    const h = harness();
    const { w, caseId } = await readyToPay(h);
    h.mock.inject('AUTH_CAPTURE', { type: 'RESPONSE_LOST' });
    expect((await w.b.post('cases/mock-approve', { caseId })).status).toBe(200);
    await h.app.idle();
    // The capture's answer was lost; now the lookups that would identify it time out (injected).
    h.mock.inject('AUTH_GET', { type: 'TIMEOUT' }, 2);
    h.mock.inject('ORDER_GET', { type: 'TIMEOUT' }, 2);
    h.mock.inject('CAPTURE_GET', { type: 'TIMEOUT' }, 2);
    await h.ticks(1);

    const v = await views(w);
    notDone(v);
    expect(v.en[0]).toMatchObject({ statusLabel: 'Checking the payment result', steps: { bPayment: { text: 'Checking the payment result with PayPal' }, bookingsChanged: false } });
    expect(v.ja[0].steps.bPayment.text).toBe('PayPalにお支払いの結果を確認中');
    expect(posts(h, 'AUTH_CAPTURE')).toBe(1);

    await h.ticks(12);
    const done = await views(w);
    for (const c of done.en) expect(c).toMatchObject({ status: 'COMPLETED', steps: { bPayment: { state: 'DONE' }, aRefund: { state: 'DONE' } } });
    // While the lookups failed, FlexSlot may resend the same capture operation with the same request id (allowed by
    // the design: PayPal answers a repeated request id with the same capture). It never creates a second capture.
    const capturePosts = h.mock.requests.filter((r) => r.route === 'AUTH_CAPTURE');
    expect(new Set(capturePosts.map((r) => r.requestId)).size).toBe(1);
    expect(h.db.prepare("SELECT count(*) AS n FROM payment_operations WHERE op_kind = 'AUTH_CAPTURE'").get()).toEqual({ n: 1 });
    expect(h.mock.count('captures')).toBe(2); // A's original capture and B's one capture
  });
});
