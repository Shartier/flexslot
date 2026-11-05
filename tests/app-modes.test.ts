// Mock and Sandbox kept apart (DESIGN 10, AC12). "Sandbox" here is the SANDBOX-mode REST adapter on a second
// in-process mock server with non-MOCK ids (no network); the real Sandbox run is recorded in STATUS.

import { describe, expect, it } from 'vitest';
import { isSchemaRaise } from '../src/db/database.ts';
import { aPaysMock, decisionOf, harness, intake, loggedIn, texts } from './app-helpers.ts';

describe('payment modes are not mixed (AC12)', () => {
  it('the screens show the AI and payment modes of the world', async () => {
    const h = harness();
    const m = await loggedIn(h, { paymentMode: 'MOCK' });
    const s = await loggedIn(h, { paymentMode: 'SANDBOX' });
    expect((await m.owner.state()).header.modes).toEqual({ ai: 'MOCK', aiModel: 'mock-rules-v1', aiAvailable: true, payment: 'MOCK' });
    expect((await s.b.state()).header.modes).toEqual({ ai: 'MOCK', aiModel: 'mock-rules-v1', aiAvailable: true, payment: 'SANDBOX' });
  });

  it('mock approvals are refused in a Sandbox world', async () => {
    const h = harness();
    const s = await loggedIn(h, { paymentMode: 'SANDBOX' });
    const start = await s.a.post('payment/start');
    expect(start.status).toBe(200);
    expect(start.json.approval.kind).not.toBe('MOCK');
    expect((await s.a.post('payment/mock-approve')).json).toEqual({ error: 'MODE_MISMATCH' });
    // The order went to the "Sandbox" server, not to the mock one.
    expect(h.fakeSandbox.count('orders')).toBe(1);
    expect(h.mock.count('orders')).toBe(0);
  });

  it('a Sandbox world completes through the Sandbox adapter only, with the buyer approval seen by the watcher', async () => {
    const h = harness();
    const s = await loggedIn(h, { paymentMode: 'SANDBOX' });
    const t = texts(s.baseDate);
    await s.a.post('payment/start');
    const aOrder = (h.db.prepare("SELECT result_external_id AS id FROM a_payment_operations WHERE op_kind = 'ORDER_CREATE'").get() as { id: string }).id;
    expect(aOrder.startsWith('SBX-')).toBe(true);
    h.fakeSandbox.approveOrder(aOrder); // the buyer approves on PayPal; the server notices by polling the order
    await h.runtime.tick();
    expect((await s.a.state()).booking.payment.state).toBe('PAID');
    await intake(s.a, t.a, 'A');
    await intake(s.b, t.b, 'B');
    const cs = (await s.owner.state()).cases[0];
    await s.owner.post('cases/approve', decisionOf(cs));
    await s.a.post('cases/approve', decisionOf(cs));
    await s.b.post('cases/pay', decisionOf(cs));
    const bOrder = (h.db.prepare("SELECT result_external_id AS id FROM payment_operations WHERE op_kind = 'ORDER_CREATE'").get() as { id: string }).id;
    h.fakeSandbox.approveOrder(bOrder);
    await h.ticks(6);
    expect((await s.b.state()).cases[0].status).toBe('COMPLETED');
    expect(h.mock.requests).toHaveLength(0);
    expect([h.fakeSandbox.count('orders'), h.fakeSandbox.count('captures'), h.fakeSandbox.count('refunds')]).toEqual([2, 2, 1]);
  });

  it('each executor works only on its own mode: the mock executor never touches a Sandbox world', async () => {
    const h = harness();
    const s = await loggedIn(h, { paymentMode: 'SANDBOX' });
    const t = texts(s.baseDate);
    await s.a.post('payment/start');
    const aOrder = (h.db.prepare("SELECT result_external_id AS id FROM a_payment_operations WHERE op_kind = 'ORDER_CREATE'").get() as { id: string }).id;
    h.fakeSandbox.approveOrder(aOrder);
    await s.a.post('payment/approved');
    await intake(s.a, t.a, 'A');
    await intake(s.b, t.b, 'B');
    const cs = (await s.owner.state()).cases[0];
    await s.owner.post('cases/approve', decisionOf(cs));
    await s.a.post('cases/approve', decisionOf(cs));
    // E1 by the wrong executor is refused; so are its other entry points.
    const mockEx = h.executors.MOCK!;
    expect(mockEx.startPayment({ caseId: cs.id, version: cs.version, termsHash: cs.termsHash, bPartyId: `${s.worldId}:customer:b` })).toEqual({ ok: false, reason: 'MODE_MISMATCH' });
    await s.b.post('cases/pay', decisionOf(cs));
    expect(await mockEx.onBuyerApproved(cs.id)).toEqual({ ok: false, reason: 'MODE_MISMATCH' });
    expect(await mockEx.createOrder(cs.id)).toEqual({ ok: false, reason: 'MODE_MISMATCH' });
    expect(await mockEx.advance(cs.id)).toBe('PAYMENT_STARTED');
    await mockEx.processDue();
    await mockEx.recover();
    expect(h.mock.requests).toHaveLength(0);
    // And the Sandbox executor leaves a mock world alone.
    const m = await loggedIn(h, { paymentMode: 'MOCK' });
    await aPaysMock(m.a);
    const before = h.fakeSandbox.requests.length;
    await h.executors.SANDBOX!.processDue();
    expect(h.fakeSandbox.requests.length).toBe(before);
  });

  it('modes are fixed when the world is created; unavailable modes cannot be chosen', async () => {
    const h = harness();
    const w = await loggedIn(h);
    expect(() => h.db.prepare("UPDATE worlds SET mode_payment = 'SANDBOX' WHERE id = ?").run(w.worldId)).toThrow();
    let raised: unknown = null;
    try {
      h.db.prepare("UPDATE worlds SET mode_ai = 'VERTEX' WHERE id = ?").run(w.worldId);
    } catch (e) {
      raised = e;
    }
    expect(isSchemaRaise(raised, 'MODE_IMMUTABLE')).toBe(true);
    // No Vertex configured in this harness: a Vertex world is refused instead of silently using the mock.
    const res = await h.app.handle({ method: 'POST', path: '/api/worlds', query: new URLSearchParams(), headers: { origin: 'http://localhost:8787' }, body: '{"aiMode":"VERTEX","paymentMode":"MOCK"}' });
    expect(JSON.parse(String(res.body))).toEqual({ error: 'AI_MODE_UNAVAILABLE' });
  });
});
