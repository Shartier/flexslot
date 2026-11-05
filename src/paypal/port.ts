// The PayPal port. Implemented by the REST adapter (rest.ts) against the Sandbox, or against the in-process
// mock server (mock-server.ts). One call = one HTTP send; resend scheduling belongs to the executor (DESIGN 7).

import type { UnknownReason } from './classify.ts';
import type { CaptureAuthorizationInput, CreateOrderInput, RefundCaptureInput } from './requests.ts';
import type { Authorization, Capture, Order, Refund } from './schemas.ts';

export type PaymentMode = 'SANDBOX' | 'MOCK';

export interface SendContext {
  /** PayPal-Request-Id: one per operation row, the same on every resend of that operation. */
  requestId: string;
  /** Hash stored when the operation row was created. A different body is refused before sending. */
  expectedRequestHash?: string;
  /** True when an earlier send of this same operation ended UNKNOWN (DESIGN 7.1, 4xx after unknown). */
  priorUnknownSend?: boolean;
}

export interface PayPalErrorInfo {
  name?: string;
  issues: string[];
  debugId?: string;
}

/** DESIGN 7.1 table, plus NOT_SENT for "the token could not be obtained, nothing was sent". */
export type OperationOutcome<R> =
  | { kind: 'SUCCEEDED'; resource: R; externalStatus: string; httpStatus: number }
  | { kind: 'PENDING'; resource: R; externalStatus: string; httpStatus: number }
  | { kind: 'FAILED'; resource: R; externalStatus: string; httpStatus: number }
  | { kind: 'NOT_ACCEPTED'; httpStatus: number; error: PayPalErrorInfo }
  | { kind: 'AUTH_ERROR'; httpStatus: number; error?: PayPalErrorInfo }
  /** `resource` is set when a 2xx body parsed but its status was unexpected (e.g. an Orders API replay, STATUS). */
  | { kind: 'UNKNOWN'; reason: UnknownReason; httpStatus?: number; error?: PayPalErrorInfo; externalStatus?: string; resource?: R }
  | { kind: 'NOT_SENT'; reason: TokenFailureReason };

export type SendResult<R> = OperationOutcome<R> & {
  requestId: string;
  requestHash: string;
  /** How the result was confirmed: the POST response itself, or a follow-up GET (void answered 204). */
  confirmedBy?: 'RESPONSE' | 'QUERY';
};

export type QueryFailureReason = 'NETWORK' | 'TIMEOUT' | 'HTTP_5XX' | 'HTTP_429' | 'HTTP_4XX_OTHER' | 'INVALID_RESPONSE';

export type QueryResult<R> =
  | { kind: 'FOUND'; resource: R; httpStatus: number }
  | { kind: 'NOT_FOUND'; httpStatus: number }
  | { kind: 'AUTH_ERROR'; httpStatus: number }
  | { kind: 'UNAVAILABLE'; reason: QueryFailureReason; httpStatus?: number }
  | { kind: 'NOT_SENT'; reason: TokenFailureReason };

export type TokenFailureReason = 'AUTH' | 'NETWORK' | 'TIMEOUT' | 'HTTP_5XX' | 'HTTP_429' | 'HTTP_OTHER' | 'INVALID_RESPONSE';

export type CredentialCheck =
  | { ok: true; expiresInSec: number }
  | { ok: false; reason: TokenFailureReason; httpStatus?: number };

export interface AuthorizeResult {
  order: Order;
  authorization: Authorization;
}

export interface OrderCaptureResult {
  order: Order;
  capture: Capture;
}

/** DESIGN 7.4: the inputs of POST /v1/notifications/verify-webhook-signature (headers of the delivery + event). */
export interface WebhookVerifyInput {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  event: unknown;
}

/** SUCCESS / FAILURE are PayPal's verdict; REJECTED = 4xx (the input itself was refused); the rest = try again later. */
export type WebhookVerifyResult =
  | { kind: 'SUCCESS' }
  | { kind: 'FAILURE' }
  | { kind: 'REJECTED'; httpStatus: number }
  | { kind: 'AUTH_ERROR'; httpStatus: number }
  | { kind: 'UNAVAILABLE'; reason: QueryFailureReason; httpStatus?: number }
  | { kind: 'NOT_SENT'; reason: TokenFailureReason };

export interface PayPalPort {
  readonly mode: PaymentMode;
  /** Fetches a fresh OAuth token (V1). Reports only success and lifetime. */
  checkCredentials(): Promise<CredentialCheck>;
  createOrder(input: CreateOrderInput, ctx: SendContext): Promise<SendResult<Order>>;
  authorizeOrder(orderId: string, ctx: SendContext): Promise<SendResult<AuthorizeResult>>;
  /** A's original payment (intent=CAPTURE). */
  captureOrder(orderId: string, ctx: SendContext): Promise<SendResult<OrderCaptureResult>>;
  getOrder(orderId: string): Promise<QueryResult<Order>>;
  captureAuthorization(authorizationId: string, input: CaptureAuthorizationInput, ctx: SendContext): Promise<SendResult<Capture>>;
  voidAuthorization(authorizationId: string, ctx: SendContext): Promise<SendResult<Authorization>>;
  getAuthorization(authorizationId: string): Promise<QueryResult<Authorization>>;
  refundCapture(captureId: string, input: RefundCaptureInput, ctx: SendContext): Promise<SendResult<Refund>>;
  getCapture(captureId: string): Promise<QueryResult<Capture>>;
  getRefund(refundId: string): Promise<QueryResult<Refund>>;
  /** DESIGN 7.4: PayPal's signature verification of a received webhook. Changes nothing at PayPal. */
  verifyWebhookSignature(input: WebhookVerifyInput): Promise<WebhookVerifyResult>;
}

/** Log entry written by the adapter. Never contains ids, headers, tokens, credentials or bodies. */
export interface PayPalLogEntry {
  event: 'paypal.token' | 'paypal.send' | 'paypal.query' | 'paypal.verify';
  mode: PaymentMode;
  route: string;
  httpStatus?: number;
  outcome: string;
  durationMs: number;
}

export type PayPalLogger = (entry: PayPalLogEntry) => void;
