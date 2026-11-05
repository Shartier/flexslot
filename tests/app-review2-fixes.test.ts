// Regression tests for Codex's second review (IA1-01, IA1-02) and the webhook review (IW1-01). Mock PayPal and the
// in-process fake "Sandbox" only; Codex's probes are work/codex-review-app1/probes.mjs and
// work/codex-review-webhook1/probes.mjs.

import { describe, expect, it } from 'vitest';
import { Runtime } from '../src/server/runtime.ts';
import { paypalReturnText } from '../src/web/paypal-return.ts';
import { aPaysMock, decisionOf, harness, intake, loggedIn, texts, type Harness } from './app-helpers.ts';

const caseCount = (h: Harness) => (h.db.prepare('SELECT count(*) AS n FROM swap_cases').get() as { n: number }).n;
const evalCount = (h: Harness) => (h.db.prepare('SELECT count(*) AS n FROM candidate_evaluations').get() as { n: number }).n;

/** B's request and A's conditions first, then A's capture answer is lost: the screen's call does not see "paid". */
async function aPaymentRecoveredLater() {
  const h = harness();
  const w = await loggedIn(h);
  const t = texts(w.baseDate);
  await intake(w.b, t.b, 'B');
  await intake(w.a, t.a, 'A');
  expect((await w.b.state()).result.reasons[0]).toContain('payment');
  await w.a.post('payment/start');
  h.mock.inject('ORDER_CAPTURE', { type: 'RESPONSE_LOST' });
  const r = await w.a.post('payment/mock-approve');
  expect(r.json).toMatchObject({ ok: true, paid: false });
  expect(caseCount(h)).toBe(0);
  return { h, w, t };
}

describe('IA1-01: B is checked again when A\'s payment is confirmed by any path', () => {
  it('the queue recovers A\'s capture; the same tick proposes the swap once, without re-entering conditions', async () => {
    const { h, w } = await aPaymentRecoveredLater();
    await h.ticks(2);
    expect((await w.a.state()).booking.payment.state).toBe('PAID');
    expect(h.mock.count('captures')).toBe(1);
    const b = await w.b.state();
    expect(b.cases).toHaveLength(1);
    expect(b.cases[0].status).toBe('AWAITING_APPROVAL');
    expect(b.result.feasible).toBe(true);
    // Nothing changes afterwards: no second case, no repeated evaluations.
    const evaluations = evalCount(h);
    await h.ticks(3);
    expect(caseCount(h)).toBe(1);
    expect(evalCount(h)).toBe(evaluations);
  });

  it('startup recovery after a restart does the same', async () => {
    const { h, w } = await aPaymentRecoveredLater();
    h.clock.advance(61_000);
    const restarted = new Runtime({ db: h.db, clock: h.clock, executors: h.executors, paypal: h.paypal });
    await restarted.startup();
    await restarted.tick();
    expect((await w.a.state()).booking.payment.state).toBe('PAID');
    expect(caseCount(h)).toBe(1);
    await restarted.tick();
    expect(caseCount(h)).toBe(1);
  });

  it('a rejected proposal is not offered again by the re-check (I36); new A conditions do re-check a request without a case', async () => {
    const h = harness();
    const w = await loggedIn(h);
    const t = texts(w.baseDate);
    await aPaysMock(w.a);
    await intake(w.a, t.a, 'A');
    await intake(w.b, t.b, 'B');
    const cs = (await w.owner.state()).cases[0];
    await w.owner.post('cases/reject', decisionOf(cs));
    await h.ticks(3);
    expect(caseCount(h)).toBe(1);
    // A new request (after the rejection) is checked when confirmed, as before.
    await intake(w.b, t.b, 'B');
    expect(caseCount(h)).toBe(2);
  });

  it('a request that stays infeasible is not re-evaluated on every tick', async () => {
    const h = harness();
    const w = await loggedIn(h);
    const t = texts(w.baseDate);
    await intake(w.b, t.b, 'B'); // no A payment, no A conditions
    const before = evalCount(h);
    await h.ticks(4);
    expect(evalCount(h)).toBe(before);
    await intake(w.a, t.a, 'A'); // A's conditions change the inputs: checked once more, still infeasible (unpaid)
    expect(evalCount(h)).toBe(before + 1);
    await h.ticks(2);
    expect(evalCount(h)).toBe(before + 1);
  });
});

describe('IA1-02: the PayPal return pages never claim a payment state', () => {
  it('neither text says something was or was not charged, and both send the person back to FlexSlot', () => {
    for (const cancelled of [true, false]) {
      const t = paypalReturnText(cancelled);
      const all = `${t.title} ${t.body}`;
      expect(all).not.toMatch(/charged|refund|paid|nothing was|cancelled the payment|no payment/i);
      expect(all).toContain('FlexSlot');
    }
    expect(paypalReturnText(true).title).toBe('You left PayPal checkout');
  });
});

describe('IW1-01: a slow webhook verification never holds up the payment loop', () => {
  async function bWaitingForApproval() {
    const h = harness();
    const w = await loggedIn(h, { paymentMode: 'SANDBOX' });
    const t = texts(w.baseDate);
    await w.a.post('payment/start');
    const aOrder = (h.db.prepare("SELECT result_external_id AS id FROM a_payment_operations WHERE op_kind = 'ORDER_CREATE'").get() as { id: string }).id;
    h.fakeSandbox.approveOrder(aOrder);
    await w.a.post('payment/approved');
    await intake(w.a, t.a, 'A');
    await intake(w.b, t.b, 'B');
    const cs = (await w.owner.state()).cases[0];
    await w.owner.post('cases/approve', decisionOf(cs));
    await w.a.post('cases/approve', decisionOf(cs));
    await w.b.post('cases/pay', decisionOf(cs));
    const bOrder = (h.db.prepare("SELECT result_external_id AS id FROM payment_operations WHERE op_kind = 'ORDER_CREATE'").get() as { id: string }).id;
    const status = () => (h.db.prepare('SELECT status FROM swap_cases WHERE id = ?').get(cs.id) as { status: string }).status;
    return { h, bOrder, status };
  }

  /** Twenty stored deliveries and a verification API that answers only when released (a 20 s timeout each, or worse). */
  function slowVerification(h: Harness) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const real = h.paypal.SANDBOX!.verifyWebhookSignature.bind(h.paypal.SANDBOX!);
    h.paypal.SANDBOX!.verifyWebhookSignature = async (input) => {
      calls++;
      await gate;
      return real(input);
    };
    return { release, calls: () => calls };
  }

  async function storeDeliveries(h: Harness, n: number) {
    for (let i = 0; i < n; i++) {
      const ev = { id: `SLOW-${i}`, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: `SBX-OTHER-${i}` } };
      const headers = h.fakeSandbox.signWebhook(ev, { transmissionId: `tx-slow-${i}`, transmissionTime: '2026-11-05T12:00:00Z', webhookId: 'WH-TEST' });
      await h.app.handle({ method: 'POST', path: '/webhooks/paypal', query: new URLSearchParams(), headers, body: JSON.stringify(ev), remote: '203.0.113.7' });
    }
  }

  it('B approves 10 minutes into the window while 20 verifications hang: the payment loop still completes the swap', async () => {
    const { h, bOrder, status } = await bWaitingForApproval();
    h.clock.advance(10 * 60_000);
    h.fakeSandbox.approveOrder(bOrder);
    await storeDeliveries(h, 20);
    const slow = slowVerification(h);
    const webhookLoop = h.runtime.webhookTick(); // stuck on the first verification
    await h.runtime.tick();
    expect(status()).toBe('COMPLETED');
    expect(h.fakeSandbox.requests.filter((r) => r.route === 'ORDER_AUTHORIZE')).toHaveLength(1);
    // The webhook loop does not overlap itself while it is stuck.
    await h.runtime.webhookTick();
    expect(slow.calls()).toBe(1);
    slow.release();
    await webhookLoop;
    expect(slow.calls()).toBe(20);
    expect((h.db.prepare("SELECT count(*) AS n FROM webhook_deliveries WHERE verify_status = 'VERIFIED'").get() as { n: number }).n).toBe(20);
  });

  it('each verified event is used right after its own verification, not after the whole batch', async () => {
    const h = harness();
    await storeDeliveries(h, 2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let call = 0;
    const real = h.paypal.SANDBOX!.verifyWebhookSignature.bind(h.paypal.SANDBOX!);
    h.paypal.SANDBOX!.verifyWebhookSignature = async (input) => {
      if (++call === 2) await gate; // the second verification hangs
      return real(input);
    };
    const loop = h.runtime.webhookTick();
    for (let i = 0; i < 50 && call < 2; i++) await new Promise((r) => setImmediate(r));
    const used = h.db.prepare('SELECT event_id FROM webhook_events WHERE processed_at IS NOT NULL').all() as Array<{ event_id: string }>;
    expect(used.map((e) => e.event_id)).toEqual(['SLOW-0']);
    release();
    await loop;
    expect((h.db.prepare('SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NOT NULL').get() as { n: number }).n).toBe(2);
  });

  it('the control: without a webhook backlog the same approval completes in one payment tick', async () => {
    const { h, bOrder, status } = await bWaitingForApproval();
    h.clock.advance(10 * 60_000);
    h.fakeSandbox.approveOrder(bOrder);
    await h.runtime.tick();
    expect(status()).toBe('COMPLETED');
  });
});
