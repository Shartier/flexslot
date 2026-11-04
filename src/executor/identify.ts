// Identifying the resource a PayPal answer is about, and judging what it means (DESIGN 7.3, D19, D20).
// Pure functions. Identification ("is this our resource?") is kept apart from the next-step decision
// ("may we go on?"): a replay may return either the original answer or the current state, and both must work.

import { amountEquals, fromPayPalValue, type Money } from '../paypal/money.ts';
import type { Authorization, Capture, Order, Refund } from '../paypal/schemas.ts';

/** A resource as returned by a POST or a GET, tagged by type. */
export type Resource =
  | { type: 'order'; order: Order }
  | { type: 'authorization'; authorization: Authorization }
  | { type: 'capture'; capture: Capture }
  | { type: 'refund'; refund: Refund };

export interface Identified {
  id: string;
  status: string;
  updateTime?: string;
  /** Refunds: the refund amount; captures: the capture amount. */
  amountMinor?: number;
  /** Refunds: seller_payable_breakdown.total_refunded_amount, when PayPal sent it. */
  totalRefundedMinor?: number;
}

export type Identification = { ok: true; found: Identified } | { ok: false; reason: string };

export type Effect = 'SUCCEEDED' | 'PENDING' | 'FAILED' | 'UNKNOWN';

/**
 * D19: what an identified resource's current status says about the POST that created or changed it.
 * "SUCCEEDED" means the POST took effect; whether FlexSlot may go on is decided later from the current state
 * (e.g. a REFUNDED capture shows the capture happened, but it is not a valid payment for B).
 */
const EFFECT: Readonly<Record<string, { done: readonly string[]; pending: readonly string[]; failed: readonly string[] }>> = {
  ORDER_CREATE: { done: ['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED', 'COMPLETED'], pending: [], failed: ['VOIDED'] },
  ORDER_AUTHORIZE: { done: ['CREATED', 'CAPTURED', 'PARTIALLY_CAPTURED', 'VOIDED', 'EXPIRED'], pending: ['PENDING'], failed: ['DENIED'] },
  AUTH_CAPTURE: { done: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'], pending: ['PENDING'], failed: ['DECLINED', 'FAILED'] },
  ORDER_CAPTURE: { done: ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'], pending: ['PENDING'], failed: ['DECLINED', 'FAILED'] },
  AUTH_VOID: { done: ['VOIDED'], pending: [], failed: ['CAPTURED', 'PARTIALLY_CAPTURED'] },
  CAPTURE_REFUND: { done: ['COMPLETED'], pending: ['PENDING'], failed: ['FAILED', 'CANCELLED'] },
};

export function effectOf(opKind: string, status: string): Effect {
  const e = EFFECT[opKind];
  if (!e) return 'UNKNOWN';
  if (e.done.includes(status)) return 'SUCCEEDED';
  if (e.pending.includes(status)) return 'PENDING';
  if (e.failed.includes(status)) return 'FAILED';
  return 'UNKNOWN';
}

/** Id named by the HATEOAS link `rel` (e.g. "up") when its path is .../{segment}/{id}. */
export function linkedId(links: Array<{ href: string; rel: string }> | undefined, rel: string, segment: string): string | undefined {
  const link = links?.find((l) => l.rel === rel);
  if (!link) return undefined;
  try {
    const parts = new URL(link.href).pathname.split('/').filter(Boolean);
    const i = parts.lastIndexOf(segment);
    return i >= 0 && i + 1 < parts.length ? decodeURIComponent(parts[i + 1]!) : undefined;
  } catch {
    return undefined;
  }
}

const minorOf = (a: { currency_code: string; value: string } | undefined): number | undefined => {
  if (!a) return undefined;
  try {
    return fromPayPalValue(a.value, a.currency_code) ?? undefined;
  } catch {
    return undefined;
  }
};

const found = (id: string, status: string, r: { update_time?: string | undefined }, extra: Partial<Identified> = {}): Identification => ({
  ok: true,
  found: { id, status, ...(r.update_time ? { updateTime: r.update_time } : {}), ...extra },
});

const unit = (order: Order) => (order.purchase_units?.length === 1 ? order.purchase_units[0] : undefined);

/** ORDER_CREATE: the order carries our custom_id and amount (one purchase unit). */
export function identifyCreatedOrder(order: Order, exp: { amount: Money; customId: string; orderId?: string | null }): Identification {
  if (exp.orderId && order.id !== exp.orderId) return { ok: false, reason: 'order_id' };
  const pu = unit(order);
  if (!pu) return { ok: false, reason: 'purchase_units' };
  if (pu.custom_id !== exp.customId) return { ok: false, reason: 'custom_id' };
  if (!amountEquals(pu.amount, exp.amount)) return { ok: false, reason: 'amount' };
  return found(order.id, order.status, order);
}

/**
 * ORDER_AUTHORIZE: exactly one authorization in the order that matches our amount and custom_id (and id,
 * once known). Never "the last element" (D19).
 */
export function identifyAuthorization(
  order: Order,
  exp: { orderId: string; amount: Money; customId: string; authorizationId?: string | null },
): Identification {
  if (order.id !== exp.orderId) return { ok: false, reason: 'order_id' };
  const pu = unit(order);
  if (!pu) return { ok: false, reason: 'purchase_units' };
  const auths = pu.payments?.authorizations ?? [];
  const hits = auths.filter(
    (a) =>
      (!exp.authorizationId || a.id === exp.authorizationId) &&
      amountEquals(a.amount, exp.amount) &&
      (a.custom_id ?? pu.custom_id) === exp.customId,
  );
  if (hits.length !== 1) return { ok: false, reason: auths.length === 0 ? 'no_authorization' : `authorizations_matching:${hits.length}` };
  const a = hits[0]!;
  return found(a.id, a.status, a);
}

/** A capture inside an order (GET order payments.captures[], STATUS F2), matched by parent, amount and custom_id. */
export function identifyCaptureInOrder(
  order: Order,
  exp: { orderId: string; amount: Money; customId: string; authorizationId?: string; captureId?: string | null },
): Identification {
  if (order.id !== exp.orderId) return { ok: false, reason: 'order_id' };
  const pu = unit(order);
  if (!pu) return { ok: false, reason: 'purchase_units' };
  const captures = pu.payments?.captures ?? [];
  const hits = captures.filter((c) => {
    if (exp.captureId && c.id !== exp.captureId) return false;
    if (!amountEquals(c.amount, exp.amount)) return false;
    if ((c.custom_id ?? pu.custom_id) !== exp.customId) return false;
    if (exp.authorizationId) {
      const up = linkedId(c.links, 'up', 'authorizations');
      if (up !== undefined && up !== exp.authorizationId) return false;
    }
    return true;
  });
  if (hits.length !== 1) return { ok: false, reason: captures.length === 0 ? 'no_capture' : `captures_matching:${hits.length}` };
  const c = hits[0]!;
  return found(c.id, c.status, c, { amountMinor: exp.amount.minor });
}

/** AUTH_CAPTURE / ORDER_CAPTURE from a capture object (POST answer or GET capture). */
export function identifyCapture(
  capture: Capture,
  exp: { amount: Money; customId: string; authorizationId?: string; captureId?: string | null },
): Identification {
  if (exp.captureId && capture.id !== exp.captureId) return { ok: false, reason: 'capture_id' };
  if (!amountEquals(capture.amount, exp.amount)) return { ok: false, reason: 'amount' };
  if (capture.custom_id !== undefined && capture.custom_id !== exp.customId) return { ok: false, reason: 'custom_id' };
  if (exp.authorizationId) {
    const up = linkedId(capture.links, 'up', 'authorizations');
    if (up !== undefined && up !== exp.authorizationId) return { ok: false, reason: 'parent_authorization' };
  }
  return found(capture.id, capture.status, capture, { amountMinor: exp.amount.minor });
}

/** AUTH_VOID: the authorization itself. */
export function identifyAuthorizationObject(authorization: Authorization, exp: { authorizationId: string }): Identification {
  if (authorization.id !== exp.authorizationId) return { ok: false, reason: 'authorization_id' };
  return found(authorization.id, authorization.status, authorization);
}

/** CAPTURE_REFUND: the refund of our capture with our amount. */
export function identifyRefund(refund: Refund, exp: { amount: Money; captureId: string; refundId?: string | null }): Identification {
  if (exp.refundId && refund.id !== exp.refundId) return { ok: false, reason: 'refund_id' };
  if (!amountEquals(refund.amount, exp.amount)) return { ok: false, reason: 'amount' };
  const up = linkedId(refund.links, 'up', 'captures');
  if (up !== undefined && up !== exp.captureId) return { ok: false, reason: 'parent_capture' };
  const total = minorOf(refund.seller_payable_breakdown?.total_refunded_amount);
  return found(refund.id, refund.status, refund, { amountMinor: exp.amount.minor, ...(total !== undefined ? { totalRefundedMinor: total } : {}) });
}

// ---- reconciliation (D20): every field is required; a missing field is a mismatch -------------------------

export type Reconciliation =
  | { kind: 'MATCHED'; status: string; updateTime?: string }
  /** Not yet decidable (e.g. still PENDING): query again later. */
  | { kind: 'WAIT'; reason: string }
  /** Something differs or is missing: keep everything held, show it to the owner, query again later. */
  | { kind: 'MISMATCH'; fields: string[] }
  /** The resource exists but its current state does not allow going on (e.g. VOIDED, REFUNDED). */
  | { kind: 'STOP'; reason: string };

/** E6 / D20: GET capture after the capture POST: id, parent, custom_id, amount, currency, status, payee. */
export function reconcileCapture(
  capture: Capture,
  exp: { captureId: string; amount: Money; customId: string; payee: string; authorizationId?: string },
): Reconciliation {
  const fields: string[] = [];
  if (capture.id !== exp.captureId) fields.push('id');
  if (exp.authorizationId && linkedId(capture.links, 'up', 'authorizations') !== exp.authorizationId) fields.push('parent_authorization');
  if (capture.custom_id !== exp.customId) fields.push('custom_id');
  if (!amountEquals(capture.amount, exp.amount)) fields.push('amount');
  if (capture.payee?.merchant_id === undefined) fields.push('payee_missing');
  else if (capture.payee.merchant_id !== exp.payee) fields.push('payee');
  if (fields.length) return { kind: 'MISMATCH', fields };
  if (capture.status === 'PENDING') return { kind: 'WAIT', reason: 'CAPTURE_PENDING' };
  if (capture.status !== 'COMPLETED') return { kind: 'STOP', reason: `CAPTURE_${capture.status}` };
  return { kind: 'MATCHED', status: capture.status, ...(capture.update_time ? { updateTime: capture.update_time } : {}) };
}

/** E4: GET order after the authorize POST: the authorization, order, custom_id, amount, payee and current status. */
export function reconcileAuthorization(
  order: Order,
  exp: { orderId: string; authorizationId: string; amount: Money; customId: string; payee: string },
): Reconciliation {
  const fields: string[] = [];
  if (order.id !== exp.orderId) fields.push('order_id');
  const pu = unit(order);
  const auth = pu?.payments?.authorizations?.find((a) => a.id === exp.authorizationId);
  if (!pu || !auth) return { kind: 'MISMATCH', fields: [...fields, 'authorization_missing'] };
  if ((auth.custom_id ?? pu.custom_id) !== exp.customId) fields.push('custom_id');
  if (!amountEquals(auth.amount, exp.amount)) fields.push('amount');
  if (pu.payee?.merchant_id === undefined) fields.push('payee_missing');
  else if (pu.payee.merchant_id !== exp.payee) fields.push('payee');
  if (fields.length) return { kind: 'MISMATCH', fields };
  if (auth.status === 'PENDING') return { kind: 'WAIT', reason: 'AUTHORIZATION_PENDING' };
  if (auth.status !== 'CREATED') return { kind: 'STOP', reason: `AUTHORIZATION_${auth.status}` };
  return { kind: 'MATCHED', status: auth.status, ...(auth.update_time ? { updateTime: auth.update_time } : {}) };
}

/** E-V: GET authorization after the void POST. */
export function reconcileVoid(authorization: Authorization, exp: { authorizationId: string }): Reconciliation {
  if (authorization.id !== exp.authorizationId) return { kind: 'MISMATCH', fields: ['id'] };
  if (authorization.status === 'VOIDED') return { kind: 'MATCHED', status: 'VOIDED', ...(authorization.update_time ? { updateTime: authorization.update_time } : {}) };
  if (authorization.status === 'CREATED') return { kind: 'WAIT', reason: 'AUTHORIZATION_NOT_VOIDED' };
  return { kind: 'STOP', reason: `AUTHORIZATION_${authorization.status}` };
}

/** Authorizations / captures found under an order (6.3 item 5: money found on an attempt that already ended). */
export function moneyInOrder(order: Order): { authorizations: Authorization[]; captures: Capture[] } {
  const pu = order.purchase_units?.[0];
  return { authorizations: pu?.payments?.authorizations ?? [], captures: pu?.payments?.captures ?? [] };
}
