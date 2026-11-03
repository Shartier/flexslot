// V2-V7 as functions over a PayPal port, so the same code runs against the Sandbox (scripts) and the mock (tests).
// IP1-01: every POST goes through Runs.bind (one request id per operation of a run, stored hash, no reuse).
// IP1-02: the expected payee must be set before anything is sent; an unchecked payee never counts as a match.

import { mismatches } from '../../src/paypal/match.ts';
import { amountEquals, type Money } from '../../src/paypal/money.ts';
import type { PayPalPort, SendResult } from '../../src/paypal/port.ts';
import {
  buildAuthorizeOrder,
  buildCaptureAuthorization,
  buildCaptureOrder,
  buildCreateOrder,
  buildRefundCapture,
  buildVoidAuthorization,
  type CreateOrderInput,
} from '../../src/paypal/requests.ts';
import { approvalUrl } from '../../src/paypal/rest.ts';
import { anon, NotReady, poll, type ReportLike, type RunRecord, type Runs } from './core.ts';

export interface StepContext {
  paypal: PayPalPort;
  expectedMerchantId: string | undefined;
  runs: Runs;
  r: ReportLike;
  returnUrl: string;
  cancelUrl: string;
  /** Interval between polls of a PENDING refund. */
  pollIntervalMs?: number;
}

const PRICE: Money = { currency: 'USD', minor: 6000 };
const COMPENSATION: Money = { currency: 'USD', minor: 1000 };

const outcome = (res: SendResult<unknown>) => (res.kind === 'UNKNOWN' ? `UNKNOWN:${res.reason}` : res.kind);

function requirePayee(ctx: StepContext): string {
  if (!ctx.expectedMerchantId) throw new NotReady('PAYPAL_EXPECTED_MERCHANT_ID is not set; nothing was sent');
  return ctx.expectedMerchantId;
}

function need(run: RunRecord, key: string, hint: string): string {
  const v = run.data[key];
  if (!v) throw new NotReady(hint);
  return v;
}

function orderInput(ctx: StepContext, run: RunRecord, label: string, intent: 'CAPTURE' | 'AUTHORIZE'): CreateOrderInput {
  return {
    intent,
    amount: PRICE,
    customId: `verify:${run.runId}:${label}`,
    invoiceId: `FS-VERIFY-${run.runId}-${label}`,
    description: `FlexSlot verification ${label}`,
    brandName: 'FlexSlot Sandbox',
    returnUrl: ctx.returnUrl,
    cancelUrl: ctx.cancelUrl,
  };
}

async function createApprovableOrder(ctx: StepContext, run: RunRecord, label: string, intent: 'CAPTURE' | 'AUTHORIZE'): Promise<void> {
  const { r, paypal, runs } = ctx;
  const input = orderInput(ctx, run, label, intent);
  const op = runs.bind(run.runId, `${label}.create`, buildCreateOrder(input), null);
  const res = await paypal.createOrder(input, { requestId: op.requestId, expectedRequestHash: op.hash });
  r.check(`${label}: order created`, res.kind === 'SUCCEEDED');
  if (res.kind !== 'SUCCEEDED') {
    r.note(`${label}_outcome`, outcome(res));
    if (res.kind === 'NOT_ACCEPTED') r.note(`${label}_issues`, res.error.issues.join(','));
    return;
  }
  runs.recordResult(run.runId, `${label}.create`, res.resource.id);
  runs.set(run.runId, { [`${label}.orderId`]: res.resource.id, [`${label}.customId`]: input.customId });
  r.note(`${label}_order`, anon('order', res.resource.id));
  r.note(`${label}_order_status`, res.externalStatus);
  const url = approvalUrl(res.resource, paypal.mode);
  if (!r.check(`${label}: approval link on the expected PayPal host`, url !== null)) return;
  r.say(`${label} approval URL (log in with the Sandbox PERSONAL account):`);
  r.say(url!);
}

async function orderApproved(ctx: StepContext, orderId: string, label: string) {
  const q = await ctx.paypal.getOrder(orderId);
  if (q.kind !== 'FOUND') throw new Error(`${label}: order query failed: ${q.kind}`);
  ctx.r.note(`${label}_order`, anon('order', orderId));
  ctx.r.note(`${label}_order_status_before`, q.resource.status);
  if (q.resource.status !== 'APPROVED' && q.resource.status !== 'COMPLETED') {
    throw new NotReady(`${label}: order is ${q.resource.status}; approve it in the browser first`);
  }
  return q.resource;
}

// ---- V2: A's original payment (intent=CAPTURE) ----------------------------------------------

export async function v2Start(ctx: StepContext): Promise<void> {
  requirePayee(ctx);
  const run = ctx.runs.startPhase('v2');
  ctx.r.note('run', run.runId);
  await createApprovableOrder(ctx, run, 'v2', 'CAPTURE');
}

export async function v2Finish(ctx: StepContext): Promise<void> {
  const { r, paypal, runs } = ctx;
  const payee = requirePayee(ctx);
  const run = runs.current();
  r.note('run', run.runId);
  const orderId = need(run, 'v2.orderId', 'run "v2 start" first');
  const customId = need(run, 'v2.customId', 'run "v2 start" first');
  await orderApproved(ctx, orderId, 'v2');

  let captureId = run.data['v2.captureId'];
  if (captureId) {
    r.note('capture_step', 'captured earlier in this run; checking by query only');
  } else {
    const op = runs.bind(run.runId, 'v2.capture', buildCaptureOrder(orderId), orderId);
    const res = await paypal.captureOrder(orderId, { requestId: op.requestId, expectedRequestHash: op.hash });
    r.note('capture_outcome', outcome(res));
    r.check('order captured (capture COMPLETED)', res.kind === 'SUCCEEDED');
    if (res.kind !== 'SUCCEEDED') return;
    captureId = res.resource.capture.id;
    runs.recordResult(run.runId, 'v2.capture', captureId);
    runs.set(run.runId, { 'v2.captureId': captureId });
    r.note('capture_response_has_payee', res.resource.capture.payee?.merchant_id !== undefined);
    r.check('capture response: amount and custom_id match', mismatches(res.resource.capture, { amount: PRICE, customId }).length === 0);
  }
  r.note('capture', anon('capture', captureId));

  const q = await paypal.getCapture(captureId);
  if (r.check('GET capture found', q.kind === 'FOUND') && q.kind === 'FOUND') {
    r.note('capture_status', q.resource.status);
    const refunded = run.data['v6.refundId'] !== undefined;
    r.check('GET capture: COMPLETED (PARTIALLY_REFUNDED after this run\'s V6)', q.resource.status === 'COMPLETED' || (refunded && q.resource.status === 'PARTIALLY_REFUNDED'));
    const m = mismatches(q.resource, { amount: PRICE, customId, payeeMerchantId: payee });
    r.check('GET capture: amount, currency, custom_id, payee match', m.length === 0);
    if (m.length) r.note('capture_mismatch', m.join(','));
  }
  const o = await paypal.getOrder(orderId);
  if (r.check('GET order found', o.kind === 'FOUND') && o.kind === 'FOUND') {
    const pu = o.resource.purchase_units?.[0];
    r.check('GET order: COMPLETED', o.resource.status === 'COMPLETED');
    r.check('GET order: purchase unit amount and payee match', !!pu && mismatches(pu, { amount: PRICE, payeeMerchantId: payee }).length === 0);
    r.check('GET order: lists the capture', !!pu?.payments?.captures?.some((c) => c.id === captureId));
  }
}

// ---- V3: B's authorizations (b1 for V4/V7, b2 for V5) -----------------------------------------

const B_KEYS = ['b1', 'b2'] as const;

export async function v3Start(ctx: StepContext): Promise<void> {
  requirePayee(ctx);
  const run = ctx.runs.startPhase('v3');
  ctx.r.note('run', run.runId);
  for (const k of B_KEYS) await createApprovableOrder(ctx, run, `v3.${k}`, 'AUTHORIZE');
}

export async function v3Finish(ctx: StepContext): Promise<void> {
  const { r, paypal, runs } = ctx;
  const payee = requirePayee(ctx);
  const run = runs.current();
  r.note('run', run.runId);
  for (const k of B_KEYS) {
    const label = `v3.${k}`;
    const orderId = need(run, `${label}.orderId`, 'run "v3 start" first');
    const customId = need(run, `${label}.customId`, 'run "v3 start" first');
    const before = await orderApproved(ctx, orderId, label);
    let pu = before.purchase_units?.[0];
    const known = run.data[`${label}.authorizationId`];
    if (known) {
      r.note(`${label}_authorize_step`, 'authorized earlier in this run; checking by query only');
      r.check(`${label}: order lists the authorization`, !!pu?.payments?.authorizations?.some((a) => a.id === known));
    } else {
      const op = runs.bind(run.runId, `${label}.authorize`, buildAuthorizeOrder(orderId), orderId);
      const res = await paypal.authorizeOrder(orderId, { requestId: op.requestId, expectedRequestHash: op.hash });
      r.note(`${label}_authorize_outcome`, outcome(res));
      r.check(`${label}: authorized (authorization CREATED)`, res.kind === 'SUCCEEDED');
      if (res.kind !== 'SUCCEEDED') continue;
      const a = res.resource.authorization;
      runs.recordResult(run.runId, `${label}.authorize`, a.id);
      runs.set(run.runId, { [`${label}.authorizationId`]: a.id });
      r.note(`${label}_authorization`, anon('auth', a.id));
      r.check(`${label}: representation has authorization id, status and expiration_time`, !!a.id && !!a.status && !!a.expiration_time);
      r.check(`${label}: authorization amount and custom_id match`, mismatches(a, { amount: PRICE, customId }).length === 0);
      pu = res.resource.order.purchase_units?.[0];
    }
    r.check(`${label}: order payee matches`, pu?.payee?.merchant_id === payee);
  }
}

// ---- V4: capture b1 with an explicit amount, resend with the same id -----------------------------

export async function v4(ctx: StepContext): Promise<void> {
  const { r, paypal, runs } = ctx;
  const payee = requirePayee(ctx);
  const run = runs.current();
  r.note('run', run.runId);
  const authorizationId = need(run, 'v3.b1.authorizationId', 'V3 finish has not authorized b1 in this run');
  const orderId = need(run, 'v3.b1.orderId', 'run "v3 start" first');
  const customId = need(run, 'v3.b1.customId', 'run "v3 start" first');
  const input = { amount: PRICE, invoiceId: `FS-VERIFY-${run.runId}-v4` };
  const op = runs.bind(run.runId, 'v4.capture', buildCaptureAuthorization(authorizationId, input), authorizationId);
  const ctxSend = { requestId: op.requestId, expectedRequestHash: op.hash };

  const first = await paypal.captureAuthorization(authorizationId, input, ctxSend);
  r.note('first_outcome', outcome(first));
  r.check('capture COMPLETED', first.kind === 'SUCCEEDED');
  if (first.kind !== 'SUCCEEDED') return;
  const captureId = first.resource.id;
  runs.recordResult(run.runId, 'v4.capture', captureId);
  runs.set(run.runId, { 'v4.captureId': captureId });
  r.note('capture', anon('capture', captureId));
  r.check('response: amount and custom_id match', mismatches(first.resource, { amount: PRICE, customId }).length === 0);

  const again = await paypal.captureAuthorization(authorizationId, input, ctxSend);
  r.note('resend_outcome', outcome(again));
  r.check('resend with the same request id returns the same capture id', again.kind === 'SUCCEEDED' && again.resource.id === captureId);

  const auth = await paypal.getAuthorization(authorizationId);
  if (r.check('GET authorization found', auth.kind === 'FOUND') && auth.kind === 'FOUND') {
    r.check('GET authorization: CAPTURED', auth.resource.status === 'CAPTURED');
    r.note('authorization_links_to_capture', (auth.resource.links ?? []).some((l) => l.href.includes(captureId)));
  }
  const order = await paypal.getOrder(orderId);
  if (r.check('GET order found', order.kind === 'FOUND') && order.kind === 'FOUND') {
    r.check('GET order: lists the capture', order.resource.purchase_units?.[0]?.payments?.captures?.some((c) => c.id === captureId) ?? false);
  }
  const cap = await paypal.getCapture(captureId);
  if (r.check('GET capture found', cap.kind === 'FOUND') && cap.kind === 'FOUND') {
    r.note('capture_status', cap.resource.status);
    const refunded = run.data['v7.refundId'] !== undefined;
    r.check('GET capture: COMPLETED (REFUNDED after this run\'s V7)', cap.resource.status === 'COMPLETED' || (refunded && cap.resource.status === 'REFUNDED'));
    const m = mismatches(cap.resource, { amount: PRICE, payeeMerchantId: payee });
    r.check('GET capture: amount, currency, payee match', m.length === 0);
    if (m.length) r.note('capture_mismatch', m.join(','));
  }
}

// ---- V5: void b2 ----------------------------------------------------------------------------

export async function v5(ctx: StepContext): Promise<void> {
  const { r, paypal, runs } = ctx;
  const run = runs.current();
  r.note('run', run.runId);
  const authorizationId = need(run, 'v3.b2.authorizationId', 'V3 finish has not authorized b2 in this run');
  const op = runs.bind(run.runId, 'v5.void', buildVoidAuthorization(authorizationId), authorizationId);
  r.note('authorization', anon('auth', authorizationId));
  const res = await paypal.voidAuthorization(authorizationId, { requestId: op.requestId, expectedRequestHash: op.hash });
  r.note('void_outcome', outcome(res));
  r.note('void_confirmed_by', res.confirmedBy ?? '-');
  r.check('void accepted (VOIDED)', res.kind === 'SUCCEEDED');
  if (res.kind === 'SUCCEEDED') runs.recordResult(run.runId, 'v5.void', res.resource.id);
  const q = await paypal.getAuthorization(authorizationId);
  if (r.check('GET authorization found', q.kind === 'FOUND') && q.kind === 'FOUND') {
    r.check('GET authorization: VOIDED', q.resource.status === 'VOIDED');
  }
}

// ---- V6: 10.00 refund on A's capture, resend, then a refund above the remaining amount -------------

export async function v6(ctx: StepContext): Promise<void> {
  const { r, paypal, runs } = ctx;
  const run = runs.current();
  r.note('run', run.runId);
  const captureId = need(run, 'v2.captureId', 'V2 finish has not captured in this run');
  const input = { amount: COMPENSATION, invoiceId: `FS-VERIFY-${run.runId}-v6`, noteToPayer: 'FlexSlot compensation (Sandbox verification)' };
  const op = runs.bind(run.runId, 'v6.refund', buildRefundCapture(captureId, input), captureId);
  const ctxSend = { requestId: op.requestId, expectedRequestHash: op.hash };
  r.note('capture', anon('capture', captureId));

  const first = await paypal.refundCapture(captureId, input, ctxSend);
  r.note('refund_outcome', outcome(first));
  r.check('refund accepted (COMPLETED or PENDING)', first.kind === 'SUCCEEDED' || first.kind === 'PENDING');
  if (first.kind !== 'SUCCEEDED' && first.kind !== 'PENDING') {
    if (first.kind === 'NOT_ACCEPTED') r.note('issues', first.error.issues.join(','));
    return;
  }
  const refundId = first.resource.id;
  runs.recordResult(run.runId, 'v6.refund', refundId);
  runs.set(run.runId, { 'v6.refundId': refundId });
  r.note('refund', anon('refund', refundId));
  const total = first.resource.seller_payable_breakdown?.total_refunded_amount;
  r.note('refund_total_refunded', total ? `${total.value} ${total.currency_code}` : 'absent');

  const again = await paypal.refundCapture(captureId, input, ctxSend);
  r.check('resend with the same request id returns the same refund id', (again.kind === 'SUCCEEDED' || again.kind === 'PENDING') && again.resource.id === refundId);

  const q = await poll(() => paypal.getRefund(refundId), (v) => v.kind === 'FOUND' && v.resource.status !== 'PENDING', 10, ctx.pollIntervalMs ?? 3000);
  const refund = q.kind === 'FOUND' ? q.resource : undefined;
  r.note('refund_status_query', refund?.status ?? q.kind);
  const belongs = (refund?.links ?? []).some((l) => l.rel === 'up' && l.href.includes(captureId));
  r.check('GET refund: COMPLETED, 10.00 USD, belongs to this run\'s A capture', !!refund && refund.status === 'COMPLETED' && amountEquals(refund.amount, COMPENSATION) && belongs);
  const c = await paypal.getCapture(captureId);
  if (r.check('GET capture found', c.kind === 'FOUND') && c.kind === 'FOUND') {
    r.check('GET capture: PARTIALLY_REFUNDED', c.resource.status === 'PARTIALLY_REFUNDED');
  }

  // Only meaningful when exactly the expected 10.00 refund is confirmed on this capture (IP1-01).
  const precondition = !!refund && refund.status === 'COMPLETED' && belongs && amountEquals(refund.amount, COMPENSATION) && (!total || amountEquals(total, COMPENSATION));
  if (!r.check('over-refund precondition: only the 10.00 refund is confirmed on this capture', precondition)) {
    r.note('over_refund', 'not run');
    return;
  }
  const over = { amount: { currency: 'USD', minor: PRICE.minor - COMPENSATION.minor + 1 } };
  const overOp = runs.bind(run.runId, 'v6.over-refund', buildRefundCapture(captureId, over), captureId);
  const res = await paypal.refundCapture(captureId, over, { requestId: overOp.requestId, expectedRequestHash: overOp.hash });
  r.note('over_refund_outcome', outcome(res));
  if (res.kind === 'NOT_ACCEPTED') r.note('over_refund_issues', res.error.issues.join(','));
  r.check('refund above the remaining amount (50.01) is rejected (NOT_ACCEPTED)', res.kind === 'NOT_ACCEPTED');
}

// ---- V7: full refund of B's capture (recovery path E-R) ----------------------------------------

export async function v7(ctx: StepContext): Promise<void> {
  const { r, paypal, runs } = ctx;
  const run = runs.current();
  r.note('run', run.runId);
  const captureId = need(run, 'v4.captureId', 'V4 has not captured in this run');
  const input = { amount: PRICE, invoiceId: `FS-VERIFY-${run.runId}-v7`, noteToPayer: 'FlexSlot swap could not be completed (Sandbox verification)' };
  const op = runs.bind(run.runId, 'v7.refund', buildRefundCapture(captureId, input), captureId);
  r.note('capture', anon('capture', captureId));
  const res = await paypal.refundCapture(captureId, input, { requestId: op.requestId, expectedRequestHash: op.hash });
  r.note('refund_outcome', outcome(res));
  r.check('full refund accepted (COMPLETED or PENDING)', res.kind === 'SUCCEEDED' || res.kind === 'PENDING');
  if (res.kind !== 'SUCCEEDED' && res.kind !== 'PENDING') {
    if (res.kind === 'NOT_ACCEPTED') r.note('issues', res.error.issues.join(','));
    return;
  }
  const refundId = res.resource.id;
  runs.recordResult(run.runId, 'v7.refund', refundId);
  runs.set(run.runId, { 'v7.refundId': refundId });
  r.note('refund', anon('refund', refundId));
  r.check('response: refund amount 60.00 USD', amountEquals(res.resource.amount, PRICE));
  const q = await poll(() => paypal.getRefund(refundId), (v) => v.kind === 'FOUND' && v.resource.status !== 'PENDING', 10, ctx.pollIntervalMs ?? 3000);
  if (r.check('GET refund found', q.kind === 'FOUND') && q.kind === 'FOUND') {
    r.check('GET refund: COMPLETED', q.resource.status === 'COMPLETED');
  }
  const c = await paypal.getCapture(captureId);
  if (r.check('GET capture found', c.kind === 'FOUND') && c.kind === 'FOUND') {
    r.check('GET capture: REFUNDED', c.resource.status === 'REFUNDED');
  }
}
