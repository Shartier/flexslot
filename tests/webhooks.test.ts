// AC07 with the mock only (DESIGN 7.4, D06, D15): receive -> store -> verify -> deduplicate -> wake.
// The "Sandbox" is the SANDBOX-mode REST adapter on an in-process mock (ids "SBX-"), whose verify-webhook-signature
// accepts the HMAC made by signWebhook(). This is not PayPal's real signature check and not a real delivery (V8).

import { describe, expect, it } from 'vitest';
import { WebhookInbox } from '../src/app/webhooks.ts';
import { Runtime } from '../src/server/runtime.ts';
import { aPaysMock, decisionOf, harness, intake, loggedIn, texts, type Harness } from './app-helpers.ts';

let seq = 0;
function delivery(h: Harness, o: { eventId: string; type: string; resourceId: string; related?: Record<string, string>; forged?: boolean; webhookId?: string }) {
  const event = {
    id: o.eventId,
    event_type: o.type,
    resource_type: 'mock',
    resource: { id: o.resourceId, ...(o.related ? { supplementary_data: { related_ids: o.related } } : {}) },
  };
  const headers = h.fakeSandbox.signWebhook(event, { transmissionId: `tx-${++seq}`, transmissionTime: '2026-11-05T12:00:00Z', webhookId: o.webhookId ?? 'WH-TEST' });
  if (o.forged) headers['paypal-transmission-sig'] = 'forged';
  return { body: JSON.stringify(event), headers };
}

const post = (h: Harness, d: { body: string; headers: Record<string, string> }, remote = '203.0.113.7') =>
  h.app.handle({ method: 'POST', path: '/webhooks/paypal', query: new URLSearchParams(), headers: d.headers, body: d.body, remote });

const rows = (h: Harness, sql: string, ...a: string[]) => h.db.prepare(sql).all(...a) as Array<Record<string, unknown>>;
const verifyCalls = (h: Harness) => h.fakeSandbox.requests.filter((r) => r.route === 'WEBHOOK_VERIFY').length;

/** A Sandbox world (fake Sandbox) up to B's order waiting for the buyer. */
async function sandboxToBOrder() {
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
  return { h, w, cs, bOrder, status };
}

describe('webhook inbox (DESIGN 7.4, AC07, mock)', () => {
  it('stores every delivery before verifying it; 200 only after the insert; verified events are used once', async () => {
    const h = harness();
    const d = delivery(h, { eventId: 'WH-EV-1', type: 'PAYMENT.CAPTURE.COMPLETED', resourceId: 'SBX-CAPTURE-000999' });
    const r = await post(h, d);
    expect(r.status).toBe(200);
    expect(rows(h, 'SELECT verify_status, event_id, length(body) AS n FROM webhook_deliveries')).toEqual([{ verify_status: 'UNVERIFIED', event_id: 'WH-EV-1', n: d.body.length }]);
    expect(verifyCalls(h)).toBe(0);
    await h.runtime.tick();
    expect(rows(h, 'SELECT verify_status FROM webhook_deliveries')).toEqual([{ verify_status: 'VERIFIED' }]);
    expect(rows(h, 'SELECT event_id, processed_at IS NOT NULL AS done FROM webhook_events')).toEqual([{ event_id: 'WH-EV-1', done: 1 }]);
    // Only the selected PayPal headers are kept.
    const headers = JSON.parse(String(rows(h, 'SELECT headers_json FROM webhook_deliveries')[0]!.headers_json)) as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time']);
  });

  it('a forged delivery with the same event_id first does not block the genuine one; a genuine copy is used once', async () => {
    const h = harness();
    await post(h, delivery(h, { eventId: 'WH-EV-2', type: 'PAYMENT.CAPTURE.COMPLETED', resourceId: 'SBX-X', forged: true }));
    await h.runtime.tick();
    expect(rows(h, 'SELECT verify_status FROM webhook_deliveries')).toEqual([{ verify_status: 'INVALID' }]);
    expect(rows(h, 'SELECT * FROM webhook_events')).toEqual([]);
    const genuine = delivery(h, { eventId: 'WH-EV-2', type: 'PAYMENT.CAPTURE.COMPLETED', resourceId: 'SBX-X' });
    await post(h, genuine);
    await post(h, { ...genuine, headers: { ...genuine.headers } }); // PayPal delivers it again
    await h.runtime.tick();
    expect(rows(h, 'SELECT verify_status FROM webhook_deliveries ORDER BY received_at, rowid').map((x) => x.verify_status)).toEqual(['INVALID', 'VERIFIED', 'VERIFIED']);
    expect(rows(h, 'SELECT count(*) AS n FROM webhook_events')).toEqual([{ n: 1 }]);
    expect(rows(h, "SELECT count(*) AS n FROM audit_log WHERE action = 'WEBHOOK_EVENT'")).toEqual([{ n: 1 }]);
    // A later copy, after the event was used: verified, but neither registered nor used again.
    const first = rows(h, 'SELECT delivery_id, processed_at FROM webhook_events')[0];
    await post(h, { ...genuine, headers: { ...genuine.headers } });
    await h.runtime.tick();
    expect(rows(h, 'SELECT delivery_id, processed_at FROM webhook_events')).toEqual([first]);
    expect(rows(h, "SELECT count(*) AS n FROM audit_log WHERE action = 'WEBHOOK_EVENT'")).toEqual([{ n: 1 }]);
  });

  it('invalid JSON or missing headers are INVALID without calling PayPal; oversized bodies are refused unstored', async () => {
    const h = harness();
    await post(h, { body: '{not json', headers: {} });
    await post(h, { body: JSON.stringify({ id: 'WH-EV-3', event_type: 'X', resource: { id: 'Y' } }), headers: { 'paypal-transmission-id': 't' } });
    await h.runtime.tick();
    expect(rows(h, 'SELECT verify_status FROM webhook_deliveries').map((x) => x.verify_status)).toEqual(['INVALID', 'INVALID']);
    expect(verifyCalls(h)).toBe(0);
    const big = await post(h, { body: JSON.stringify({ id: 'big', pad: 'x'.repeat(65_536) }), headers: {} });
    expect(big.status).toBe(413);
    expect(rows(h, 'SELECT count(*) AS n FROM webhook_deliveries')).toEqual([{ n: 2 }]);
  });

  it('limits deliveries per sender', async () => {
    const h = harness({ webhookRate: 3 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await post(h, { body: '{}', headers: {} }, '198.51.100.1')).status);
    statuses.push((await post(h, { body: '{}', headers: {} }, '198.51.100.2')).status);
    expect(statuses).toEqual([200, 200, 200, 429, 200]);
    expect(rows(h, 'SELECT count(*) AS n FROM webhook_deliveries')).toEqual([{ n: 4 }]);
  });

  it('a failing verification API is retried later with backoff, also after a restart', async () => {
    const h = harness();
    h.fakeSandbox.inject('WEBHOOK_VERIFY', { type: 'HTTP_ERROR', status: 503 });
    await post(h, delivery(h, { eventId: 'WH-EV-4', type: 'PAYMENT.CAPTURE.COMPLETED', resourceId: 'SBX-Z' }));
    await h.runtime.tick();
    expect(rows(h, 'SELECT verify_status, verify_tries FROM webhook_deliveries')).toEqual([{ verify_status: 'VERIFY_ERROR', verify_tries: 1 }]);
    await h.runtime.tick(); // not due yet
    expect(verifyCalls(h)).toBe(1);
    h.clock.advance(10_000);
    // A new process on the same database resumes the verification.
    const inbox2 = new WebhookInbox({ db: h.db, clock: h.clock, paypal: h.paypal.SANDBOX!, webhookId: 'WH-TEST' });
    await new Runtime({ db: h.db, clock: h.clock, executors: {}, paypal: {}, webhooks: inbox2 }).tick();
    expect(rows(h, 'SELECT verify_status FROM webhook_deliveries')).toEqual([{ verify_status: 'VERIFIED' }]);
    expect(rows(h, 'SELECT count(*) AS n FROM webhook_events WHERE processed_at IS NOT NULL')).toEqual([{ n: 1 }]);
  });

  it('without a configured webhook id deliveries are stored but never verified or used', async () => {
    const h = harness({ webhookId: null });
    await post(h, delivery(h, { eventId: 'WH-EV-5', type: 'CHECKOUT.ORDER.APPROVED', resourceId: 'SBX-O' }));
    await h.runtime.tick();
    expect(rows(h, 'SELECT verify_status FROM webhook_deliveries')).toEqual([{ verify_status: 'UNVERIFIED' }]);
    expect(verifyCalls(h)).toBe(0);
    expect(rows(h, 'SELECT * FROM webhook_events')).toEqual([]);
  });
});

describe('verified events only trigger queries (D06)', () => {
  it('PAYMENT.CAPTURE.COMPLETED wakes the capture awaiting reconciliation; without it the query waits its 10 s', async () => {
    const { h, w, cs, bOrder, status } = await sandboxToBOrder();
    h.fakeSandbox.approveOrder(bOrder);
    h.fakeSandbox.inject('CAPTURE_GET', { type: 'HTTP_ERROR', status: 500 }); // the reconciliation query fails once
    await w.b.post('cases/approved', { caseId: cs.id });
    await h.app.idle();
    expect(status()).toBe('RECONCILING');
    await h.runtime.tick(); // same instant: the failed query is not due again yet
    expect(status()).toBe('RECONCILING');
    const capture = (h.db.prepare("SELECT result_external_id AS id FROM payment_operations WHERE op_kind = 'AUTH_CAPTURE'").get() as { id: string }).id;
    expect((await post(h, delivery(h, { eventId: 'WH-EV-6', type: 'PAYMENT.CAPTURE.COMPLETED', resourceId: capture }))).status).toBe(200);
    await h.runtime.tick(); // verify -> wake -> the queue reconciles by GET capture and goes on
    expect(status()).toBe('COMPLETED');
    expect(rows(h, "SELECT detail_json FROM audit_log WHERE action = 'WEBHOOK_EVENT'").map((x) => JSON.parse(String(x.detail_json)))).toEqual([{ type: 'PAYMENT.CAPTURE.COMPLETED', wokenOperations: 1 }]);
  });

  it('CHECKOUT.ORDER.APPROVED makes the watcher query the order now (the query decides, not the event)', async () => {
    const { h, bOrder, status } = await sandboxToBOrder();
    await h.runtime.tick(); // the watcher queries the order: not approved yet
    h.fakeSandbox.approveOrder(bOrder);
    await h.runtime.tick(); // same instant: the watcher waits its interval
    expect(status()).toBe('PAYMENT_STARTED');
    await post(h, delivery(h, { eventId: 'WH-EV-7', type: 'CHECKOUT.ORDER.APPROVED', resourceId: bOrder }));
    await h.runtime.tick();
    expect(status()).toBe('COMPLETED');
  });

  it('a verified event for an order that is not approved does nothing; old and repeated events move nothing back', async () => {
    const { h, w, cs, bOrder, status } = await sandboxToBOrder();
    await post(h, delivery(h, { eventId: 'WH-EV-8', type: 'CHECKOUT.ORDER.APPROVED', resourceId: bOrder })); // not true
    await h.runtime.tick();
    expect(status()).toBe('PAYMENT_STARTED');
    expect(h.fakeSandbox.requests.filter((r) => r.route === 'ORDER_AUTHORIZE')).toHaveLength(0);
    h.fakeSandbox.approveOrder(bOrder);
    await w.b.post('cases/approved', { caseId: cs.id });
    await h.app.idle();
    await h.ticks(3);
    expect(status()).toBe('COMPLETED');
    const before = rows(h, 'SELECT id, status, external_status, reconcile_status FROM payment_operations ORDER BY rowid');
    const capture = (h.db.prepare("SELECT result_external_id AS id FROM payment_operations WHERE op_kind = 'AUTH_CAPTURE'").get() as { id: string }).id;
    await post(h, delivery(h, { eventId: 'WH-EV-9', type: 'PAYMENT.CAPTURE.PENDING', resourceId: capture }));
    await post(h, delivery(h, { eventId: 'WH-EV-10', type: 'PAYMENT.AUTHORIZATION.CREATED', resourceId: 'SBX-AUTH', related: { order_id: bOrder } }));
    await h.runtime.tick();
    expect(rows(h, 'SELECT id, status, external_status, reconcile_status FROM payment_operations ORDER BY rowid')).toEqual(before);
    expect(status()).toBe('COMPLETED');
    const posts = h.fakeSandbox.requests.filter((r) => r.method === 'POST' && r.route !== 'TOKEN' && r.route !== 'WEBHOOK_VERIFY').length;
    await h.runtime.tick();
    expect(h.fakeSandbox.requests.filter((r) => r.method === 'POST' && r.route !== 'TOKEN' && r.route !== 'WEBHOOK_VERIFY').length).toBe(posts);
  });

  it('a mock world is unaffected by webhooks (they come from the Sandbox only)', async () => {
    const h = harness();
    const w = await loggedIn(h);
    await aPaysMock(w.a);
    const aOrder = (h.db.prepare("SELECT result_external_id AS id FROM a_payment_operations WHERE op_kind = 'ORDER_CREATE'").get() as { id: string }).id;
    await post(h, delivery(h, { eventId: 'WH-EV-11', type: 'CHECKOUT.ORDER.APPROVED', resourceId: aOrder }));
    await h.runtime.tick();
    expect(h.mock.requests.filter((r) => r.route === 'WEBHOOK_VERIFY')).toHaveLength(0);
    expect((await w.a.state()).booking.payment.state).toBe('PAID');
  });
});
