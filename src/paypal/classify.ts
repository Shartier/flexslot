// Outcome classification for one send of a PayPal POST (DESIGN 7.1 table). Pure functions.

import type { OperationKind } from './requests.ts';

/** Why an outcome is unknown. All of these mean: keep the operation, query it, resend with the same id. */
export type UnknownReason =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'HTTP_5XX'
  | 'HTTP_429'
  | 'ALREADY_PROCESSED'
  | 'HTTP_4XX_AFTER_UNKNOWN'
  | 'HTTP_4XX_OTHER'
  | 'UNEXPECTED_STATUS'
  | 'INVALID_RESPONSE';

export type Classification =
  | { kind: 'SUCCEEDED' }
  | { kind: 'PENDING' }
  | { kind: 'FAILED' }
  | { kind: 'NOT_ACCEPTED' }
  | { kind: 'AUTH_ERROR' }
  | { kind: 'UNKNOWN'; reason: UnknownReason };

interface StatusExpectation {
  success: readonly string[];
  pending: readonly string[];
  failed: readonly string[];
}

/**
 * Which resource's status decides each operation, and which values mean what.
 * ORDER_CREATE: the order. ORDER_AUTHORIZE: the new authorization. ORDER_CAPTURE / AUTH_CAPTURE: the capture.
 * AUTH_VOID: the authorization. CAPTURE_REFUND: the refund. Anything not listed is UNEXPECTED_STATUS.
 */
export const EXPECTED_STATUS: Readonly<Record<OperationKind, StatusExpectation>> = {
  ORDER_CREATE: { success: ['CREATED', 'PAYER_ACTION_REQUIRED'], pending: [], failed: [] },
  ORDER_AUTHORIZE: { success: ['CREATED'], pending: ['PENDING'], failed: ['DENIED'] },
  ORDER_CAPTURE: { success: ['COMPLETED'], pending: ['PENDING'], failed: ['DECLINED', 'FAILED'] },
  AUTH_CAPTURE: { success: ['COMPLETED'], pending: ['PENDING'], failed: ['DECLINED', 'FAILED'] },
  AUTH_VOID: { success: ['VOIDED'], pending: [], failed: [] },
  CAPTURE_REFUND: { success: ['COMPLETED'], pending: ['PENDING'], failed: ['FAILED', 'CANCELLED'] },
};

/**
 * PayPal issues that say the target was already acted on. The earlier action may be ours (a lost response),
 * so these are UNKNOWN and settled by a query, never NOT_ACCEPTED. Names from the Orders v2 / Payments v2
 * error references and OpenAPI schemas (checked 2026-11-03).
 */
export const ALREADY_PROCESSED_ISSUES: ReadonlySet<string> = new Set([
  'ORDER_ALREADY_AUTHORIZED',
  'ORDER_ALREADY_CAPTURED',
  'ORDER_COMPLETION_IN_PROGRESS',
  'AUTHORIZATION_ALREADY_CAPTURED',
  'AUTHORIZATION_VOIDED',
  'PREVIOUSLY_CAPTURED',
  'PREVIOUSLY_VOIDED',
  'CAPTURE_FULLY_REFUNDED',
  'CAPTURED_AMOUNT_FULLY_REFUNDED',
  'DUPLICATE_INVOICE_ID',
  'DUPLICATE_REFUND',
  'DUPLICATE_TRANSACTION',
  'PREVIOUS_REQUEST_IN_PROGRESS',
]);

export function classifyResourceStatus(op: OperationKind, status: string): Classification {
  const e = EXPECTED_STATUS[op];
  if (e.success.includes(status)) return { kind: 'SUCCEEDED' };
  if (e.pending.includes(status)) return { kind: 'PENDING' };
  if (e.failed.includes(status)) return { kind: 'FAILED' };
  return { kind: 'UNKNOWN', reason: 'UNEXPECTED_STATUS' };
}

/**
 * Non-2xx HTTP answer to a POST. `issues` are the error name and details[].issue values.
 * `priorUnknownSend` is true when an earlier send of the same operation ended UNKNOWN.
 */
export function classifyHttpError(httpStatus: number, issues: readonly string[], priorUnknownSend: boolean): Classification {
  if (httpStatus === 429) return { kind: 'UNKNOWN', reason: 'HTTP_429' };
  if (httpStatus >= 500) return { kind: 'UNKNOWN', reason: 'HTTP_5XX' };
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'AUTH_ERROR' };
  if (issues.some((i) => ALREADY_PROCESSED_ISSUES.has(i))) return { kind: 'UNKNOWN', reason: 'ALREADY_PROCESSED' };
  if (priorUnknownSend) return { kind: 'UNKNOWN', reason: 'HTTP_4XX_AFTER_UNKNOWN' };
  if (httpStatus === 400 || httpStatus === 422) return { kind: 'NOT_ACCEPTED' };
  // 404, 409 and other 4xx on a first send are not in the DESIGN table; treat them as unknown and query.
  return { kind: 'UNKNOWN', reason: 'HTTP_4XX_OTHER' };
}
