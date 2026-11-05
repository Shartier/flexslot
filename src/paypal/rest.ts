// REST adapter for the PayPal port (DESIGN 7). Sandbox only: the constructor refuses any other API base.
// Every POST carries its own PayPal-Request-Id and Prefer: return=representation; every call times out at 20 s.
// Credentials and the access token live in private fields and are never logged or put in error messages.

import { systemClock, type Clock } from '../clock.ts';
import { classifyHttpError, classifyResourceStatus, type Classification } from './classify.ts';
import {
  buildAuthorizeOrder,
  buildCaptureAuthorization,
  buildCaptureOrder,
  buildCreateOrder,
  buildRefundCapture,
  buildVoidAuthorization,
  assertExternalId,
  type BuiltRequest,
  type CaptureAuthorizationInput,
  type CreateOrderInput,
  type RefundCaptureInput,
} from './requests.ts';
import type {
  AuthorizeResult,
  CredentialCheck,
  OperationOutcome,
  OrderCaptureResult,
  PayPalErrorInfo,
  PayPalLogger,
  PayPalPort,
  PaymentMode,
  QueryResult,
  SendContext,
  SendResult,
  TokenFailureReason,
  WebhookVerifyInput,
  WebhookVerifyResult,
} from './port.ts';
import {
  AuthorizationSchema,
  CaptureSchema,
  ErrorBodySchema,
  OrderSchema,
  RefundSchema,
  TokenResponseSchema,
  type Authorization,
  type Capture,
  type Order,
  type Refund,
} from './schemas.ts';
import type { z } from 'zod';

export const SANDBOX_API_BASE = 'https://api-m.sandbox.paypal.com';
/** Never resolvable (.invalid); only the in-process mock server answers it. */
export const MOCK_API_BASE = 'https://mock-paypal.invalid';
export const DEFAULT_TIMEOUT_MS = 20_000;
/** Refresh the cached token this long before PayPal's stated expiry. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** PayPal accepts up to 108 characters; FlexSlot uses UUIDs. */
const REQUEST_ID = /^[A-Za-z0-9-]{8,108}$/;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class NonSandboxEndpointError extends Error {
  constructor() {
    super(`PayPal API base must be ${SANDBOX_API_BASE}; refusing to start (Sandbox only)`);
    this.name = 'NonSandboxEndpointError';
  }
}

export class RequestHashMismatchError extends Error {
  constructor() {
    super('request body differs from the hash stored for this operation; not sent');
    this.name = 'RequestHashMismatchError';
  }
}

/** A mock id sent to the Sandbox, or a Sandbox id sent to the mock (DESIGN 10, AC12). */
export class ModeMismatchError extends Error {
  constructor(mode: PaymentMode) {
    super(`external id does not belong to payment mode ${mode}; not sent`);
    this.name = 'ModeMismatchError';
  }
}

export class InvalidRequestIdError extends Error {
  constructor() {
    super('PayPal-Request-Id must be 8-108 characters of [A-Za-z0-9-]');
    this.name = 'InvalidRequestIdError';
  }
}

export function normalizeApiBase(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function assertApiBase(mode: PaymentMode, apiBase: string): void {
  const base = normalizeApiBase(apiBase);
  if (mode === 'SANDBOX' && base !== SANDBOX_API_BASE) throw new NonSandboxEndpointError();
  if (mode === 'MOCK' && base !== MOCK_API_BASE) throw new Error(`mock adapter must use ${MOCK_API_BASE}`);
}

export interface RestAdapterOptions {
  mode: PaymentMode;
  apiBase: string;
  clientId: string;
  clientSecret: string;
  fetch: FetchLike;
  clock?: Clock;
  timeoutMs?: number;
  logger?: PayPalLogger;
}

type Exchange =
  | { type: 'response'; status: number; json: unknown }
  | { type: 'network' }
  | { type: 'timeout' }
  | { type: 'no_token'; reason: TokenFailureReason };

type TokenFetch = { ok: true; token: string; expiresInSec: number } | { ok: false; reason: TokenFailureReason; httpStatus?: number };

type Reader<R> = (json: unknown) => { resource: R; status: string } | null;

export class PayPalRestAdapter implements PayPalPort {
  readonly mode: PaymentMode;
  readonly #base: string;
  readonly #basicAuth: string;
  readonly #fetch: FetchLike;
  readonly #clock: Clock;
  readonly #timeoutMs: number;
  readonly #log: PayPalLogger;
  #token: { value: string; expiresAtMs: number } | undefined;
  #tokenInFlight: Promise<TokenFetch> | undefined;

  constructor(opts: RestAdapterOptions) {
    assertApiBase(opts.mode, opts.apiBase);
    if (!opts.clientId || !opts.clientSecret) throw new Error('PayPal client id and secret are required');
    this.mode = opts.mode;
    this.#base = normalizeApiBase(opts.apiBase);
    this.#basicAuth = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')}`;
    this.#fetch = opts.fetch;
    this.#clock = opts.clock ?? systemClock;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#log = opts.logger ?? (() => {});
  }

  // ---- port: token ---------------------------------------------------------

  async checkCredentials(): Promise<CredentialCheck> {
    const t = await this.#fetchToken();
    return t.ok ? { ok: true, expiresInSec: t.expiresInSec } : { ok: false, reason: t.reason, ...(t.httpStatus ? { httpStatus: t.httpStatus } : {}) };
  }

  // ---- port: POST operations -----------------------------------------------

  async createOrder(input: CreateOrderInput, ctx: SendContext): Promise<SendResult<Order>> {
    return this.#send(buildCreateOrder(input), ctx, null, readWith(OrderSchema, (o) => o));
  }

  async authorizeOrder(orderId: string, ctx: SendContext): Promise<SendResult<AuthorizeResult>> {
    return this.#send(buildAuthorizeOrder(orderId), ctx, orderId, (json) => {
      const order = OrderSchema.safeParse(json);
      if (!order.success) return null;
      const authorization = order.data.purchase_units?.[0]?.payments?.authorizations?.at(-1);
      return authorization ? { resource: { order: order.data, authorization }, status: authorization.status } : null;
    });
  }

  async captureOrder(orderId: string, ctx: SendContext): Promise<SendResult<OrderCaptureResult>> {
    return this.#send(buildCaptureOrder(orderId), ctx, orderId, (json) => {
      const order = OrderSchema.safeParse(json);
      if (!order.success) return null;
      const capture = order.data.purchase_units?.[0]?.payments?.captures?.at(-1);
      return capture ? { resource: { order: order.data, capture }, status: capture.status } : null;
    });
  }

  async captureAuthorization(authorizationId: string, input: CaptureAuthorizationInput, ctx: SendContext): Promise<SendResult<Capture>> {
    return this.#send(buildCaptureAuthorization(authorizationId, input), ctx, authorizationId, readWith(CaptureSchema, (c) => c));
  }

  /** Void may answer 204 without a body (DESIGN 7.3); the result is then confirmed with a GET. */
  async voidAuthorization(authorizationId: string, ctx: SendContext): Promise<SendResult<Authorization>> {
    return this.#send(buildVoidAuthorization(authorizationId), ctx, authorizationId, readWith(AuthorizationSchema, (a) => a), async () => {
      const q = await this.getAuthorization(authorizationId);
      return q.kind === 'FOUND' ? { resource: q.resource, status: q.resource.status } : null;
    });
  }

  async refundCapture(captureId: string, input: RefundCaptureInput, ctx: SendContext): Promise<SendResult<Refund>> {
    return this.#send(buildRefundCapture(captureId, input), ctx, captureId, readWith(RefundSchema, (r) => r));
  }

  // ---- port: queries -------------------------------------------------------

  async getOrder(orderId: string): Promise<QueryResult<Order>> {
    return this.#query(`/v2/checkout/orders/${this.#target(orderId)}`, '/v2/checkout/orders/{id}', OrderSchema);
  }

  async getAuthorization(authorizationId: string): Promise<QueryResult<Authorization>> {
    return this.#query(`/v2/payments/authorizations/${this.#target(authorizationId)}`, '/v2/payments/authorizations/{id}', AuthorizationSchema);
  }

  async getCapture(captureId: string): Promise<QueryResult<Capture>> {
    return this.#query(`/v2/payments/captures/${this.#target(captureId)}`, '/v2/payments/captures/{id}', CaptureSchema);
  }

  async getRefund(refundId: string): Promise<QueryResult<Refund>> {
    return this.#query(`/v2/payments/refunds/${this.#target(refundId)}`, '/v2/payments/refunds/{id}', RefundSchema);
  }

  // ---- port: webhook signature (DESIGN 7.4) ----------------------------------

  async verifyWebhookSignature(input: WebhookVerifyInput): Promise<WebhookVerifyResult> {
    const started = performance.now();
    const ex = await this.#exchange('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: input.authAlgo,
      cert_url: input.certUrl,
      transmission_id: input.transmissionId,
      transmission_sig: input.transmissionSig,
      transmission_time: input.transmissionTime,
      webhook_id: input.webhookId,
      webhook_event: input.event,
    }, {});
    let result: WebhookVerifyResult;
    if (ex.type === 'no_token') result = { kind: 'NOT_SENT', reason: ex.reason };
    else if (ex.type === 'network') result = { kind: 'UNAVAILABLE', reason: 'NETWORK' };
    else if (ex.type === 'timeout') result = { kind: 'UNAVAILABLE', reason: 'TIMEOUT' };
    else if (ex.status >= 200 && ex.status < 300) {
      const v = (ex.json as { verification_status?: unknown } | undefined)?.verification_status;
      // Anything but an explicit SUCCESS is not a verification (an unknown answer is never success, DESIGN 6.2).
      result = v === 'SUCCESS' ? { kind: 'SUCCESS' } : v === 'FAILURE' ? { kind: 'FAILURE' } : { kind: 'UNAVAILABLE', reason: 'INVALID_RESPONSE', httpStatus: ex.status };
    } else if (ex.status === 401 || ex.status === 403) result = { kind: 'AUTH_ERROR', httpStatus: ex.status };
    else if (ex.status === 429) result = { kind: 'UNAVAILABLE', reason: 'HTTP_429', httpStatus: 429 };
    else if (ex.status >= 500) result = { kind: 'UNAVAILABLE', reason: 'HTTP_5XX', httpStatus: ex.status };
    else result = { kind: 'REJECTED', httpStatus: ex.status };
    this.#log({
      event: 'paypal.verify',
      mode: this.mode,
      route: '/v1/notifications/verify-webhook-signature',
      ...(ex.type === 'response' ? { httpStatus: ex.status } : {}),
      outcome: result.kind,
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  }

  // ---- internals -----------------------------------------------------------

  /** Validates an id's format and that it belongs to this adapter's mode. */
  #target(id: string): string {
    assertExternalId(id);
    const isMock = id.startsWith('MOCK-');
    if ((this.mode === 'SANDBOX') === isMock) throw new ModeMismatchError(this.mode);
    return id;
  }

  async #send<R>(
    req: BuiltRequest,
    ctx: SendContext,
    targetId: string | null,
    read: Reader<R>,
    followUp?: () => Promise<{ resource: R; status: string } | null>,
  ): Promise<SendResult<R>> {
    if (!REQUEST_ID.test(ctx.requestId)) throw new InvalidRequestIdError();
    if (ctx.expectedRequestHash !== undefined && ctx.expectedRequestHash !== req.hash) throw new RequestHashMismatchError();
    if (targetId !== null) this.#target(targetId);

    const started = performance.now();
    const ex = await this.#exchange('POST', req.path, req.body, {
      'PayPal-Request-Id': ctx.requestId,
      Prefer: 'return=representation',
    });
    let outcome: OperationOutcome<R>;
    let confirmedBy: 'RESPONSE' | 'QUERY' = 'RESPONSE';
    if (ex.type === 'no_token') outcome = { kind: 'NOT_SENT', reason: ex.reason };
    else if (ex.type === 'network') outcome = { kind: 'UNKNOWN', reason: 'NETWORK' };
    else if (ex.type === 'timeout') outcome = { kind: 'UNKNOWN', reason: 'TIMEOUT' };
    else if (ex.status >= 200 && ex.status < 300) {
      let read2 = ex.json === undefined ? null : read(ex.json);
      if (read2 === null && ex.json === undefined && followUp) {
        read2 = await followUp();
        confirmedBy = 'QUERY';
      }
      outcome = read2 === null
        ? { kind: 'UNKNOWN', reason: 'INVALID_RESPONSE', httpStatus: ex.status }
        : fromStatus(classifyResourceStatus(req.op, read2.status), read2.resource, read2.status, ex.status);
    } else {
      const error = errorInfo(ex.json);
      outcome = fromHttpError(classifyHttpError(ex.status, error.issues, ctx.priorUnknownSend ?? false), ex.status, error);
    }
    this.#log({
      event: 'paypal.send',
      mode: this.mode,
      route: req.route,
      ...(ex.type === 'response' ? { httpStatus: ex.status } : {}),
      outcome: outcome.kind === 'UNKNOWN' ? `UNKNOWN:${outcome.reason}` : outcome.kind,
      durationMs: Math.round(performance.now() - started),
    });
    return { ...outcome, requestId: ctx.requestId, requestHash: req.hash, confirmedBy };
  }

  async #query<S extends z.ZodType>(path: string, route: string, schema: S): Promise<QueryResult<z.infer<S>>> {
    const started = performance.now();
    const ex = await this.#exchange('GET', path, null, {});
    let result: QueryResult<z.infer<S>>;
    if (ex.type === 'no_token') result = { kind: 'NOT_SENT', reason: ex.reason };
    else if (ex.type === 'network') result = { kind: 'UNAVAILABLE', reason: 'NETWORK' };
    else if (ex.type === 'timeout') result = { kind: 'UNAVAILABLE', reason: 'TIMEOUT' };
    else if (ex.status >= 200 && ex.status < 300) {
      const parsed = schema.safeParse(ex.json);
      result = parsed.success
        ? { kind: 'FOUND', resource: parsed.data, httpStatus: ex.status }
        : { kind: 'UNAVAILABLE', reason: 'INVALID_RESPONSE', httpStatus: ex.status };
    } else if (ex.status === 404) result = { kind: 'NOT_FOUND', httpStatus: 404 };
    else if (ex.status === 401 || ex.status === 403) result = { kind: 'AUTH_ERROR', httpStatus: ex.status };
    else if (ex.status === 429) result = { kind: 'UNAVAILABLE', reason: 'HTTP_429', httpStatus: 429 };
    else if (ex.status >= 500) result = { kind: 'UNAVAILABLE', reason: 'HTTP_5XX', httpStatus: ex.status };
    else result = { kind: 'UNAVAILABLE', reason: 'HTTP_4XX_OTHER', httpStatus: ex.status };
    this.#log({
      event: 'paypal.query',
      mode: this.mode,
      route,
      ...(ex.type === 'response' ? { httpStatus: ex.status } : {}),
      outcome: result.kind === 'UNAVAILABLE' ? `UNAVAILABLE:${result.reason}` : result.kind,
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  }

  /** One HTTP exchange with a bearer token. A 401 drops the cached token and is retried once (same request id). */
  async #exchange(method: 'GET' | 'POST', path: string, body: unknown, headers: Record<string, string>): Promise<Exchange> {
    const url = this.#url(path);
    for (let attempt = 0; ; attempt++) {
      const token = await this.#bearer();
      if (!token.ok) return { type: 'no_token', reason: token.reason };
      const signal = AbortSignal.timeout(this.#timeoutMs);
      try {
        const res = await this.#fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token.token}`,
            Accept: 'application/json',
            ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          ...(body === null ? {} : { body: JSON.stringify(body) }),
          signal,
        });
        const text = await res.text();
        if (res.status === 401 && attempt === 0) {
          this.#token = undefined;
          continue;
        }
        return { type: 'response', status: res.status, json: parseJson(text) };
      } catch {
        return { type: signal.aborted ? 'timeout' : 'network' };
      }
    }
  }

  async #bearer(): Promise<TokenFetch> {
    const cached = this.#token;
    if (cached && this.#clock.now() < cached.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) {
      return { ok: true, token: cached.value, expiresInSec: Math.floor((cached.expiresAtMs - this.#clock.now()) / 1000) };
    }
    this.#tokenInFlight ??= this.#fetchToken().finally(() => {
      this.#tokenInFlight = undefined;
    });
    return this.#tokenInFlight;
  }

  async #fetchToken(): Promise<TokenFetch> {
    const started = performance.now();
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let result: TokenFetch;
    let httpStatus: number | undefined;
    try {
      const res = await this.#fetch(this.#url('/v1/oauth2/token'), {
        method: 'POST',
        headers: {
          Authorization: this.#basicAuth,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal,
      });
      httpStatus = res.status;
      const text = await res.text();
      if (res.ok) {
        const parsed = TokenResponseSchema.safeParse(parseJson(text));
        if (parsed.success) {
          this.#token = { value: parsed.data.access_token, expiresAtMs: this.#clock.now() + parsed.data.expires_in * 1000 };
          result = { ok: true, token: parsed.data.access_token, expiresInSec: parsed.data.expires_in };
        } else result = { ok: false, reason: 'INVALID_RESPONSE', httpStatus };
      } else {
        const reason: TokenFailureReason =
          res.status === 401 || res.status === 403 ? 'AUTH' : res.status === 429 ? 'HTTP_429' : res.status >= 500 ? 'HTTP_5XX' : 'HTTP_OTHER';
        result = { ok: false, reason, httpStatus };
      }
    } catch {
      result = { ok: false, reason: signal.aborted ? 'TIMEOUT' : 'NETWORK' };
    }
    this.#log({
      event: 'paypal.token',
      mode: this.mode,
      route: '/v1/oauth2/token',
      ...(httpStatus ? { httpStatus } : {}),
      outcome: result.ok ? 'OK' : `FAILED:${result.reason}`,
      durationMs: Math.round(performance.now() - started),
    });
    return result;
  }

  #url(path: string): string {
    const url = new URL(path, this.#base);
    if (url.origin !== new URL(this.#base).origin) throw new NonSandboxEndpointError();
    return url.toString();
  }
}

function readWith<S extends z.ZodType, R>(schema: S, pick: (v: z.infer<S>) => R & { status: string }): Reader<R> {
  return (json) => {
    const parsed = schema.safeParse(json);
    if (!parsed.success) return null;
    const resource = pick(parsed.data);
    return { resource, status: resource.status };
  };
}

function parseJson(text: string): unknown {
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorInfo(json: unknown): PayPalErrorInfo {
  const parsed = ErrorBodySchema.safeParse(json);
  if (!parsed.success) return { issues: [] };
  const issues = (parsed.data.details ?? []).map((d) => d.issue).filter((i): i is string => !!i);
  if (parsed.data.name) issues.push(parsed.data.name);
  return {
    ...(parsed.data.name ? { name: parsed.data.name } : {}),
    issues,
    ...(parsed.data.debug_id ? { debugId: parsed.data.debug_id } : {}),
  };
}

function fromStatus<R>(c: Classification, resource: R, externalStatus: string, httpStatus: number): OperationOutcome<R> {
  switch (c.kind) {
    case 'SUCCEEDED':
    case 'PENDING':
    case 'FAILED':
      return { kind: c.kind, resource, externalStatus, httpStatus };
    case 'UNKNOWN':
      return { kind: 'UNKNOWN', reason: c.reason, httpStatus, externalStatus, resource };
    default:
      throw new Error(`unexpected classification for a 2xx response: ${c.kind}`);
  }
}

function fromHttpError<R>(c: Classification, httpStatus: number, error: PayPalErrorInfo): OperationOutcome<R> {
  switch (c.kind) {
    case 'NOT_ACCEPTED':
      return { kind: 'NOT_ACCEPTED', httpStatus, error };
    case 'AUTH_ERROR':
      return { kind: 'AUTH_ERROR', httpStatus, error };
    case 'UNKNOWN':
      return { kind: 'UNKNOWN', reason: c.reason, httpStatus, error };
    default:
      throw new Error(`unexpected classification for an HTTP error: ${c.kind}`);
  }
}

/** Buyer approval link of a created order, accepted only on the expected PayPal host for the mode. */
export function approvalUrl(order: Order, mode: PaymentMode): string | null {
  const link = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return null;
  }
  const expectedHost = mode === 'SANDBOX' ? 'www.sandbox.paypal.com' : new URL(MOCK_API_BASE).host;
  return url.protocol === 'https:' && url.host === expectedHost ? url.toString() : null;
}
