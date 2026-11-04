// STATUS I08 / DESIGN 6.1: A's original payment (intent=CAPTURE) is stored per operation in the app itself,
// and recovered after a lost answer or a restart without a second capture. Not the verify scripts' runs.json.
// Mock only.

import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.ts';
import { openDatabase } from '../src/db/database.ts';
import type { ExecutorHooks } from '../src/executor/engine.ts';
import { Executor } from '../src/executor/executor.ts';
import type { OpRow } from '../src/executor/ops.ts';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_MERCHANT_ID, MockPayPalServer, type ReplayModes } from '../src/paypal/mock-server.ts';
import { buildCreateOrder, type CreateOrderInput } from '../src/paypal/requests.ts';
import { MOCK_API_BASE, PayPalRestAdapter } from '../src/paypal/rest.ts';
import { SAMPLE_NOW_MS, seedSampleWorld } from '../src/sample.ts';
import { FaultyFetch, SimulatedCrash, crashAt } from './executor-helpers.ts';

async function aWorld(replay?: ReplayModes) {
  const clock = new ManualClock(SAMPLE_NOW_MS);
  const server = new MockPayPalServer({ clock, ...(replay ? { replay } : {}) });
  const faulty = new FaultyFetch(server.fetch);
  const paypal = new PayPalRestAdapter({ mode: 'MOCK', apiBase: MOCK_API_BASE, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, fetch: faulty.fetch, clock, timeoutMs: 50 });
  const db = openDatabase(':memory:');
  const ids = seedSampleWorld(db, 'w1', SAMPLE_NOW_MS);
  db.prepare('UPDATE shops SET expected_payee_merchant_id = ?').run(MOCK_MERCHANT_ID);
  db.prepare('DELETE FROM payments').run(); // A has not paid yet
  const exec = (owner = 'exec-1', hooks?: ExecutorHooks) => new Executor({ db, paypal, clock, owner, ...(hooks ? { hooks } : {}) });
  const booking = ids.aBookingId;
  const ops = () => db.prepare('SELECT * FROM a_payment_operations ORDER BY rowid').all() as unknown as OpRow[];
  const payments = () => db.prepare("SELECT booking_id, order_id, capture_id, amount_minor, currency, payee_merchant_id, status_raw, verified_at FROM payments WHERE kind = 'A_ORIGINAL'").all();
  const posts = (route: string) => server.requests.filter((r) => r.route === route && r.method === 'POST');
  return { clock, server, faulty, paypal, db, ids, exec, booking, ops, payments, posts };
}

async function ordered(a: Awaited<ReturnType<typeof aWorld>>, ex: Executor): Promise<string> {
  const p = ex.prepareAPayment(a.booking);
  if (!p.ok) throw new Error(p.reason);
  const o = await ex.createAOrder(a.booking);
  if (!o.ok) throw new Error(o.reason);
  return o.orderId;
}

describe('I08: A original payment stored per operation', () => {
  it('stores input and hash before the send, the order id from the answer, and pays only after GET capture matched', async () => {
    const a = await aWorld();
    const ex = a.exec();
    expect(ex.prepareAPayment(a.booking).ok).toBe(true);
    const [create] = a.ops();
    expect(create).toMatchObject({ op_kind: 'ORDER_CREATE', status: 'PREPARED', target_external_id: null, result_external_id: null });
    const input = JSON.parse(create!.request_json) as CreateOrderInput;
    expect(input).toMatchObject({ intent: 'CAPTURE', amount: { currency: 'USD', minor: 6000 }, customId: `booking:${a.booking}:a` });
    expect(create!.request_hash).toBe(buildCreateOrder(input).hash);

    const o = await ex.createAOrder(a.booking);
    expect(o.ok).toBe(true);
    if (!o.ok) return;
    expect(a.ops()[0]).toMatchObject({ status: 'SUCCEEDED', result_external_id: o.orderId });
    a.server.approveOrder(o.orderId);
    expect(await ex.captureAPayment(a.booking)).toEqual({ ok: true, paid: true });
    const capture = a.ops()[1]!;
    expect(capture).toMatchObject({ op_kind: 'ORDER_CAPTURE', target_external_id: o.orderId, status: 'SUCCEEDED', reconcile_status: 'MATCHED' });
    expect(a.payments()).toEqual([
      {
        booking_id: a.booking, order_id: o.orderId, capture_id: capture.result_external_id, amount_minor: 6000, currency: 'USD',
        payee_merchant_id: MOCK_MERCHANT_ID, status_raw: 'COMPLETED', verified_at: SAMPLE_NOW_MS,
      },
    ]);
    expect(a.server.requests.filter((r) => r.route === 'CAPTURE_GET')).toHaveLength(1);
    expect(ex.prepareAPayment(a.booking)).toEqual({ ok: false, reason: 'ALREADY_PAID' });
  });

  it('refuses without the shop payee and for an unknown booking', async () => {
    const a = await aWorld();
    a.db.prepare('UPDATE shops SET expected_payee_merchant_id = NULL').run();
    expect(a.exec().prepareAPayment(a.booking)).toEqual({ ok: false, reason: 'PAYEE_NOT_SET' });
    expect(a.exec().prepareAPayment('nope')).toEqual({ ok: false, reason: 'BOOKING_NOT_FOUND' });
  });

  it('order create answer lost before the save: the restart resends the same id, one order', async () => {
    const a = await aWorld();
    const ex = a.exec('exec-1', crashAt('after-send', (i) => i.opKind === 'ORDER_CREATE'));
    expect(ex.prepareAPayment(a.booking).ok).toBe(true);
    await expect(ex.createAOrder(a.booking)).rejects.toThrow(SimulatedCrash);
    expect(a.ops()[0]).toMatchObject({ status: 'SENDING', result_external_id: null });
    a.clock.advance(61_000);
    const report = await a.exec('exec-2').recover();
    expect(report.recovered).toEqual([a.ops()[0]!.id]);
    expect(a.server.count('orders')).toBe(1);
    expect(a.posts('ORDER_CREATE').map((r) => r.requestId)).toEqual([a.ops()[0]!.paypal_request_id, a.ops()[0]!.paypal_request_id]);
    expect(a.ops()[0]!.status).toBe('SUCCEEDED');
  });

  it('order capture answer lost before the save: found by querying the order, no second capture', async () => {
    const a = await aWorld();
    const ex = a.exec('exec-1', crashAt('after-send', (i) => i.opKind === 'ORDER_CAPTURE'));
    const orderId = await ordered(a, ex);
    a.server.approveOrder(orderId);
    await expect(ex.captureAPayment(a.booking)).rejects.toThrow(SimulatedCrash);
    expect(a.payments()).toEqual([]);
    a.clock.advance(61_000);
    await a.exec('exec-2').recover();
    expect(a.posts('ORDER_CAPTURE')).toHaveLength(1);
    expect(a.server.count('captures')).toBe(1);
    expect(a.payments()).toHaveLength(1);
  });

  it('stop after the capture POST success is saved: not paid until the GET after the restart', async () => {
    const a = await aWorld();
    const ex = a.exec('exec-1', crashAt('after-result-saved', (i) => i.opKind === 'ORDER_CAPTURE' && i.reconcile === 'AWAITING'));
    const orderId = await ordered(a, ex);
    a.server.approveOrder(orderId);
    await expect(ex.captureAPayment(a.booking)).rejects.toThrow(SimulatedCrash);
    expect(a.ops()[1]).toMatchObject({ status: 'SUCCEEDED', reconcile_status: 'AWAITING' });
    expect(a.payments()).toEqual([]);
    a.clock.advance(61_000);
    await a.exec('exec-2').recover();
    expect(a.posts('ORDER_CAPTURE')).toHaveLength(1);
    expect(a.payments()).toHaveLength(1);
  });

  it('a payee that does not match keeps A unpaid; a later matching GET records the payment once', async () => {
    const a = await aWorld();
    const ex = a.exec();
    const orderId = await ordered(a, ex);
    a.server.approveOrder(orderId);
    a.faulty.rewrite('CAPTURE_GET', (j) => ({ ...j, payee: { merchant_id: 'SOMEONEELSE' } }));
    expect(await ex.captureAPayment(a.booking)).toEqual({ ok: true, paid: false });
    expect(a.ops()[1]).toMatchObject({ reconcile_status: 'AWAITING', last_error_class: 'MISMATCH:payee' });
    a.faulty.clearRewrite('CAPTURE_GET');
    a.clock.advance(10_000);
    await ex.processDue();
    await ex.processDue();
    expect(a.payments()).toHaveLength(1);
    expect(a.posts('ORDER_CAPTURE')).toHaveLength(1);
  });

  it('a capture before the approval is not accepted; after the approval a new capture operation pays', async () => {
    const a = await aWorld();
    const ex = a.exec();
    const orderId = await ordered(a, ex);
    expect(await ex.captureAPayment(a.booking)).toEqual({ ok: true, paid: false });
    expect(a.ops()[1]).toMatchObject({ status: 'NOT_ACCEPTED' });
    a.server.approveOrder(orderId);
    expect(await ex.captureAPayment(a.booking)).toEqual({ ok: true, paid: true });
    expect(a.ops()[2]).toMatchObject({ op_kind: 'ORDER_CAPTURE', op_seq: 2, previous_operation_id: a.ops()[1]!.id });
    expect(a.ops()[2]!.paypal_request_id).not.toBe(a.ops()[1]!.paypal_request_id);
  });

  it('capture answer lost and the order query down: the query is retried, nothing is resent', async () => {
    const a = await aWorld();
    const ex = a.exec();
    const orderId = await ordered(a, ex);
    a.server.approveOrder(orderId);
    a.server.inject('ORDER_CAPTURE', { type: 'RESPONSE_LOST' });
    expect(await ex.captureAPayment(a.booking)).toEqual({ ok: true, paid: false });
    a.server.inject('ORDER_GET', { type: 'HTTP_ERROR', status: 503 });
    a.clock.advance(2_000);
    await ex.processDue();
    expect(a.ops()[1]).toMatchObject({ status: 'UNKNOWN', last_error_class: 'ORDER_QUERY_HTTP_5XX' });
    a.clock.advance(10_000);
    await ex.processDue();
    expect(a.posts('ORDER_CAPTURE')).toHaveLength(1);
    expect(a.payments()).toHaveLength(1);
  });

  it.each<ReplayModes>([{ orders: 'ORIGINAL' }, { orders: 'CURRENT' }])(
    'capture answer lost and the order read shows no capture yet: the same-id resend identifies it (%o)',
    async (replay) => {
      const a = await aWorld(replay);
      const ex = a.exec();
      const orderId = await ordered(a, ex);
      a.server.approveOrder(orderId);
      a.server.inject('ORDER_CAPTURE', { type: 'RESPONSE_LOST' });
      expect(await ex.captureAPayment(a.booking)).toEqual({ ok: true, paid: false });
      // A stale read: the order still looks APPROVED without captures, so recovery resends with the same id.
      a.faulty.rewrite('ORDER_GET', (j) => {
        const pu = (j.purchase_units as Array<Record<string, unknown>>)[0]!;
        delete pu.payments;
        return { ...j, status: 'APPROVED' };
      });
      a.clock.advance(2_000);
      await ex.processDue();
      await ex.processDue();
      expect(a.posts('ORDER_CAPTURE')).toHaveLength(2);
      expect(new Set(a.posts('ORDER_CAPTURE').map((r) => r.requestId)).size).toBe(1);
      expect(a.server.count('captures')).toBe(1);
      expect(a.payments()).toHaveLength(1);
    },
  );
});
