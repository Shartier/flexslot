// Request builders shared by the adapter and (later) the executor. The executor stores the hash when it
// creates an operation row; the adapter recomputes it before every send and refuses a mismatch (DESIGN 7.5).

import { createHash } from 'node:crypto';
import { toPayPalAmount, type Money } from './money.ts';

/** PayPal POST kinds. ORDER_CAPTURE is A's original payment (intent=CAPTURE), which is not a money obligation. */
export type OperationKind =
  | 'ORDER_CREATE'
  | 'ORDER_AUTHORIZE'
  | 'ORDER_CAPTURE'
  | 'AUTH_CAPTURE'
  | 'AUTH_VOID'
  | 'CAPTURE_REFUND';

export interface BuiltRequest {
  op: OperationKind;
  method: 'POST';
  /** Concrete path with the target id. */
  path: string;
  /** Path template without ids, the only form written to logs. */
  route: string;
  body: Record<string, unknown> | null;
  /** SHA-256 of the canonical JSON of {method, path, body}. */
  hash: string;
}

export interface CreateOrderInput {
  intent: 'CAPTURE' | 'AUTHORIZE';
  amount: Money;
  customId: string;
  invoiceId?: string;
  description?: string;
  returnUrl: string;
  cancelUrl: string;
  brandName?: string;
}

export interface CaptureAuthorizationInput {
  amount: Money;
  invoiceId?: string;
}

export interface RefundCaptureInput {
  /** Always explicit: an omitted amount would refund the whole capture. */
  amount: Money;
  invoiceId?: string;
  noteToPayer?: string;
}

/** PayPal ids are short alphanumeric strings; mock ids are "MOCK-..." (see mock-server.ts). */
const EXTERNAL_ID = /^[A-Za-z0-9-]{1,64}$/;

export function assertExternalId(id: string): string {
  if (!EXTERNAL_ID.test(id)) throw new InvalidExternalIdError();
  return id;
}

export class InvalidExternalIdError extends Error {
  constructor() {
    super('external id has an unexpected format; refusing to build the request');
    this.name = 'InvalidExternalIdError';
  }
}

/** JSON with object keys sorted at every level, so equal bodies hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function built(op: OperationKind, path: string, route: string, body: Record<string, unknown> | null): BuiltRequest {
  const hash = createHash('sha256').update(canonicalJson({ method: 'POST', path, body })).digest('hex');
  return { op, method: 'POST', path, route, body, hash };
}

const dropUndefined = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function buildCreateOrder(input: CreateOrderInput): BuiltRequest {
  const purchaseUnit = dropUndefined({
    custom_id: input.customId,
    invoice_id: input.invoiceId,
    description: input.description,
    amount: toPayPalAmount(input.amount),
  });
  const body = {
    intent: input.intent,
    purchase_units: [purchaseUnit],
    payment_source: {
      paypal: {
        experience_context: dropUndefined({
          brand_name: input.brandName,
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        }),
      },
    },
  };
  return built('ORDER_CREATE', '/v2/checkout/orders', '/v2/checkout/orders', body);
}

export function buildAuthorizeOrder(orderId: string): BuiltRequest {
  const id = assertExternalId(orderId);
  return built('ORDER_AUTHORIZE', `/v2/checkout/orders/${id}/authorize`, '/v2/checkout/orders/{id}/authorize', null);
}

export function buildCaptureOrder(orderId: string): BuiltRequest {
  const id = assertExternalId(orderId);
  return built('ORDER_CAPTURE', `/v2/checkout/orders/${id}/capture`, '/v2/checkout/orders/{id}/capture', null);
}

export function buildCaptureAuthorization(authorizationId: string, input: CaptureAuthorizationInput): BuiltRequest {
  const id = assertExternalId(authorizationId);
  const body = dropUndefined({
    amount: toPayPalAmount(input.amount),
    invoice_id: input.invoiceId,
    final_capture: true,
  });
  return built('AUTH_CAPTURE', `/v2/payments/authorizations/${id}/capture`, '/v2/payments/authorizations/{id}/capture', body);
}

export function buildVoidAuthorization(authorizationId: string): BuiltRequest {
  const id = assertExternalId(authorizationId);
  return built('AUTH_VOID', `/v2/payments/authorizations/${id}/void`, '/v2/payments/authorizations/{id}/void', null);
}

export function buildRefundCapture(captureId: string, input: RefundCaptureInput): BuiltRequest {
  const id = assertExternalId(captureId);
  const body = dropUndefined({
    amount: toPayPalAmount(input.amount),
    invoice_id: input.invoiceId,
    note_to_payer: input.noteToPayer,
  });
  return built('CAPTURE_REFUND', `/v2/payments/captures/${id}/refund`, '/v2/payments/captures/{id}/refund', body);
}
