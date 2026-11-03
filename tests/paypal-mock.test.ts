import { describe, expect, it } from 'vitest';
import { MOCK_API_BASE } from '../src/paypal/rest.ts';
import { authorized, captured, expectKind, mockSetup, orderInput, rid } from './paypal-helpers.ts';

const usd = (minor: number) => ({ currency: 'USD', minor });

describe('mock PayPal: ids and representation', () => {
  it('every id is recognisably a mock id', async () => {
    const m = mockSetup();
    const { orderId, authorizationId } = await authorized(m);
    const cap = expectKind(await m.paypal.captureAuthorization(authorizationId, { amount: usd(6000) }, { requestId: rid() }), 'SUCCEEDED');
    const refund = expectKind(await m.paypal.refundCapture(cap.resource.id, { amount: usd(1000) }, { requestId: rid() }), 'SUCCEEDED');
    for (const id of [orderId, authorizationId, cap.resource.id, refund.resource.id]) expect(id).toMatch(/^MOCK-(ORDER|AUTH|CAPTURE|REFUND)-\d{6}$/);
  });

  it('answers a minimal body without Prefer: return=representation (as PayPal does by default)', async () => {
    const m = mockSetup();
    const { captureId } = await captured(m);
    // Call the server directly, the way a client that forgot the Prefer header would.
    const tokenRes = await m.server.fetch(`${MOCK_API_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from('MOCK-CLIENT-ID:MOCK-CLIENT-SECRET').toString('base64')}` },
      body: 'grant_type=client_credentials',
    });
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const res = await m.server.fetch(`${MOCK_API_BASE}/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': rid() },
      body: JSON.stringify({ amount: { currency_code: 'USD', value: '10.00' } }),
    });
    expect(res.status).toBe(201);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(['id', 'status']);
  });

  it('rejects API calls without a valid token', async () => {
    const m = mockSetup();
    const res = await m.server.fetch(`${MOCK_API_BASE}/v2/checkout/orders/MOCK-ORDER-000001`, { method: 'GET', headers: { Authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });
});

describe('mock PayPal: idempotency', () => {
  it('Payments API: the same request id returns the original answer, even after the state moved on', async () => {
    const m = mockSetup();
    const { authorizationId } = await authorized(m);
    const ctx = { requestId: rid() };
    const first = expectKind(await m.paypal.captureAuthorization(authorizationId, { amount: usd(6000) }, ctx), 'SUCCEEDED');
    await m.paypal.refundCapture(first.resource.id, { amount: usd(6000) }, { requestId: rid() });
    expect(m.server.statusOf(first.resource.id)).toBe('REFUNDED');
    const replay = expectKind(await m.paypal.captureAuthorization(authorizationId, { amount: usd(6000) }, ctx), 'SUCCEEDED');
    expect(replay.resource).toMatchObject({ id: first.resource.id, status: 'COMPLETED' }); // stored answer, not REFUNDED
    expect(m.server.count('captures')).toBe(1);
  });

  it('Orders API: a replay of authorize returns the current order, classified UNKNOWN with the resource kept', async () => {
    const m = mockSetup();
    const created = expectKind(await m.paypal.createOrder(orderInput('AUTHORIZE'), { requestId: rid() }), 'SUCCEEDED');
    m.server.approveOrder(created.resource.id);
    const ctx = { requestId: rid() };
    const first = expectKind(await m.paypal.authorizeOrder(created.resource.id, ctx), 'SUCCEEDED');
    await m.paypal.voidAuthorization(first.resource.authorization.id, { requestId: rid() });
    const replay = expectKind(await m.paypal.authorizeOrder(created.resource.id, ctx), 'UNKNOWN');
    expect(replay).toMatchObject({ reason: 'UNEXPECTED_STATUS', externalStatus: 'VOIDED', httpStatus: 201 });
    expect(replay.resource?.authorization.id).toBe(first.resource.authorization.id);
    expect(m.server.count('authorizations')).toBe(1);
  });

  it('replay mode CURRENT for payments: a capture resend after a full refund returns REFUNDED, classified UNKNOWN', async () => {
    const m = mockSetup(50, { payments: 'CURRENT' });
    const { authorizationId } = await authorized(m);
    const ctx = { requestId: rid() };
    const first = expectKind(await m.paypal.captureAuthorization(authorizationId, { amount: usd(6000) }, ctx), 'SUCCEEDED');
    await m.paypal.refundCapture(first.resource.id, { amount: usd(6000) }, { requestId: rid() });
    const replay = expectKind(await m.paypal.captureAuthorization(authorizationId, { amount: usd(6000) }, ctx), 'UNKNOWN');
    expect(replay).toMatchObject({ reason: 'UNEXPECTED_STATUS', externalStatus: 'REFUNDED' });
    expect(replay.resource?.id).toBe(first.resource.id);
    expect(m.server.count('captures')).toBe(1);
  });

  it('replay mode ORIGINAL for orders: an authorize resend after a void returns the stored CREATED answer', async () => {
    const m = mockSetup(50, { orders: 'ORIGINAL' });
    const created = expectKind(await m.paypal.createOrder(orderInput('AUTHORIZE'), { requestId: rid() }), 'SUCCEEDED');
    m.server.approveOrder(created.resource.id);
    const ctx = { requestId: rid() };
    const first = expectKind(await m.paypal.authorizeOrder(created.resource.id, ctx), 'SUCCEEDED');
    await m.paypal.voidAuthorization(first.resource.authorization.id, { requestId: rid() });
    const replay = expectKind(await m.paypal.authorizeOrder(created.resource.id, ctx), 'SUCCEEDED');
    expect(replay.resource.authorization).toMatchObject({ id: first.resource.authorization.id, status: 'CREATED' });
    expect(m.server.statusOf(first.resource.authorization.id)).toBe('VOIDED');
  });

  it('request ids are scoped per call type', async () => {
    const m = mockSetup();
    const shared = rid();
    const created = expectKind(await m.paypal.createOrder(orderInput('CAPTURE'), { requestId: shared }), 'SUCCEEDED');
    m.server.approveOrder(created.resource.id);
    const cap = await m.paypal.captureOrder(created.resource.id, { requestId: shared });
    expect(cap.kind).toBe('SUCCEEDED');
    expect(m.server.count('captures')).toBe(1);
  });

  it('error answers are not stored: a resend after a rejected request is evaluated again', async () => {
    const m = mockSetup();
    const created = expectKind(await m.paypal.createOrder(orderInput('AUTHORIZE'), { requestId: rid() }), 'SUCCEEDED');
    const ctx = { requestId: rid() };
    const notYet = expectKind(await m.paypal.authorizeOrder(created.resource.id, ctx), 'NOT_ACCEPTED');
    expect(notYet.error.issues).toContain('ORDER_NOT_APPROVED');
    m.server.approveOrder(created.resource.id);
    expect((await m.paypal.authorizeOrder(created.resource.id, ctx)).kind).toBe('SUCCEEDED');
  });
});

describe('mock PayPal: fault injection', () => {
  it.each(['ORDER_CREATE', 'ORDER_AUTHORIZE', 'AUTH_CAPTURE', 'CAPTURE_REFUND'] as const)(
    'RESPONSE_LOST on %s: processed by PayPal, recovered by resending the same id',
    async (route) => {
      const m = mockSetup();
      const { captureId } = await captured(m);
      const approved = expectKind(await m.paypal.createOrder(orderInput('AUTHORIZE'), { requestId: rid() }), 'SUCCEEDED').resource.id;
      m.server.approveOrder(approved);
      const { authorizationId } = await authorized(m);
      type Ctx = { requestId: string; priorUnknownSend?: boolean };
      const send = {
        ORDER_CREATE: (ctx: Ctx) => m.paypal.createOrder(orderInput('CAPTURE'), ctx),
        ORDER_AUTHORIZE: (ctx: Ctx) => m.paypal.authorizeOrder(approved, ctx),
        AUTH_CAPTURE: (ctx: Ctx) => m.paypal.captureAuthorization(authorizationId, { amount: usd(6000) }, ctx),
        CAPTURE_REFUND: (ctx: Ctx) => m.paypal.refundCapture(captureId, { amount: usd(1000) }, ctx),
      }[route];
      const counter = ({ ORDER_CREATE: 'orders', ORDER_AUTHORIZE: 'authorizations', AUTH_CAPTURE: 'captures', CAPTURE_REFUND: 'refunds' } as const)[route];
      const before = m.server.count(counter);

      m.server.inject(route, { type: 'RESPONSE_LOST' });
      const ctx = { requestId: rid() };
      expect(await send(ctx)).toMatchObject({ kind: 'UNKNOWN', reason: 'NETWORK' });
      expect(m.server.count(counter)).toBe(before + 1);
      expect((await send({ ...ctx, priorUnknownSend: true })).kind).toBe('SUCCEEDED');
      expect(m.server.count(counter)).toBe(before + 1);
    },
  );

  it('5xx without processing: nothing happened, the same id then succeeds once', async () => {
    const m = mockSetup();
    const { captureId } = await captured(m);
    m.server.inject('CAPTURE_REFUND', { type: 'HTTP_ERROR', status: 503 });
    const ctx = { requestId: rid() };
    expect(await m.paypal.refundCapture(captureId, { amount: usd(1000) }, ctx)).toMatchObject({ kind: 'UNKNOWN', reason: 'HTTP_5XX', httpStatus: 503 });
    expect(m.server.count('refunds')).toBe(0);
    expect((await m.paypal.refundCapture(captureId, { amount: usd(1000) }, { ...ctx, priorUnknownSend: true })).kind).toBe('SUCCEEDED');
    expect(m.server.count('refunds')).toBe(1);
  });

  it('5xx after processing: the resend returns the stored result instead of refunding twice', async () => {
    const m = mockSetup();
    const { captureId } = await captured(m);
    m.server.inject('CAPTURE_REFUND', { type: 'HTTP_ERROR', status: 500, processed: true });
    const ctx = { requestId: rid() };
    expect((await m.paypal.refundCapture(captureId, { amount: usd(1000) }, ctx)).kind).toBe('UNKNOWN');
    expect(m.server.count('refunds')).toBe(1);
    const again = expectKind(await m.paypal.refundCapture(captureId, { amount: usd(1000) }, { ...ctx, priorUnknownSend: true }), 'SUCCEEDED');
    expect(m.server.count('refunds')).toBe(1);
    expect(m.server.statusOf(again.resource.id)).toBe('COMPLETED');
  });

  it('timeout (processed or not) ends as UNKNOWN:TIMEOUT within the adapter timeout', async () => {
    const m = mockSetup(30);
    const { authorizationId } = await authorized(m);
    m.server.inject('AUTH_CAPTURE', { type: 'TIMEOUT', processed: true });
    const started = Date.now();
    const ctx = { requestId: rid() };
    expect(await m.paypal.captureAuthorization(authorizationId, { amount: usd(6000) }, ctx)).toMatchObject({ kind: 'UNKNOWN', reason: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(m.server.count('captures')).toBe(1);
    expect((await m.paypal.captureAuthorization(authorizationId, { amount: usd(6000) }, { ...ctx, priorUnknownSend: true })).kind).toBe('SUCCEEDED');
    expect(m.server.count('captures')).toBe(1);

    m.server.inject('ORDER_CREATE', { type: 'TIMEOUT' });
    const before = m.server.count('orders');
    expect(await m.paypal.createOrder(orderInput('CAPTURE'), { requestId: rid() })).toMatchObject({ kind: 'UNKNOWN', reason: 'TIMEOUT' });
    expect(m.server.count('orders')).toBe(before);
  });

  it.each(['ORDER_AUTHORIZE', 'AUTH_CAPTURE', 'CAPTURE_REFUND'] as const)('PENDING on %s, settled later to a final state', async (route) => {
    const m = mockSetup();
    const created = expectKind(await m.paypal.createOrder(orderInput('AUTHORIZE'), { requestId: rid() }), 'SUCCEEDED');
    m.server.approveOrder(created.resource.id);
    if (route === 'ORDER_AUTHORIZE') {
      m.server.inject(route, { type: 'PENDING' });
      const r = expectKind(await m.paypal.authorizeOrder(created.resource.id, { requestId: rid() }), 'PENDING');
      m.server.settle(r.resource.authorization.id, 'CREATED');
      expect(expectKind(await m.paypal.getAuthorization(r.resource.authorization.id), 'FOUND').resource.status).toBe('CREATED');
      return;
    }
    const auth = expectKind(await m.paypal.authorizeOrder(created.resource.id, { requestId: rid() }), 'SUCCEEDED');
    if (route === 'AUTH_CAPTURE') {
      m.server.inject(route, { type: 'PENDING' });
      const r = expectKind(await m.paypal.captureAuthorization(auth.resource.authorization.id, { amount: usd(6000) }, { requestId: rid() }), 'PENDING');
      m.server.settle(r.resource.id, 'DECLINED');
      expect(expectKind(await m.paypal.getCapture(r.resource.id), 'FOUND').resource.status).toBe('DECLINED');
      return;
    }
    const cap = expectKind(await m.paypal.captureAuthorization(auth.resource.authorization.id, { amount: usd(6000) }, { requestId: rid() }), 'SUCCEEDED');
    m.server.inject(route, { type: 'PENDING' });
    const r = expectKind(await m.paypal.refundCapture(cap.resource.id, { amount: usd(1000) }, { requestId: rid() }), 'PENDING');
    expect(m.server.statusOf(cap.resource.id)).toBe('COMPLETED');
    m.server.settle(r.resource.id, 'COMPLETED');
    expect(expectKind(await m.paypal.getRefund(r.resource.id), 'FOUND').resource.status).toBe('COMPLETED');
    expect(m.server.statusOf(cap.resource.id)).toBe('PARTIALLY_REFUNDED');
  });

  it('REFUND_FAILED: the refund is FAILED, the capture keeps its refundable amount, a new refund can succeed', async () => {
    const m = mockSetup();
    const { captureId } = await captured(m);
    m.server.inject('CAPTURE_REFUND', { type: 'REFUND_FAILED' });
    expect(await m.paypal.refundCapture(captureId, { amount: usd(1000) }, { requestId: rid() })).toMatchObject({ kind: 'FAILED', externalStatus: 'FAILED' });
    expect(m.server.statusOf(captureId)).toBe('COMPLETED');
    const retry = expectKind(await m.paypal.refundCapture(captureId, { amount: usd(6000) }, { requestId: rid() }), 'SUCCEEDED');
    expect(retry.resource.seller_payable_breakdown?.total_refunded_amount).toEqual({ currency_code: 'USD', value: '60.00' });
  });

  it('refunds above the remaining amount are rejected; the capture tracks partial and full refunds', async () => {
    const m = mockSetup();
    const { captureId } = await captured(m);
    const ten = expectKind(await m.paypal.refundCapture(captureId, { amount: usd(1000) }, { requestId: rid() }), 'SUCCEEDED');
    expect(ten.resource.seller_payable_breakdown?.total_refunded_amount?.value).toBe('10.00');
    expect(m.server.statusOf(captureId)).toBe('PARTIALLY_REFUNDED');
    const over = expectKind(await m.paypal.refundCapture(captureId, { amount: usd(5001) }, { requestId: rid() }), 'NOT_ACCEPTED');
    expect(over.error.issues).toContain('REFUND_AMOUNT_EXCEEDED');
    expect((await m.paypal.refundCapture(captureId, { amount: usd(5000) }, { requestId: rid() })).kind).toBe('SUCCEEDED');
    expect(m.server.statusOf(captureId)).toBe('REFUNDED');
    expect(await m.paypal.refundCapture(captureId, { amount: usd(1) }, { requestId: rid() })).toMatchObject({ kind: 'UNKNOWN', reason: 'ALREADY_PROCESSED' });
  });

  it('faults are consumed in order and only for their route', async () => {
    const m = mockSetup();
    m.server.inject('ORDER_CREATE', { type: 'HTTP_ERROR', status: 500 }, 2);
    expect(m.server.pendingFaults('ORDER_CREATE')).toBe(2);
    await m.paypal.getOrder('MOCK-ORDER-999999');
    expect(m.server.pendingFaults('ORDER_CREATE')).toBe(2);
    expect((await m.paypal.createOrder(orderInput('CAPTURE'), { requestId: rid() })).kind).toBe('UNKNOWN');
    expect((await m.paypal.createOrder(orderInput('CAPTURE'), { requestId: rid() })).kind).toBe('UNKNOWN');
    expect((await m.paypal.createOrder(orderInput('CAPTURE'), { requestId: rid() })).kind).toBe('SUCCEEDED');
  });
});
