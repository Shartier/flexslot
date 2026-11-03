// In-process mock of the PayPal REST endpoints FlexSlot uses, with fault injection (DESIGN 2, AC08, AC09).
// It answers a fetch-compatible function, so the real REST adapter runs unchanged on top of it.
// Every id starts with "MOCK-". Behaviour follows the public docs where known; where Sandbox behaviour is
// still unconfirmed (STATUS U03-U05) the mock's choice is marked "mock choice" and must not be cited as PayPal's.

import { randomUUID } from 'node:crypto';
import { systemClock, type Clock } from '../clock.ts';
import { fromPayPalValue, toPayPalValue, type Money } from './money.ts';
import { MOCK_API_BASE, PayPalRestAdapter, type FetchLike } from './rest.ts';
import type { PayPalLogger } from './port.ts';

export const MOCK_CLIENT_ID = 'MOCK-CLIENT-ID';
export const MOCK_CLIENT_SECRET = 'MOCK-CLIENT-SECRET';
export const MOCK_MERCHANT_ID = 'MOCKMERCHANT01';

export type MockRoute =
  | 'TOKEN'
  | 'ORDER_CREATE'
  | 'ORDER_GET'
  | 'ORDER_AUTHORIZE'
  | 'ORDER_CAPTURE'
  | 'AUTH_GET'
  | 'AUTH_CAPTURE'
  | 'AUTH_VOID'
  | 'CAPTURE_GET'
  | 'CAPTURE_REFUND'
  | 'REFUND_GET';

export type MockFault =
  /** PayPal processes the request, then the connection drops before the response arrives. */
  | { type: 'RESPONSE_LOST' }
  /** An HTTP error (5xx, 429, ...) instead of the normal answer; `processed` = the request still took effect. */
  | { type: 'HTTP_ERROR'; status: number; processed?: boolean }
  /** No answer until the caller aborts; `processed` = the request still took effect. */
  | { type: 'TIMEOUT'; processed?: boolean }
  /** The authorization / capture / refund created by this request is PENDING. */
  | { type: 'PENDING' }
  /** The refund created by this request is FAILED. */
  | { type: 'REFUND_FAILED' }
  /** 401 without processing (e.g. an access token revoked early). */
  | { type: 'UNAUTHORIZED' };

export interface MockRequestRecord {
  route: MockRoute | 'UNMATCHED';
  method: string;
  prefer: string | null;
  requestId: string | null;
  auth: 'Basic' | 'Bearer' | 'none';
  hasBody: boolean;
}

interface MockOrder {
  id: string;
  intent: 'CAPTURE' | 'AUTHORIZE';
  status: string;
  amount: Money;
  customId: string | undefined;
  invoiceId: string | undefined;
  payerActionLink: boolean;
  authorizationIds: string[];
  captureIds: string[];
  createTime: string;
  updateTime: string;
}

interface MockAuthorization {
  id: string;
  orderId: string;
  status: string;
  amount: Money;
  customId: string | undefined;
  invoiceId: string | undefined;
  expirationTime: string;
  captureIds: string[];
  createTime: string;
  updateTime: string;
}

interface MockCapture {
  id: string;
  orderId: string;
  authorizationId: string | undefined;
  status: string;
  amount: Money;
  customId: string | undefined;
  invoiceId: string | undefined;
  refundIds: string[];
  createTime: string;
  updateTime: string;
}

interface MockRefund {
  id: string;
  captureId: string;
  status: string;
  amount: Money;
  invoiceId: string | undefined;
  createTime: string;
  updateTime: string;
}

export interface MockServerOptions {
  clock?: Clock;
  clientId?: string;
  clientSecret?: string;
  tokenLifetimeSec?: number;
  /**
   * Test-only: id prefix other than "MOCK-", so unit tests can run the SANDBOX-mode adapter (which refuses
   * mock ids) against this server without the network. The MOCK implementation always uses "MOCK-".
   */
  testIdPrefix?: string;
}

const ROUTES: ReadonlyArray<[string, RegExp, MockRoute]> = [
  ['POST', /^\/v1\/oauth2\/token$/, 'TOKEN'],
  ['POST', /^\/v2\/checkout\/orders$/, 'ORDER_CREATE'],
  ['GET', /^\/v2\/checkout\/orders\/([^/]+)$/, 'ORDER_GET'],
  ['POST', /^\/v2\/checkout\/orders\/([^/]+)\/authorize$/, 'ORDER_AUTHORIZE'],
  ['POST', /^\/v2\/checkout\/orders\/([^/]+)\/capture$/, 'ORDER_CAPTURE'],
  ['GET', /^\/v2\/payments\/authorizations\/([^/]+)$/, 'AUTH_GET'],
  ['POST', /^\/v2\/payments\/authorizations\/([^/]+)\/capture$/, 'AUTH_CAPTURE'],
  ['POST', /^\/v2\/payments\/authorizations\/([^/]+)\/void$/, 'AUTH_VOID'],
  ['GET', /^\/v2\/payments\/captures\/([^/]+)$/, 'CAPTURE_GET'],
  ['POST', /^\/v2\/payments\/captures\/([^/]+)\/refund$/, 'CAPTURE_REFUND'],
  ['GET', /^\/v2\/payments\/refunds\/([^/]+)$/, 'REFUND_GET'],
];

const AUTHORIZATION_LIFETIME_MS = 29 * 24 * 60 * 60 * 1000;

export class MockPayPalServer {
  readonly requests: MockRequestRecord[] = [];
  readonly #clock: Clock;
  readonly #basic: string;
  readonly #tokenLifetimeSec: number;
  readonly #idPrefix: string;
  readonly #tokens = new Map<string, number>();
  readonly #faults = new Map<MockRoute, MockFault[]>();
  /**
   * Stored 2xx answers per (route, PayPal-Request-Id). A resend of a Payments API call returns the original
   * answer; a resend of order authorize / capture returns the order's current state (both seen in Sandbox,
   * 2026-11-03, see STATUS). `orderId` marks the second kind.
   */
  readonly #idempotent = new Map<string, { status: number; body: string; orderId?: string }>();
  readonly #orders = new Map<string, MockOrder>();
  readonly #auths = new Map<string, MockAuthorization>();
  readonly #captures = new Map<string, MockCapture>();
  readonly #refunds = new Map<string, MockRefund>();
  #seq = 0;

  constructor(opts: MockServerOptions = {}) {
    this.#clock = opts.clock ?? systemClock;
    this.#basic = `Basic ${Buffer.from(`${opts.clientId ?? MOCK_CLIENT_ID}:${opts.clientSecret ?? MOCK_CLIENT_SECRET}`).toString('base64')}`;
    this.#tokenLifetimeSec = opts.tokenLifetimeSec ?? 32_400;
    this.#idPrefix = opts.testIdPrefix ?? 'MOCK-';
  }

  // ---- test controls ---------------------------------------------------------

  /** Queues a fault for the next `times` requests to `route`. */
  inject(route: MockRoute, fault: MockFault, times = 1): void {
    const queue = this.#faults.get(route) ?? [];
    for (let i = 0; i < times; i++) queue.push(fault);
    this.#faults.set(route, queue);
  }

  pendingFaults(route: MockRoute): number {
    return this.#faults.get(route)?.length ?? 0;
  }

  /** The buyer approves the order on the PayPal page. */
  approveOrder(orderId: string): void {
    const o = this.#orders.get(orderId);
    if (!o || (o.status !== 'CREATED' && o.status !== 'PAYER_ACTION_REQUIRED')) throw new Error(`mock: order cannot be approved`);
    o.status = 'APPROVED';
    o.updateTime = this.#now();
  }

  /** Moves a PENDING authorization / capture / refund to a final status, as PayPal would later. */
  settle(id: string, status: string): void {
    const r = this.#auths.get(id) ?? this.#captures.get(id) ?? this.#refunds.get(id);
    if (!r) throw new Error('mock: unknown id');
    r.status = status;
    r.updateTime = this.#now();
    if (this.#refunds.has(id)) this.#updateCaptureAfterRefunds(this.#refunds.get(id)!.captureId);
  }

  /** Revokes every issued token (the next API call gets 401). */
  revokeTokens(): void {
    this.#tokens.clear();
  }

  statusOf(id: string): string | undefined {
    return (this.#orders.get(id) ?? this.#auths.get(id) ?? this.#captures.get(id) ?? this.#refunds.get(id))?.status;
  }

  count(kind: 'orders' | 'authorizations' | 'captures' | 'refunds'): number {
    return { orders: this.#orders, authorizations: this.#auths, captures: this.#captures, refunds: this.#refunds }[kind].size;
  }

  // ---- fetch -------------------------------------------------------------------

  readonly fetch: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : '';
    const match = matchRoute(method, u.pathname);
    const authHeader = headers.get('authorization') ?? '';
    this.requests.push({
      route: match?.route ?? 'UNMATCHED',
      method,
      prefer: headers.get('prefer'),
      requestId: headers.get('paypal-request-id'),
      auth: authHeader.startsWith('Basic ') ? 'Basic' : authHeader.startsWith('Bearer ') ? 'Bearer' : 'none',
      hasBody: body !== '',
    });
    if (!match) return errorResponse(404, 'RESOURCE_NOT_FOUND', 'RESOURCE_NOT_FOUND');

    const fault = this.#faults.get(match.route)?.shift();
    if (fault?.type === 'UNAUTHORIZED') return jsonResponse(401, { error: 'invalid_token', error_description: 'mock: token rejected' });
    if (fault?.type === 'HTTP_ERROR' && !fault.processed) return httpError(fault.status);
    if (fault?.type === 'TIMEOUT' && !fault.processed) return hang(init.signal);

    const response = await this.#handle(match.route, match.id, headers, body, fault);
    if (fault?.type === 'RESPONSE_LOST') throw new TypeError('fetch failed (mock: response lost after processing)');
    if (fault?.type === 'HTTP_ERROR') return httpError(fault.status);
    if (fault?.type === 'TIMEOUT') return hang(init.signal);
    return response;
  };

  async #handle(route: MockRoute, id: string | undefined, headers: Headers, body: string, fault: MockFault | undefined): Promise<Response> {
    if (route === 'TOKEN') return this.#token(headers, body);
    if (!this.#bearerValid(headers.get('authorization'))) {
      return jsonResponse(401, { error: 'invalid_token', error_description: 'mock: token missing or expired' });
    }
    const full = (headers.get('prefer') ?? '').includes('return=representation');
    if (route.endsWith('_GET')) return this.#get(route, id!);

    const requestId = headers.get('paypal-request-id');
    const key = requestId ? `${route} ${requestId}` : null;
    const stored = key ? this.#idempotent.get(key) : undefined;
    if (stored?.orderId) return jsonResponse(stored.status, this.#renderOrder(this.#orders.get(stored.orderId)!, full));
    if (stored) return new Response(stored.body === '' ? null : stored.body, { status: stored.status, headers: JSON_HEADERS });

    const response = this.#post(route, id, parseBody(body), full, fault);
    if (key && response.status >= 200 && response.status < 300) {
      const text = await response.text();
      const replaysCurrentOrder = route === 'ORDER_AUTHORIZE' || route === 'ORDER_CAPTURE';
      this.#idempotent.set(key, { status: response.status, body: text, ...(replaysCurrentOrder ? { orderId: id! } : {}) });
      return new Response(text === '' ? null : text, { status: response.status, headers: response.headers });
    }
    return response;
  }

  #token(headers: Headers, body: string): Response {
    if (headers.get('authorization') !== this.#basic || body !== 'grant_type=client_credentials') {
      return jsonResponse(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    }
    const token = `MOCK-TOKEN-${randomUUID()}`;
    this.#tokens.set(token, this.#clock.now() + this.#tokenLifetimeSec * 1000);
    return jsonResponse(200, { access_token: token, token_type: 'Bearer', expires_in: this.#tokenLifetimeSec, app_id: 'MOCK-APP' });
  }

  #bearerValid(header: string | null): boolean {
    if (!header?.startsWith('Bearer ')) return false;
    const expiresAt = this.#tokens.get(header.slice('Bearer '.length));
    return expiresAt !== undefined && this.#clock.now() < expiresAt;
  }

  #get(route: MockRoute, id: string): Response {
    switch (route) {
      case 'ORDER_GET': {
        const o = this.#orders.get(id);
        return o ? jsonResponse(200, this.#renderOrder(o, true)) : notFound();
      }
      case 'AUTH_GET': {
        const a = this.#auths.get(id);
        return a ? jsonResponse(200, this.#renderAuth(a)) : notFound();
      }
      case 'CAPTURE_GET': {
        const c = this.#captures.get(id);
        return c ? jsonResponse(200, this.#renderCapture(c)) : notFound();
      }
      default: {
        const r = this.#refunds.get(id);
        return r ? jsonResponse(200, this.#renderRefund(r)) : notFound();
      }
    }
  }

  #post(route: MockRoute, id: string | undefined, body: Record<string, unknown> | null, full: boolean, fault: MockFault | undefined): Response {
    const pending = fault?.type === 'PENDING';
    switch (route) {
      case 'ORDER_CREATE':
        return this.#createOrder(body, full);
      case 'ORDER_AUTHORIZE': {
        const o = this.#orders.get(id!);
        if (!o) return notFound();
        if (o.intent !== 'AUTHORIZE') return unprocessable('ACTION_DOES_NOT_MATCH_INTENT');
        if (o.authorizationIds.length > 0) return unprocessable('ORDER_ALREADY_AUTHORIZED');
        if (o.status !== 'APPROVED') return unprocessable('ORDER_NOT_APPROVED');
        const now = this.#now();
        const a: MockAuthorization = {
          id: this.#nextId('AUTH'),
          orderId: o.id,
          status: pending ? 'PENDING' : 'CREATED',
          amount: o.amount,
          customId: o.customId,
          invoiceId: o.invoiceId,
          expirationTime: new Date(this.#clock.now() + AUTHORIZATION_LIFETIME_MS).toISOString(),
          captureIds: [],
          createTime: now,
          updateTime: now,
        };
        this.#auths.set(a.id, a);
        o.authorizationIds.push(a.id);
        o.status = 'COMPLETED';
        o.updateTime = now;
        return jsonResponse(201, this.#renderOrder(o, full));
      }
      case 'ORDER_CAPTURE': {
        const o = this.#orders.get(id!);
        if (!o) return notFound();
        if (o.intent !== 'CAPTURE') return unprocessable('ACTION_DOES_NOT_MATCH_INTENT');
        if (o.captureIds.length > 0) return unprocessable('ORDER_ALREADY_CAPTURED');
        if (o.status !== 'APPROVED') return unprocessable('ORDER_NOT_APPROVED');
        const c = this.#newCapture(o, undefined, o.amount, o.invoiceId, pending);
        o.status = 'COMPLETED';
        o.updateTime = c.createTime;
        return jsonResponse(201, this.#renderOrder(o, full));
      }
      case 'AUTH_CAPTURE': {
        const a = this.#auths.get(id!);
        if (!a) return notFound();
        if (a.status === 'VOIDED') return unprocessable('AUTHORIZATION_VOIDED');
        if (a.status === 'CAPTURED') return unprocessable('AUTHORIZATION_ALREADY_CAPTURED');
        if (a.status !== 'CREATED') return unprocessable('UNPROCESSABLE_ENTITY');
        const amount = body?.amount === undefined ? a.amount : parseAmount(body.amount);
        if (!amount) return invalid('INVALID_PARAMETER_VALUE');
        if (amount.currency !== a.amount.currency) return unprocessable('AUTH_CAPTURE_CURRENCY_MISMATCH');
        if (amount.minor > a.amount.minor) return unprocessable('MAX_CAPTURE_AMOUNT_EXCEEDED');
        const o = this.#orders.get(a.orderId)!;
        const invoiceId = typeof body?.invoice_id === 'string' ? body.invoice_id : a.invoiceId;
        const c = this.#newCapture(o, a.id, amount, invoiceId, pending);
        a.status = 'CAPTURED';
        a.captureIds.push(c.id);
        a.updateTime = c.createTime;
        return jsonResponse(201, full ? this.#renderCapture(c) : minimal(c.id, c.status));
      }
      case 'AUTH_VOID': {
        const a = this.#auths.get(id!);
        if (!a) return notFound();
        if (a.status === 'CAPTURED') return unprocessable('PREVIOUSLY_CAPTURED');
        if (a.status === 'VOIDED') return unprocessable('PREVIOUSLY_VOIDED');
        a.status = 'VOIDED';
        a.updateTime = this.#now();
        return full ? jsonResponse(200, this.#renderAuth(a)) : new Response(null, { status: 204 });
      }
      case 'CAPTURE_REFUND': {
        const c = this.#captures.get(id!);
        if (!c) return notFound();
        if (c.status === 'REFUNDED') return unprocessable('CAPTURE_FULLY_REFUNDED');
        if (c.status !== 'COMPLETED' && c.status !== 'PARTIALLY_REFUNDED') return unprocessable('UNPROCESSABLE_ENTITY');
        // Mock choice: PENDING refunds also reserve the refundable remainder.
        const committed = c.refundIds
          .map((rid) => this.#refunds.get(rid)!)
          .filter((r) => r.status === 'COMPLETED' || r.status === 'PENDING')
          .reduce((sum, r) => sum + r.amount.minor, 0);
        const remaining = c.amount.minor - committed;
        const amount = body?.amount === undefined ? { currency: c.amount.currency, minor: remaining } : parseAmount(body.amount);
        if (!amount || amount.minor <= 0) return invalid('INVALID_PARAMETER_VALUE');
        if (amount.currency !== c.amount.currency) return unprocessable('REFUND_CAPTURE_CURRENCY_MISMATCH');
        if (amount.minor > remaining) return unprocessable('REFUND_AMOUNT_EXCEEDED');
        const now = this.#now();
        const r: MockRefund = {
          id: this.#nextId('REFUND'),
          captureId: c.id,
          status: fault?.type === 'REFUND_FAILED' ? 'FAILED' : pending ? 'PENDING' : 'COMPLETED',
          amount,
          invoiceId: typeof body?.invoice_id === 'string' ? body.invoice_id : undefined,
          createTime: now,
          updateTime: now,
        };
        this.#refunds.set(r.id, r);
        c.refundIds.push(r.id);
        this.#updateCaptureAfterRefunds(c.id);
        return jsonResponse(201, full ? this.#renderRefund(r) : minimal(r.id, r.status));
      }
      default:
        return notFound();
    }
  }

  #createOrder(body: Record<string, unknown> | null, full: boolean): Response {
    const intent = body?.intent;
    const units = body?.purchase_units;
    if ((intent !== 'CAPTURE' && intent !== 'AUTHORIZE') || !Array.isArray(units) || units.length !== 1) {
      return invalid('INVALID_PARAMETER_VALUE');
    }
    const pu = units[0] as Record<string, unknown>;
    const amount = parseAmount(pu.amount);
    if (!amount || amount.minor <= 0) return invalid('INVALID_PARAMETER_VALUE');
    const now = this.#now();
    const payerAction = typeof body?.payment_source === 'object' && body.payment_source !== null;
    const o: MockOrder = {
      id: this.#nextId('ORDER'),
      intent,
      status: payerAction ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
      amount,
      customId: typeof pu.custom_id === 'string' ? pu.custom_id : undefined,
      invoiceId: typeof pu.invoice_id === 'string' ? pu.invoice_id : undefined,
      payerActionLink: payerAction,
      authorizationIds: [],
      captureIds: [],
      createTime: now,
      updateTime: now,
    };
    this.#orders.set(o.id, o);
    return jsonResponse(200, this.#renderOrder(o, full));
  }

  #newCapture(o: MockOrder, authorizationId: string | undefined, amount: Money, invoiceId: string | undefined, pending: boolean): MockCapture {
    const now = this.#now();
    const c: MockCapture = {
      id: this.#nextId('CAPTURE'),
      orderId: o.id,
      authorizationId,
      status: pending ? 'PENDING' : 'COMPLETED',
      amount,
      customId: o.customId,
      invoiceId,
      refundIds: [],
      createTime: now,
      updateTime: now,
    };
    this.#captures.set(c.id, c);
    // Mock choice: captures are listed under the order. Whether Sandbox does this for authorization captures is U03.
    o.captureIds.push(c.id);
    return c;
  }

  #updateCaptureAfterRefunds(captureId: string): void {
    const c = this.#captures.get(captureId)!;
    const refunded = this.#refundedMinor(c);
    const status = refunded === 0 ? 'COMPLETED' : refunded >= c.amount.minor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    if (status !== c.status) {
      c.status = status;
      c.updateTime = this.#now();
    }
  }

  #refundedMinor(c: MockCapture): number {
    return c.refundIds
      .map((rid) => this.#refunds.get(rid)!)
      .filter((r) => r.status === 'COMPLETED')
      .reduce((sum, r) => sum + r.amount.minor, 0);
  }

  // ---- rendering -----------------------------------------------------------------

  #renderOrder(o: MockOrder, full: boolean): Record<string, unknown> {
    const links: Array<Record<string, string>> = [{ href: `${MOCK_API_BASE}/v2/checkout/orders/${o.id}`, rel: 'self', method: 'GET' }];
    if (o.status === 'CREATED' || o.status === 'PAYER_ACTION_REQUIRED') {
      links.push({ href: `${MOCK_API_BASE}/checkoutnow?token=${o.id}`, rel: o.payerActionLink ? 'payer-action' : 'approve', method: 'GET' });
    }
    if (!full) return { id: o.id, status: o.status, links };
    const payments: Record<string, unknown> = {};
    if (o.authorizationIds.length) payments.authorizations = o.authorizationIds.map((id) => this.#renderAuth(this.#auths.get(id)!));
    if (o.captureIds.length) payments.captures = o.captureIds.map((id) => this.#renderCapture(this.#captures.get(id)!));
    return {
      id: o.id,
      status: o.status,
      intent: o.intent,
      purchase_units: [
        {
          reference_id: 'default',
          amount: amountJson(o.amount),
          payee: { merchant_id: MOCK_MERCHANT_ID },
          ...(o.customId !== undefined ? { custom_id: o.customId } : {}),
          ...(o.invoiceId !== undefined ? { invoice_id: o.invoiceId } : {}),
          ...(Object.keys(payments).length ? { payments } : {}),
        },
      ],
      create_time: o.createTime,
      update_time: o.updateTime,
      links,
    };
  }

  #renderAuth(a: MockAuthorization): Record<string, unknown> {
    return {
      id: a.id,
      status: a.status,
      amount: amountJson(a.amount),
      ...(a.customId !== undefined ? { custom_id: a.customId } : {}),
      ...(a.invoiceId !== undefined ? { invoice_id: a.invoiceId } : {}),
      expiration_time: a.expirationTime,
      payee: { merchant_id: MOCK_MERCHANT_ID },
      create_time: a.createTime,
      update_time: a.updateTime,
      links: [
        { href: `${MOCK_API_BASE}/v2/payments/authorizations/${a.id}`, rel: 'self', method: 'GET' },
        { href: `${MOCK_API_BASE}/v2/checkout/orders/${a.orderId}`, rel: 'up', method: 'GET' },
      ],
    };
  }

  #renderCapture(c: MockCapture): Record<string, unknown> {
    const links = [{ href: `${MOCK_API_BASE}/v2/payments/captures/${c.id}`, rel: 'self', method: 'GET' }];
    if (c.authorizationId) links.push({ href: `${MOCK_API_BASE}/v2/payments/authorizations/${c.authorizationId}`, rel: 'up', method: 'GET' });
    return {
      id: c.id,
      status: c.status,
      amount: amountJson(c.amount),
      final_capture: true,
      ...(c.customId !== undefined ? { custom_id: c.customId } : {}),
      ...(c.invoiceId !== undefined ? { invoice_id: c.invoiceId } : {}),
      payee: { merchant_id: MOCK_MERCHANT_ID },
      create_time: c.createTime,
      update_time: c.updateTime,
      links,
    };
  }

  #renderRefund(r: MockRefund): Record<string, unknown> {
    const c = this.#captures.get(r.captureId)!;
    return {
      id: r.id,
      status: r.status,
      amount: amountJson(r.amount),
      ...(r.invoiceId !== undefined ? { invoice_id: r.invoiceId } : {}),
      seller_payable_breakdown: { total_refunded_amount: amountJson({ currency: c.amount.currency, minor: this.#refundedMinor(c) }) },
      create_time: r.createTime,
      update_time: r.updateTime,
      links: [
        { href: `${MOCK_API_BASE}/v2/payments/refunds/${r.id}`, rel: 'self', method: 'GET' },
        { href: `${MOCK_API_BASE}/v2/payments/captures/${r.captureId}`, rel: 'up', method: 'GET' },
      ],
    };
  }

  #nextId(kind: 'ORDER' | 'AUTH' | 'CAPTURE' | 'REFUND'): string {
    this.#seq += 1;
    return `${this.#idPrefix}${kind}-${String(this.#seq).padStart(6, '0')}`;
  }

  #now(): string {
    return new Date(this.#clock.now()).toISOString();
  }
}

/** The REST adapter wired to a mock server: the MOCK implementation of the port. */
export function createMockPayPal(server: MockPayPalServer, opts: { clock?: Clock; logger?: PayPalLogger; timeoutMs?: number } = {}): PayPalRestAdapter {
  return new PayPalRestAdapter({
    mode: 'MOCK',
    apiBase: MOCK_API_BASE,
    clientId: MOCK_CLIENT_ID,
    clientSecret: MOCK_CLIENT_SECRET,
    fetch: server.fetch,
    ...opts,
  });
}

// ---- helpers ---------------------------------------------------------------------

const JSON_HEADERS = { 'content-type': 'application/json' };

function matchRoute(method: string, path: string): { route: MockRoute; id: string | undefined } | null {
  for (const [m, pattern, route] of ROUTES) {
    if (m !== method) continue;
    const hit = pattern.exec(path);
    if (hit) return { route, id: hit[1] === undefined ? undefined : decodeURIComponent(hit[1]) };
  }
  return null;
}

function parseBody(text: string): Record<string, unknown> | null {
  if (text === '') return null;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseAmount(value: unknown): Money | null {
  if (value === null || typeof value !== 'object') return null;
  const { currency_code: currency, value: v } = value as Record<string, unknown>;
  if (typeof currency !== 'string' || typeof v !== 'string') return null;
  try {
    const minor = fromPayPalValue(v, currency);
    return minor === null ? null : { currency, minor };
  } catch {
    return null;
  }
}

function amountJson(m: Money): { currency_code: string; value: string } {
  return { currency_code: m.currency, value: toPayPalValue(m) };
}

function minimal(id: string, status: string): Record<string, unknown> {
  return { id, status };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, 'paypal-debug-id': `mock-${randomUUID().slice(0, 8)}` } });
}

function errorResponse(status: number, name: string, issue: string): Response {
  return jsonResponse(status, { name, message: `mock: ${issue}`, debug_id: `mock-${randomUUID().slice(0, 8)}`, details: [{ issue, description: `mock: ${issue}` }] });
}

const notFound = () => errorResponse(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
const unprocessable = (issue: string) => errorResponse(422, 'UNPROCESSABLE_ENTITY', issue);
const invalid = (issue: string) => errorResponse(400, 'INVALID_REQUEST', issue);

function httpError(status: number): Response {
  const name = status === 429 ? 'RATE_LIMIT_REACHED' : status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'MOCK_HTTP_ERROR';
  return errorResponse(status, name, name);
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason as Error);
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}
