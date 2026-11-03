import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/clock.ts';
import { classifyHttpError, classifyResourceStatus } from '../src/paypal/classify.ts';
import { createSandboxPayPal, loadPayPalConfig, MissingConfigError } from '../src/paypal/config.ts';
import { mismatches } from '../src/paypal/match.ts';
import { MOCK_MERCHANT_ID, MockPayPalServer } from '../src/paypal/mock-server.ts';
import { amountEquals, fromPayPalValue, toPayPalValue } from '../src/paypal/money.ts';
import type { PayPalLogEntry } from '../src/paypal/port.ts';
import { buildCreateOrder, buildRefundCapture, canonicalJson, InvalidExternalIdError } from '../src/paypal/requests.ts';
import {
  approvalUrl,
  InvalidRequestIdError,
  ModeMismatchError,
  MOCK_API_BASE,
  NonSandboxEndpointError,
  PayPalRestAdapter,
  RequestHashMismatchError,
  SANDBOX_API_BASE,
  type FetchLike,
} from '../src/paypal/rest.ts';
import { authorized, captured, expectKind, mockSetup, orderInput, rid, T0 } from './paypal-helpers.ts';

const SECRET_ID = 'sb-client-ID-4f1c9e';
const SECRET = 'EKs3cr3t-value-7d2a';

/** A Sandbox-mode adapter whose fetch is served by the mock server (no network). Records URLs and issued tokens. */
function sandboxOnMock(opts: { secret?: string; timeoutMs?: number } = {}) {
  const clock = new ManualClock(T0);
  const server = new MockPayPalServer({ clock, clientId: SECRET_ID, clientSecret: SECRET, testIdPrefix: 'TEST' });
  const urls: string[] = [];
  const tokens: string[] = [];
  const logs: PayPalLogEntry[] = [];
  const fetch: FetchLike = async (url, init) => {
    urls.push(url);
    const res = await server.fetch(url, init);
    if (url.endsWith('/v1/oauth2/token') && res.ok) {
      const body = (await res.clone().json()) as { access_token: string };
      tokens.push(body.access_token);
    }
    return res;
  };
  const paypal = createSandboxPayPal(
    { clientId: SECRET_ID, clientSecret: opts.secret ?? SECRET, apiBase: SANDBOX_API_BASE },
    { fetch, clock, logger: (e) => logs.push(e), timeoutMs: opts.timeoutMs ?? 50 },
  );
  return { clock, server, paypal, urls, tokens, logs };
}

describe('Sandbox-only endpoint', () => {
  const base = { clientId: 'id', clientSecret: 'secret', fetch: (async () => new Response()) as FetchLike };

  it.each([
    'https://api-m.paypal.com',
    'https://api.paypal.com',
    'http://api-m.sandbox.paypal.com',
    'https://api-m.sandbox.paypal.com.example.com',
    'https://api.sandbox.paypal.com',
    'https://api-m.sandbox.paypal.com/v2',
    MOCK_API_BASE,
  ])('refuses to construct a SANDBOX adapter for %s', (apiBase) => {
    expect(() => new PayPalRestAdapter({ ...base, mode: 'SANDBOX', apiBase })).toThrow(NonSandboxEndpointError);
  });

  it('accepts exactly the Sandbox base (a trailing slash is normalized)', () => {
    expect(new PayPalRestAdapter({ ...base, mode: 'SANDBOX', apiBase: SANDBOX_API_BASE }).mode).toBe('SANDBOX');
    expect(new PayPalRestAdapter({ ...base, mode: 'SANDBOX', apiBase: `${SANDBOX_API_BASE}/` }).mode).toBe('SANDBOX');
  });

  it('a MOCK adapter cannot point at the Sandbox either', () => {
    expect(() => new PayPalRestAdapter({ ...base, mode: 'MOCK', apiBase: SANDBOX_API_BASE })).toThrow();
  });

  it('loadPayPalConfig refuses a Live PAYPAL_API_BASE and defaults to the Sandbox', () => {
    const creds = { PAYPAL_CLIENT_ID: SECRET_ID, PAYPAL_CLIENT_SECRET: SECRET };
    expect(() => loadPayPalConfig({ ...creds, PAYPAL_API_BASE: 'https://api-m.paypal.com' })).toThrow(NonSandboxEndpointError);
    expect(loadPayPalConfig({ ...creds, PAYPAL_API_BASE: `${SANDBOX_API_BASE}/` }).apiBase).toBe(SANDBOX_API_BASE);
    expect(loadPayPalConfig({ ...creds, PAYPAL_API_BASE: '' }).apiBase).toBe(SANDBOX_API_BASE);
    expect(loadPayPalConfig(creds).apiBase).toBe(SANDBOX_API_BASE);
  });

  it('loadPayPalConfig names missing variables without echoing any value', () => {
    let error: unknown;
    try {
      loadPayPalConfig({ PAYPAL_CLIENT_ID: SECRET_ID, PAYPAL_CLIENT_SECRET: '  ' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MissingConfigError);
    expect((error as MissingConfigError).missing).toEqual(['PAYPAL_CLIENT_SECRET']);
    expect(String(error)).not.toContain(SECRET_ID);
  });

  it('sends every request to the Sandbox host', async () => {
    const s = sandboxOnMock();
    await s.paypal.checkCredentials();
    const created = expectKind(await s.paypal.createOrder(orderInput('AUTHORIZE'), { requestId: rid() }), 'SUCCEEDED');
    await s.paypal.getOrder(created.resource.id);
    expect(s.urls.length).toBeGreaterThanOrEqual(3);
    for (const url of s.urls) expect(new URL(url).origin).toBe(SANDBOX_API_BASE);
  });
});

describe('payment mode separation (AC12)', () => {
  it('a Sandbox adapter refuses MOCK- ids before sending anything', async () => {
    const s = sandboxOnMock();
    await expect(s.paypal.getOrder('MOCK-ORDER-000001')).rejects.toThrow(ModeMismatchError);
    await expect(s.paypal.authorizeOrder('MOCK-ORDER-000001', { requestId: rid() })).rejects.toThrow(ModeMismatchError);
    expect(s.urls).toEqual([]);
  });

  it('a MOCK adapter refuses ids that are not mock ids', async () => {
    const m = mockSetup();
    await expect(m.paypal.getCapture('3C679366HH908993F')).rejects.toThrow(ModeMismatchError);
    await expect(m.paypal.refundCapture('3C679366HH908993F', { amount: { currency: 'USD', minor: 1000 } }, { requestId: rid() })).rejects.toThrow(
      ModeMismatchError,
    );
    expect(m.server.requests).toEqual([]);
  });

  it('rejects ids that could change the request path', async () => {
    const m = mockSetup();
    await expect(m.paypal.getOrder('MOCK-1/../../v1/oauth2/token')).rejects.toThrow(InvalidExternalIdError);
    await expect(m.paypal.voidAuthorization('MOCK-1?x=1', { requestId: rid() })).rejects.toThrow(InvalidExternalIdError);
  });
});

describe('headers and token handling', () => {
  it('every POST carries its own PayPal-Request-Id and Prefer: return=representation', async () => {
    const m = mockSetup();
    const ids = { create: rid(), authorize: rid(), capture: rid(), refund: rid() };
    const created = expectKind(await m.paypal.createOrder(orderInput('AUTHORIZE'), { requestId: ids.create }), 'SUCCEEDED');
    m.server.approveOrder(created.resource.id);
    const auth = expectKind(await m.paypal.authorizeOrder(created.resource.id, { requestId: ids.authorize }), 'SUCCEEDED');
    const cap = expectKind(
      await m.paypal.captureAuthorization(auth.resource.authorization.id, { amount: { currency: 'USD', minor: 6000 } }, { requestId: ids.capture }),
      'SUCCEEDED',
    );
    await m.paypal.refundCapture(cap.resource.id, { amount: { currency: 'USD', minor: 1000 } }, { requestId: ids.refund });
    await m.paypal.getCapture(cap.resource.id);

    const posts = m.server.requests.filter((r) => r.method === 'POST' && r.route !== 'TOKEN');
    expect(posts.map((r) => r.requestId)).toEqual([ids.create, ids.authorize, ids.capture, ids.refund]);
    for (const p of posts) {
      expect(p.prefer).toBe('return=representation');
      expect(p.auth).toBe('Bearer');
    }
    const get = m.server.requests.find((r) => r.route === 'CAPTURE_GET')!;
    expect(get.requestId).toBeNull();
  });

  it('caches the token and refreshes it shortly before expiry', async () => {
    const m = mockSetup();
    await m.paypal.getOrder('MOCK-ORDER-999999');
    await m.paypal.getOrder('MOCK-ORDER-999998');
    expect(m.server.requests.filter((r) => r.route === 'TOKEN')).toHaveLength(1);
    expect(m.server.requests.find((r) => r.route === 'TOKEN')!.auth).toBe('Basic');
    m.clock.advance((32_400 - 59) * 1000); // inside the 60 s refresh margin
    await m.paypal.getOrder('MOCK-ORDER-999997');
    expect(m.server.requests.filter((r) => r.route === 'TOKEN')).toHaveLength(2);
  });

  it('on 401 drops the token, fetches a new one and resends with the same request id', async () => {
    const m = mockSetup();
    await m.paypal.checkCredentials();
    m.server.revokeTokens();
    const requestId = rid();
    const r = await m.paypal.createOrder(orderInput('CAPTURE'), { requestId });
    expect(r.kind).toBe('SUCCEEDED');
    const creates = m.server.requests.filter((x) => x.route === 'ORDER_CREATE');
    expect(creates.map((x) => x.requestId)).toEqual([requestId, requestId]);
    expect(m.server.count('orders')).toBe(1);
  });

  it('checkCredentials reports only success and lifetime', async () => {
    const s = sandboxOnMock();
    const ok = await s.paypal.checkCredentials();
    expect(ok).toEqual({ ok: true, expiresInSec: 32_400 });
    const bad = sandboxOnMock({ secret: 'wrong' });
    expect(await bad.paypal.checkCredentials()).toEqual({ ok: false, reason: 'AUTH', httpStatus: 401 });
  });

  it('rejects a malformed request id', async () => {
    const m = mockSetup();
    await expect(m.paypal.createOrder(orderInput('CAPTURE'), { requestId: 'short' })).rejects.toThrow(InvalidRequestIdError);
  });
});

describe('request hash and idempotency', () => {
  it('the hash is the canonical hash of the built request and is returned with the result', async () => {
    const m = mockSetup();
    const input = orderInput('AUTHORIZE');
    const built = buildCreateOrder(input);
    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(buildCreateOrder({ ...input }).hash).toBe(built.hash);
    expect(buildCreateOrder({ ...input, amount: { currency: 'USD', minor: 6001 } }).hash).not.toBe(built.hash);
    expect(buildRefundCapture('MOCK-CAPTURE-1', { amount: { currency: 'USD', minor: 1000 } }).hash).not.toBe(
      buildRefundCapture('MOCK-CAPTURE-2', { amount: { currency: 'USD', minor: 1000 } }).hash,
    );
    const r = await m.paypal.createOrder(input, { requestId: rid(), expectedRequestHash: built.hash });
    expect(r.requestHash).toBe(built.hash);
  });

  it('canonical JSON does not depend on key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: [1, { x: 2, y: 1 }] }, b: 1 }));
  });

  it('refuses to send a body that differs from the stored hash', async () => {
    const m = mockSetup();
    const { captureId } = await captured(m);
    const stored = buildRefundCapture(captureId, { amount: { currency: 'USD', minor: 1000 } }).hash;
    const before = m.server.requests.length;
    await expect(
      m.paypal.refundCapture(captureId, { amount: { currency: 'USD', minor: 1100 } }, { requestId: rid(), expectedRequestHash: stored }),
    ).rejects.toThrow(RequestHashMismatchError);
    expect(m.server.requests.length).toBe(before);
    expect(m.server.count('refunds')).toBe(0);
  });

  it('a resend with the same request id returns the same resource and creates nothing new', async () => {
    const m = mockSetup();
    const requestId = rid();
    const input = orderInput('CAPTURE');
    const a = expectKind(await m.paypal.createOrder(input, { requestId }), 'SUCCEEDED');
    const b = expectKind(await m.paypal.createOrder(input, { requestId }), 'SUCCEEDED');
    expect(b.resource.id).toBe(a.resource.id);
    expect(m.server.count('orders')).toBe(1);

    const { captureId } = await captured(m);
    const refundId = rid();
    const r1 = expectKind(await m.paypal.refundCapture(captureId, { amount: { currency: 'USD', minor: 1000 } }, { requestId: refundId }), 'SUCCEEDED');
    const r2 = expectKind(await m.paypal.refundCapture(captureId, { amount: { currency: 'USD', minor: 1000 } }, { requestId: refundId }), 'SUCCEEDED');
    expect(r2.resource.id).toBe(r1.resource.id);
    expect(m.server.count('refunds')).toBe(1);
  });

  it('recovers a capture whose response was lost by resending the same id', async () => {
    const m = mockSetup();
    const { authorizationId } = await authorized(m);
    m.server.inject('AUTH_CAPTURE', { type: 'RESPONSE_LOST' });
    const ctx = { requestId: rid() };
    const lost = await m.paypal.captureAuthorization(authorizationId, { amount: { currency: 'USD', minor: 6000 } }, ctx);
    expect(lost).toMatchObject({ kind: 'UNKNOWN', reason: 'NETWORK' });
    expect(m.server.count('captures')).toBe(1); // PayPal did capture

    const again = expectKind(
      await m.paypal.captureAuthorization(authorizationId, { amount: { currency: 'USD', minor: 6000 } }, { ...ctx, priorUnknownSend: true }),
      'SUCCEEDED',
    );
    expect(m.server.count('captures')).toBe(1);
    expect(m.server.statusOf(again.resource.id)).toBe('COMPLETED');
  });
});

describe('outcome classification (DESIGN 7.1)', () => {
  it('SUCCEEDED for each operation when the resource status is the expected one', async () => {
    const m = mockSetup();
    const created = await m.paypal.createOrder(orderInput('AUTHORIZE'), { requestId: rid() });
    expect(created).toMatchObject({ kind: 'SUCCEEDED', externalStatus: 'PAYER_ACTION_REQUIRED' });
    const { authorizationId } = await authorized(m);
    const voided = await m.paypal.voidAuthorization(authorizationId, { requestId: rid() });
    expect(voided).toMatchObject({ kind: 'SUCCEEDED', externalStatus: 'VOIDED', confirmedBy: 'RESPONSE' });
    const { captureId } = await captured(m);
    const refund = await m.paypal.refundCapture(captureId, { amount: { currency: 'USD', minor: 1000 } }, { requestId: rid() });
    expect(refund).toMatchObject({ kind: 'SUCCEEDED', externalStatus: 'COMPLETED' });
  });

  it('authorize returns the authorization with id, status, expiry and amount', async () => {
    const m = mockSetup();
    const created = expectKind(await m.paypal.createOrder(orderInput('AUTHORIZE'), { requestId: rid() }), 'SUCCEEDED');
    m.server.approveOrder(created.resource.id);
    const r = expectKind(await m.paypal.authorizeOrder(created.resource.id, { requestId: rid() }), 'SUCCEEDED');
    expect(r.resource.authorization).toMatchObject({ status: 'CREATED', amount: { currency_code: 'USD', value: '60.00' }, custom_id: 'case:C7:v3:att:AT1' });
    expect(r.resource.authorization.expiration_time).toBeTruthy();
    expect(r.resource.order.status).toBe('COMPLETED');
  });

  it('PENDING when PayPal reports PENDING; a later query shows the final state', async () => {
    const m = mockSetup();
    const { authorizationId } = await authorized(m);
    m.server.inject('AUTH_CAPTURE', { type: 'PENDING' });
    const r = expectKind(await m.paypal.captureAuthorization(authorizationId, { amount: { currency: 'USD', minor: 6000 } }, { requestId: rid() }), 'PENDING');
    m.server.settle(r.resource.id, 'COMPLETED');
    expect(expectKind(await m.paypal.getCapture(r.resource.id), 'FOUND').resource.status).toBe('COMPLETED');
  });

  it('FAILED when the refund comes back FAILED', async () => {
    const m = mockSetup();
    const { captureId } = await captured(m);
    m.server.inject('CAPTURE_REFUND', { type: 'REFUND_FAILED' });
    const r = await m.paypal.refundCapture(captureId, { amount: { currency: 'USD', minor: 1000 } }, { requestId: rid() });
    expect(r).toMatchObject({ kind: 'FAILED', externalStatus: 'FAILED' });
  });

  it('NOT_ACCEPTED for a first-send 422, UNKNOWN for the same 422 after an unknown send', async () => {
    const m = mockSetup();
    const { captureId } = await captured(m);
    const over = { amount: { currency: 'USD', minor: 6001 } };
    const first = expectKind(await m.paypal.refundCapture(captureId, over, { requestId: rid() }), 'NOT_ACCEPTED');
    expect(first.httpStatus).toBe(422);
    expect(first.error.issues).toContain('REFUND_AMOUNT_EXCEEDED');
    const after = await m.paypal.refundCapture(captureId, over, { requestId: rid(), priorUnknownSend: true });
    expect(after).toMatchObject({ kind: 'UNKNOWN', reason: 'HTTP_4XX_AFTER_UNKNOWN', httpStatus: 422 });
  });

  it('UNKNOWN (already processed) for issues saying the target was already acted on', async () => {
    const m = mockSetup();
    const { orderId, authorizationId } = await authorized(m);
    expect(await m.paypal.authorizeOrder(orderId, { requestId: rid() })).toMatchObject({ kind: 'UNKNOWN', reason: 'ALREADY_PROCESSED' });
    await m.paypal.voidAuthorization(authorizationId, { requestId: rid() });
    const again = await m.paypal.voidAuthorization(authorizationId, { requestId: rid() });
    expect(again).toMatchObject({ kind: 'UNKNOWN', reason: 'ALREADY_PROCESSED' });
  });

  it.each([
    [{ type: 'HTTP_ERROR', status: 500 } as const, 'HTTP_5XX'],
    [{ type: 'HTTP_ERROR', status: 503 } as const, 'HTTP_5XX'],
    [{ type: 'HTTP_ERROR', status: 429 } as const, 'HTTP_429'],
    [{ type: 'TIMEOUT' } as const, 'TIMEOUT'],
    [{ type: 'RESPONSE_LOST' } as const, 'NETWORK'],
  ])('UNKNOWN for %o', async (fault, reason) => {
    const m = mockSetup();
    m.server.inject('ORDER_CREATE', fault);
    expect(await m.paypal.createOrder(orderInput('CAPTURE'), { requestId: rid() })).toMatchObject({ kind: 'UNKNOWN', reason });
  });

  it('AUTH_ERROR when the API still answers 401 after a fresh token', async () => {
    const m = mockSetup();
    m.server.inject('ORDER_CREATE', { type: 'UNAUTHORIZED' }, 2);
    expect(await m.paypal.createOrder(orderInput('CAPTURE'), { requestId: rid() })).toMatchObject({ kind: 'AUTH_ERROR', httpStatus: 401 });
    expect(m.server.count('orders')).toBe(0);
  });

  it('NOT_SENT when no token can be obtained', async () => {
    const s = sandboxOnMock({ secret: 'wrong' });
    expect(await s.paypal.createOrder(orderInput('CAPTURE'), { requestId: rid() })).toMatchObject({ kind: 'NOT_SENT', reason: 'AUTH' });
    expect(s.server.requests.filter((r) => r.route !== 'TOKEN')).toEqual([]);
  });

  it('UNKNOWN for a 404 on a POST and for a 2xx body that does not validate', async () => {
    const m = mockSetup();
    expect(await m.paypal.authorizeOrder('MOCK-ORDER-999999', { requestId: rid() })).toMatchObject({ kind: 'UNKNOWN', reason: 'HTTP_4XX_OTHER', httpStatus: 404 });

    const server = new MockPayPalServer();
    const garbled: FetchLike = async (url, init) => {
      const res = await server.fetch(url, init);
      return url.endsWith('/v2/checkout/orders') ? new Response('{"id":', { status: 201 }) : res;
    };
    const p = new PayPalRestAdapter({ mode: 'MOCK', apiBase: MOCK_API_BASE, clientId: 'MOCK-CLIENT-ID', clientSecret: 'MOCK-CLIENT-SECRET', fetch: garbled });
    expect(await p.createOrder(orderInput('CAPTURE'), { requestId: rid() })).toMatchObject({ kind: 'UNKNOWN', reason: 'INVALID_RESPONSE', httpStatus: 201 });
  });

  it('a void answered 204 without a body is confirmed by querying the authorization', async () => {
    const clock = new ManualClock(T0);
    const server = new MockPayPalServer({ clock });
    const minimalVoid: FetchLike = (url, init) => {
      if (!url.endsWith('/void')) return server.fetch(url, init);
      const headers = new Headers(init.headers);
      headers.delete('prefer');
      return server.fetch(url, { ...init, headers });
    };
    const p = new PayPalRestAdapter({ mode: 'MOCK', apiBase: MOCK_API_BASE, clientId: 'MOCK-CLIENT-ID', clientSecret: 'MOCK-CLIENT-SECRET', fetch: minimalVoid, clock });
    const { authorizationId } = await authorized({ clock, server, paypal: p, logs: [] });
    const r = await p.voidAuthorization(authorizationId, { requestId: rid() });
    expect(r).toMatchObject({ kind: 'SUCCEEDED', externalStatus: 'VOIDED', confirmedBy: 'QUERY' });
  });

  it('pure rules: resource statuses', () => {
    expect(classifyResourceStatus('ORDER_CREATE', 'CREATED').kind).toBe('SUCCEEDED');
    expect(classifyResourceStatus('ORDER_CREATE', 'APPROVED')).toEqual({ kind: 'UNKNOWN', reason: 'UNEXPECTED_STATUS' });
    expect(classifyResourceStatus('ORDER_AUTHORIZE', 'DENIED').kind).toBe('FAILED');
    expect(classifyResourceStatus('AUTH_CAPTURE', 'DECLINED').kind).toBe('FAILED');
    expect(classifyResourceStatus('AUTH_CAPTURE', 'REFUNDED')).toEqual({ kind: 'UNKNOWN', reason: 'UNEXPECTED_STATUS' });
    expect(classifyResourceStatus('CAPTURE_REFUND', 'CANCELLED').kind).toBe('FAILED');
    expect(classifyResourceStatus('CAPTURE_REFUND', 'PENDING').kind).toBe('PENDING');
    expect(classifyResourceStatus('CAPTURE_REFUND', 'SOMETHING_NEW')).toEqual({ kind: 'UNKNOWN', reason: 'UNEXPECTED_STATUS' });
  });

  it('pure rules: HTTP errors', () => {
    expect(classifyHttpError(400, ['INVALID_PARAMETER_VALUE'], false).kind).toBe('NOT_ACCEPTED');
    expect(classifyHttpError(422, ['ORDER_NOT_APPROVED'], false).kind).toBe('NOT_ACCEPTED');
    expect(classifyHttpError(422, ['ORDER_NOT_APPROVED'], true)).toEqual({ kind: 'UNKNOWN', reason: 'HTTP_4XX_AFTER_UNKNOWN' });
    expect(classifyHttpError(422, ['DUPLICATE_INVOICE_ID'], false)).toEqual({ kind: 'UNKNOWN', reason: 'ALREADY_PROCESSED' });
    expect(classifyHttpError(409, ['PREVIOUS_REQUEST_IN_PROGRESS'], false)).toEqual({ kind: 'UNKNOWN', reason: 'ALREADY_PROCESSED' });
    expect(classifyHttpError(403, [], false).kind).toBe('AUTH_ERROR');
    expect(classifyHttpError(401, [], true).kind).toBe('AUTH_ERROR');
    expect(classifyHttpError(429, [], false)).toEqual({ kind: 'UNKNOWN', reason: 'HTTP_429' });
    expect(classifyHttpError(502, [], false)).toEqual({ kind: 'UNKNOWN', reason: 'HTTP_5XX' });
  });
});

describe('no secrets in logs', () => {
  it('log entries, errors and the adapter object never contain credentials, tokens or ids', async () => {
    const s = sandboxOnMock();
    const order = expectKind(await s.paypal.createOrder(orderInput('CAPTURE'), { requestId: rid() }), 'SUCCEEDED');
    s.server.approveOrder(order.resource.id);
    const cap = expectKind(await s.paypal.captureOrder(order.resource.id, { requestId: rid() }), 'SUCCEEDED');
    await s.paypal.refundCapture(cap.resource.capture.id, { amount: { currency: 'USD', minor: 99_999 } }, { requestId: rid() });
    s.server.revokeTokens();
    await s.paypal.getCapture(cap.resource.capture.id);
    s.server.inject('CAPTURE_GET', { type: 'TIMEOUT' });
    await s.paypal.getCapture(cap.resource.capture.id);
    const bad = sandboxOnMock({ secret: `${SECRET}-wrong` });
    await bad.paypal.checkCredentials();

    expect(s.tokens.length).toBe(2);
    const basic = Buffer.from(`${SECRET_ID}:${SECRET}`).toString('base64');
    const haystack = [JSON.stringify(s.logs), JSON.stringify(bad.logs), inspect(s.paypal, { depth: 5 }), JSON.stringify(s.paypal)].join('\n');
    for (const needle of [SECRET_ID, SECRET, basic, ...s.tokens, order.resource.id, cap.resource.capture.id]) {
      expect(haystack).not.toContain(needle);
    }
    expect(s.logs.map((l) => l.event)).toContain('paypal.token');
    expect(s.logs.find((l) => l.event === 'paypal.send')).toMatchObject({ route: '/v2/checkout/orders', mode: 'SANDBOX' });
  });
});

describe('helpers', () => {
  it('money conversion is exact', () => {
    expect(toPayPalValue({ currency: 'USD', minor: 6000 })).toBe('60.00');
    expect(toPayPalValue({ currency: 'USD', minor: 5 })).toBe('0.05');
    expect(toPayPalValue({ currency: 'JPY', minor: 1200 })).toBe('1200');
    expect(fromPayPalValue('50.01', 'USD')).toBe(5001);
    expect(fromPayPalValue('50.1', 'USD')).toBeNull();
    expect(fromPayPalValue('1e3', 'USD')).toBeNull();
    expect(amountEquals({ currency_code: 'USD', value: '10.00' }, { currency: 'USD', minor: 1000 })).toBe(true);
    expect(amountEquals({ currency_code: 'JPY', value: '10' }, { currency: 'USD', minor: 1000 })).toBe(false);
    expect(() => toPayPalValue({ currency: 'USD', minor: 1.5 })).toThrow(RangeError);
  });

  it('approval links are accepted only on the expected PayPal host', () => {
    const order = (href: string) => ({ id: 'X', status: 'PAYER_ACTION_REQUIRED', links: [{ href, rel: 'payer-action' }] });
    expect(approvalUrl(order('https://www.sandbox.paypal.com/checkoutnow?token=5O1'), 'SANDBOX')).toBe('https://www.sandbox.paypal.com/checkoutnow?token=5O1');
    expect(approvalUrl(order('https://www.paypal.com/checkoutnow?token=5O1'), 'SANDBOX')).toBeNull();
    expect(approvalUrl(order('https://evil.example/checkoutnow'), 'SANDBOX')).toBeNull();
    expect(approvalUrl(order(`${MOCK_API_BASE}/checkoutnow?token=MOCK-ORDER-1`), 'MOCK')).not.toBeNull();
  });

  it('mismatches lists the fields that differ', () => {
    const capture = { amount: { currency_code: 'USD', value: '60.00' }, custom_id: 'case:C7', payee: { merchant_id: MOCK_MERCHANT_ID } };
    expect(mismatches(capture, { amount: { currency: 'USD', minor: 6000 }, customId: 'case:C7', payeeMerchantId: MOCK_MERCHANT_ID })).toEqual([]);
    expect(mismatches(capture, { amount: { currency: 'USD', minor: 5000 }, customId: 'case:C8', payeeMerchantId: 'OTHER' })).toEqual([
      'amount',
      'custom_id',
      'payee',
    ]);
  });
});
