// Per-kind behaviour of the operation engine, and the business state each operation result moves
// (DESIGN 6.2, 6.3, 7.1, 7.3, 7.5, D18-D20). followOn runs in the same transaction as the operation write.

import type { Db } from '../db/database.ts';
import type { Clock } from '../clock.ts';
import { fromPayPalValue, type Money } from '../paypal/money.ts';
import type { PayPalPort, QueryResult, SendResult } from '../paypal/port.ts';
import {
  buildAuthorizeOrder,
  buildCaptureAuthorization,
  buildCaptureOrder,
  buildCreateOrder,
  buildRefundCapture,
  buildVoidAuthorization,
  type BuiltRequest,
  type CaptureAuthorizationInput,
  type CreateOrderInput,
  type RefundCaptureInput,
} from '../paypal/requests.ts';
import type { Order } from '../paypal/schemas.ts';
import { HOLD, type Block, type OpHandler, type Poll, type Recovery } from './engine.ts';
import {
  identifyAuthorization,
  identifyAuthorizationObject,
  identifyCapture,
  identifyCaptureInOrder,
  identifyCreatedOrder,
  identifyRefund,
  moneyInOrder,
  reconcileAuthorization,
  reconcileCapture,
  reconcileVoid,
  type Identification,
  type Reconciliation,
  type Resource,
} from './identify.ts';
import { captureStateProblems, refundLedger } from './ledger.ts';
import { QUERY_RETRY_MS, type OpRow, type OpTable } from './ops.ts';
import {
  CAPTURE_PHASE,
  UNFINISHED_ATTEMPT,
  aCustomId,
  audit,
  bCustomId,
  getAttempt,
  getCase,
  getObligation,
  insertAttempt,
  insertObligation,
  insertOp,
  obligationOf,
  releaseHolds,
  setAttempt,
  setCase,
  setObligation,
  settleObligation,
  succeededOp,
  type AttemptRow,
  type ObligationRow,
} from './store.ts';
import { readTerms, type CaseRow } from './terms.ts';

/**
 * IE1-01: how long an unconfirmed authorization (after B's payment deadline) or an unconfirmed capture of A's order
 * (after its creation) keeps being queried automatically while the order stays unapproved, before it is handed to
 * the owner. Nothing is ended or released by this; startup recovery still queries it once more.
 */
export const UNCONFIRMED_HOLD_AFTER_MS = 30 * 60_000;
export const A_UNCONFIRMED_HOLD_AFTER_MS = 3 * 3_600_000;

export interface Services {
  db: Db;
  paypal: PayPalPort;
  clock: Clock;
  owner: string;
}

function tag<R>(r: SendResult<R>, f: (x: R) => Resource): SendResult<Resource> {
  if ('resource' in r && r.resource !== undefined) return { ...r, resource: f(r.resource as R) } as SendResult<Resource>;
  return r as unknown as SendResult<Resource>;
}

const wrongType = (): Identification => ({ ok: false, reason: 'resource_type' });

function queryWait<R>(q: QueryResult<R>, what: string): { kind: 'WAIT'; reason: string } {
  return { kind: 'WAIT', reason: `${what}_${q.kind === 'UNAVAILABLE' ? q.reason : q.kind}` };
}

// ---- creating follow-up obligations (E-V, E-R, 6.3 item 5) -------------------------------------------------

export function startVoid(db: Db, now: number, c: CaseRow, authorizationId: string, amount: Money, reason: string, actor: string): string | null {
  if (obligationOf(db, c.id, 'B_AUTH_VOID')) return null;
  const obligationId = insertObligation(db, { caseId: c.id, kind: 'B_AUTH_VOID', amountMinor: amount.minor, currency: amount.currency, target: authorizationId });
  const attemptId = insertAttempt(db, { obligationId, attemptNo: 1, previousId: null, caseVersion: c.version, termsHash: c.terms_hash, expiresAt: null });
  insertOp(db, { table: 'payment_operations', parentId: attemptId, kind: 'AUTH_VOID', target: authorizationId, input: {}, built: buildVoidAuthorization(authorizationId), now });
  audit(db, now, { worldId: c.world_id, caseId: c.id, actor, action: 'VOID_STARTED', detail: { reason } });
  return obligationId;
}

export function startRecoveryRefund(db: Db, now: number, c: CaseRow, captureId: string, amount: Money, reason: string, actor: string): string | null {
  if (obligationOf(db, c.id, 'B_RECOVERY_REFUND')) return null;
  const obligationId = insertObligation(db, { caseId: c.id, kind: 'B_RECOVERY_REFUND', amountMinor: amount.minor, currency: amount.currency, target: captureId });
  const attemptId = insertAttempt(db, { obligationId, attemptNo: 1, previousId: null, caseVersion: c.version, termsHash: c.terms_hash, expiresAt: null });
  const input: RefundCaptureInput = { amount };
  insertOp(db, { table: 'payment_operations', parentId: attemptId, kind: 'CAPTURE_REFUND', target: captureId, input, built: buildRefundCapture(captureId, input), now });
  audit(db, now, { worldId: c.world_id, caseId: c.id, actor, action: 'B_RECOVERY_REFUND_STARTED', detail: { reason } });
  return obligationId;
}

/** Amount of a capture FlexSlot owns: from payments, from a reconciled B capture, or the full-refund obligation. */
export function captureAmountFor(db: Db, captureId: string, ob?: ObligationRow): number | null {
  const p = db.prepare('SELECT amount_minor FROM payments WHERE capture_id = ?').get(captureId) as { amount_minor: number } | undefined;
  if (p) return p.amount_minor;
  const op = db
    .prepare(
      `SELECT m.amount_minor FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id JOIN money_obligations m ON m.id = t.obligation_id
       WHERE o.op_kind = 'AUTH_CAPTURE' AND o.result_external_id = ? AND o.reconcile_status = 'MATCHED'`,
    )
    .get(captureId) as { amount_minor: number } | undefined;
  if (op) return op.amount_minor;
  if (ob?.kind === 'B_RECOVERY_REFUND' && ob.target_external_id === captureId) return ob.amount_minor;
  return null;
}

// ---- B: payment_operations ---------------------------------------------------------------------------------

interface BContext {
  attempt: AttemptRow;
  obligation: ObligationRow;
  c: CaseRow;
  payee: string | null;
  customId: string;
  charge: Money;
  orderId: string | null;
}

export class BOpHandler implements OpHandler {
  readonly #s: Services;
  readonly #kind: string;

  constructor(s: Services, kind: string) {
    this.#s = s;
    this.#kind = kind;
  }

  get needsReconcile(): boolean {
    return this.#kind === 'ORDER_AUTHORIZE' || this.#kind === 'AUTH_CAPTURE' || this.#kind === 'AUTH_VOID';
  }

  #ctx(op: OpRow): BContext {
    const db = this.#s.db;
    const attempt = getAttempt(db, op.attempt_id!);
    const obligation = getObligation(db, attempt.obligation_id);
    const c = getCase(db, obligation.case_id)!;
    const terms = readTerms(c);
    const create = obligation.kind === 'B_CHARGE' ? succeededOp(db, attempt.id, 'ORDER_CREATE') : undefined;
    return {
      attempt,
      obligation,
      c,
      payee: terms?.payeeMerchantId ?? null,
      customId: bCustomId(c.id, attempt.case_version, attempt.id),
      charge: { currency: obligation.currency, minor: obligation.amount_minor },
      orderId: create?.result_external_id ?? null,
    };
  }

  build(op: OpRow): BuiltRequest {
    const input = JSON.parse(op.request_json) as unknown;
    const t = op.target_external_id ?? '';
    switch (this.#kind) {
      case 'ORDER_CREATE':
        return buildCreateOrder(input as CreateOrderInput);
      case 'ORDER_AUTHORIZE':
        return buildAuthorizeOrder(t);
      case 'AUTH_CAPTURE':
        return buildCaptureAuthorization(t, input as CaptureAuthorizationInput);
      case 'AUTH_VOID':
        return buildVoidAuthorization(t);
      default:
        return buildRefundCapture(t, input as RefundCaptureInput);
    }
  }

  async send(op: OpRow, ctx: Parameters<PayPalPort['createOrder']>[1]): Promise<SendResult<Resource>> {
    const p = this.#s.paypal;
    const input = JSON.parse(op.request_json) as unknown;
    const t = op.target_external_id ?? '';
    switch (this.#kind) {
      case 'ORDER_CREATE':
        return tag(await p.createOrder(input as CreateOrderInput, ctx), (order) => ({ type: 'order', order }));
      case 'ORDER_AUTHORIZE':
        return tag(await p.authorizeOrder(t, ctx), (r) => ({ type: 'order', order: r.order }));
      case 'AUTH_CAPTURE':
        return tag(await p.captureAuthorization(t, input as CaptureAuthorizationInput, ctx), (capture) => ({ type: 'capture', capture }));
      case 'AUTH_VOID':
        return tag(await p.voidAuthorization(t, ctx), (authorization) => ({ type: 'authorization', authorization }));
      default:
        return tag(await p.refundCapture(t, input as RefundCaptureInput, ctx), (refund) => ({ type: 'refund', refund }));
    }
  }

  identify(op: OpRow, res: Resource): Identification {
    const x = this.#ctx(op);
    const t = op.target_external_id ?? '';
    switch (this.#kind) {
      case 'ORDER_CREATE': {
        const input = JSON.parse(op.request_json) as CreateOrderInput;
        return res.type === 'order' ? identifyCreatedOrder(res.order, { amount: input.amount, customId: input.customId, orderId: op.result_external_id }) : wrongType();
      }
      case 'ORDER_AUTHORIZE':
        return res.type === 'order'
          ? identifyAuthorization(res.order, { orderId: t, amount: x.charge, customId: x.customId, authorizationId: op.result_external_id })
          : wrongType();
      case 'AUTH_CAPTURE':
        if (res.type === 'capture') return identifyCapture(res.capture, { amount: x.charge, customId: x.customId, authorizationId: t, captureId: op.result_external_id });
        if (res.type === 'order' && x.orderId) {
          return identifyCaptureInOrder(res.order, { orderId: x.orderId, amount: x.charge, customId: x.customId, authorizationId: t, captureId: op.result_external_id });
        }
        return wrongType();
      case 'AUTH_VOID':
        return res.type === 'authorization' ? identifyAuthorizationObject(res.authorization, { authorizationId: t }) : wrongType();
      default: {
        const input = JSON.parse(op.request_json) as RefundCaptureInput;
        return res.type === 'refund' ? identifyRefund(res.refund, { amount: input.amount, captureId: t, refundId: op.result_external_id }) : wrongType();
      }
    }
  }

  mayWork(op: OpRow): boolean {
    const x = this.#ctx(op);
    // DESIGN 6.3 item 8 / STATUS I07: an unknown order creation of an ended attempt without an order id cannot
    // move money (FlexSlot never authorizes it), so it is left out of the scan. Only this case is excluded.
    if (x.attempt.status === 'EXPIRED' && op.op_kind === 'ORDER_CREATE' && op.result_external_id === null) return false;
    if (op.status === 'PREPARED') return UNFINISHED_ATTEMPT.has(x.attempt.status) && x.obligation.status === 'OPEN';
    return true;
  }

  resendAllowed(op: OpRow): boolean {
    return getAttempt(this.#s.db, op.attempt_id!).status !== 'EXPIRED';
  }

  async beforeFirstSend(op: OpRow): Promise<Block | null> {
    if (this.#kind !== 'CAPTURE_REFUND') return null;
    const x = this.#ctx(op);
    const inTx = this.#refundLedgerBlock(op, x);
    if (inTx) return inTx;
    // D18: GET capture is cross-checking material; PayPal's refunded total is not in it (STATUS F3).
    const q = await this.#s.paypal.getCapture(op.target_external_id!);
    const now = this.#s.clock.now();
    if (q.kind !== 'FOUND') return { reason: queryWait(q, 'CAPTURE_QUERY').reason, retryAt: now + QUERY_RETRY_MS, attention: false };
    const captureMinor = captureAmountFor(this.#s.db, op.target_external_id!, x.obligation)!;
    const ledger = refundLedger(this.#s.db, op.target_external_id!, captureMinor, op.id);
    const problems = captureStateProblems(ledger, q.resource, x.obligation.currency);
    return problems.length ? { reason: `LEDGER:${problems.join(',')}`, retryAt: null, attention: true } : null;
  }

  checkInTx(op: OpRow): Block | null {
    const x = this.#ctx(op);
    if (!UNFINISHED_ATTEMPT.has(x.attempt.status)) return { reason: `ATTEMPT_${x.attempt.status}`, retryAt: null, attention: false };
    if (op.op_kind === 'ORDER_CREATE' && x.attempt.expires_at !== null && this.#s.clock.now() >= x.attempt.expires_at) {
      return { reason: 'PAYMENT_EXPIRED', retryAt: null, attention: false };
    }
    return this.#kind === 'CAPTURE_REFUND' ? this.#refundLedgerBlock(op, x) : null;
  }

  /** D18: no other unconfirmed refund on the capture, records consistent, amount within the managed remainder. */
  #refundLedgerBlock(op: OpRow, x: BContext): Block | null {
    const now = this.#s.clock.now();
    if (x.obligation.status !== 'OPEN') return { reason: `OBLIGATION_${x.obligation.status}`, retryAt: null, attention: false };
    const captureId = op.target_external_id!;
    const captureMinor = captureAmountFor(this.#s.db, captureId, x.obligation);
    if (captureMinor === null) return { reason: 'CAPTURE_UNKNOWN', retryAt: null, attention: true };
    const ledger = refundLedger(this.#s.db, captureId, captureMinor, op.id);
    if (ledger.unconfirmedOpIds.length) return { reason: 'REFUND_IN_FLIGHT', retryAt: now + QUERY_RETRY_MS, attention: false };
    if (ledger.problems.length) return { reason: `LEDGER:${ledger.problems.join(',')}`, retryAt: null, attention: true };
    const amount = (JSON.parse(op.request_json) as RefundCaptureInput).amount.minor;
    if (amount > ledger.remainingMinor || amount > x.obligation.amount_minor) return { reason: 'LEDGER:EXCEEDS_REMAINING', retryAt: null, attention: true };
    return null;
  }

  async recover(op: OpRow): Promise<Recovery> {
    const p = this.#s.paypal;
    const x = this.#ctx(op);
    const t = op.target_external_id ?? '';
    switch (this.#kind) {
      case 'ORDER_CREATE': {
        if (!op.result_external_id) return { kind: 'RESEND' };
        const q = await p.getOrder(op.result_external_id);
        return q.kind === 'FOUND' ? { kind: 'RESOLVED', resource: { type: 'order', order: q.resource } } : queryWait(q, 'ORDER_QUERY');
      }
      case 'ORDER_AUTHORIZE': {
        const q = await p.getOrder(t);
        if (q.kind !== 'FOUND') return queryWait(q, 'ORDER_QUERY');
        const order = q.resource;
        const id = identifyAuthorization(order, { orderId: t, amount: x.charge, customId: x.customId, authorizationId: op.result_external_id });
        if (id.ok) return { kind: 'RESOLVED', resource: { type: 'order', order } };
        if (moneyInOrder(order).authorizations.length > 0) return { kind: 'WAIT', reason: `UNIDENTIFIED:${id.reason}`, attention: true };
        if (order.status === 'APPROVED') return { kind: 'RESEND' };
        // IE1-01: "not approved yet, no authorization" is a snapshot, not proof that the earlier POST will never take
        // effect. The operation stays unconfirmed (same id, attempt open, slot frozen); it is queried again, resent
        // with the same id once the order is approved, and handed to the owner if it stays open long after the deadline.
        if (order.status === 'CREATED' || order.status === 'PAYER_ACTION_REQUIRED') {
          const deadline = (x.attempt.expires_at ?? op.created_at) + UNCONFIRMED_HOLD_AFTER_MS;
          return this.#s.clock.now() >= deadline
            ? { kind: 'WAIT', reason: `${HOLD}UNCONFIRMED_ORDER_NOT_APPROVED`, attention: true }
            : { kind: 'WAIT', reason: 'ORDER_NOT_APPROVED' };
        }
        return { kind: 'WAIT', reason: `ORDER_${order.status}` };
      }
      case 'AUTH_CAPTURE': {
        const q = await p.getAuthorization(t);
        if (q.kind !== 'FOUND') return queryWait(q, 'AUTHORIZATION_QUERY');
        const status = q.resource.status;
        if (status === 'CREATED') return { kind: 'RESEND' };
        if (status === 'PENDING') return { kind: 'WAIT', reason: 'AUTHORIZATION_PENDING' };
        if (status === 'CAPTURED' || status === 'PARTIALLY_CAPTURED') {
          // The capture id is not linked from the authorization; the order lists it (STATUS F2).
          if (x.orderId) {
            const oq = await p.getOrder(x.orderId);
            if (oq.kind === 'FOUND' && this.identify(op, { type: 'order', order: oq.resource }).ok) return { kind: 'RESOLVED', resource: { type: 'order', order: oq.resource } };
          }
          return { kind: 'RESEND' };
        }
        return { kind: 'FAILED', reason: `AUTHORIZATION_${status}` };
      }
      case 'AUTH_VOID': {
        const q = await p.getAuthorization(t);
        if (q.kind !== 'FOUND') return queryWait(q, 'AUTHORIZATION_QUERY');
        if (q.resource.status === 'VOIDED') return { kind: 'RESOLVED', resource: { type: 'authorization', authorization: q.resource } };
        if (q.resource.status === 'CREATED') return { kind: 'RESEND' };
        return { kind: 'FAILED', reason: `AUTHORIZATION_${q.resource.status}` };
      }
      default: {
        // Without a refund id, GET capture cannot identify the refund (V6): resend with the same id.
        if (!op.result_external_id) return { kind: 'RESEND' };
        const q = await p.getRefund(op.result_external_id);
        return q.kind === 'FOUND' ? { kind: 'RESOLVED', resource: { type: 'refund', refund: q.resource } } : queryWait(q, 'REFUND_QUERY');
      }
    }
  }

  async poll(op: OpRow): Promise<Poll> {
    const p = this.#s.paypal;
    const id = op.result_external_id;
    switch (this.#kind) {
      case 'ORDER_AUTHORIZE': {
        const q = await p.getOrder(op.target_external_id!);
        return q.kind === 'FOUND' ? { kind: 'RESOURCE', resource: { type: 'order', order: q.resource } } : queryWait(q, 'ORDER_QUERY');
      }
      case 'AUTH_CAPTURE': {
        if (!id) return { kind: 'WAIT', reason: 'NO_CAPTURE_ID' };
        const q = await p.getCapture(id);
        return q.kind === 'FOUND' ? { kind: 'RESOURCE', resource: { type: 'capture', capture: q.resource } } : queryWait(q, 'CAPTURE_QUERY');
      }
      case 'CAPTURE_REFUND': {
        if (!id) return { kind: 'WAIT', reason: 'NO_REFUND_ID' };
        const q = await p.getRefund(id);
        return q.kind === 'FOUND' ? { kind: 'RESOURCE', resource: { type: 'refund', refund: q.resource } } : queryWait(q, 'REFUND_QUERY');
      }
      default:
        return { kind: 'WAIT', reason: 'NOT_POLLABLE' };
    }
  }

  async reconcile(op: OpRow): Promise<Reconciliation> {
    const p = this.#s.paypal;
    const x = this.#ctx(op);
    const t = op.target_external_id ?? '';
    if (this.#kind === 'AUTH_VOID') {
      const q = await p.getAuthorization(t);
      return q.kind === 'FOUND' ? reconcileVoid(q.resource, { authorizationId: t }) : queryWait(q, 'AUTHORIZATION_QUERY');
    }
    if (!x.payee) return { kind: 'MISMATCH', fields: ['expected_payee_missing'] };
    if (this.#kind === 'ORDER_AUTHORIZE') {
      const q = await p.getOrder(t);
      if (q.kind !== 'FOUND') return queryWait(q, 'ORDER_QUERY');
      return reconcileAuthorization(q.resource, { orderId: t, authorizationId: op.result_external_id!, amount: x.charge, customId: x.customId, payee: x.payee });
    }
    // AUTH_CAPTURE (D20): GET capture, then match id, parent authorization, custom_id, amount, status, payee.
    const q = await p.getCapture(op.result_external_id!);
    if (q.kind !== 'FOUND') return queryWait(q, 'CAPTURE_QUERY');
    return reconcileCapture(q.resource, { captureId: op.result_external_id!, amount: x.charge, customId: x.customId, payee: x.payee, authorizationId: t });
  }

  followOn(before: OpRow, after: OpRow, resource?: Resource): void {
    const db = this.#s.db;
    const now = this.#s.clock.now();
    const x = this.#ctx(after);
    const { attempt, obligation, c } = x;
    const statusChanged = before.status !== after.status;
    const matchedNow = before.reconcile_status !== 'MATCHED' && after.reconcile_status === 'MATCHED';
    const failedNow = statusChanged && (after.status === 'FAILED' || after.status === 'NOT_ACCEPTED');

    switch (obligation.kind) {
      case 'B_CHARGE':
        if (this.#kind === 'ORDER_CREATE' && statusChanged && after.status === 'SUCCEEDED') {
          if (attempt.status === 'OPEN') setAttempt(db, attempt.id, ['OPEN'], 'ORDER_CREATED');
          else if (attempt.status === 'EXPIRED' && resource?.type === 'order') this.#defendEndedAttempt(c, resource.order);
        } else if (this.#kind === 'ORDER_AUTHORIZE' && matchedNow) {
          const moved = setAttempt(db, attempt.id, ['ORDER_CREATED'], 'AUTHORIZED') && setCase(db, c, ['PAYMENT_STARTED'], 'AUTHORIZED');
          // DESIGN 6.3 item 5 / I29 (IE1-01): an authorization that turns up for an attempt or case that has already
          // ended is never used; it is voided and shown to the owner.
          if (!moved && after.result_external_id) {
            this.#audit(c, 'ATTENTION', { reason: 'MONEY_ON_ENDED_ATTEMPT', authorizations: 1, attempt: attempt.status, case: c.status });
            startVoid(db, now, c, after.result_external_id, x.charge, 'MONEY_ON_ENDED_ATTEMPT', this.#s.owner);
          }
        } else if (this.#kind === 'AUTH_CAPTURE') {
          if (matchedNow) {
            setAttempt(db, attempt.id, ['AUTHORIZED'], 'CAPTURED');
            settleObligation(db, obligation.id, after.id);
            setCase(db, c, CAPTURE_PHASE, 'CAPTURED');
          } else if (failedNow) {
            // A capture that definitively did not happen: release B's authorization (E-V).
            setAttempt(db, attempt.id, ['AUTHORIZED'], 'FAILED');
            setObligation(db, obligation.id, ['OPEN'], 'NEEDS_ATTENTION');
            if (startVoid(db, now, c, after.target_external_id!, x.charge, `CAPTURE_${after.status}`, this.#s.owner)) setCase(db, c, CAPTURE_PHASE, 'VOID_PENDING');
          } else if (after.status === 'SUCCEEDED') setCase(db, c, CAPTURE_PHASE, 'RECONCILING');
          else if (after.status === 'PENDING') setCase(db, c, CAPTURE_PHASE, 'PAYMENT_PENDING');
          else if (after.status === 'UNKNOWN') setCase(db, c, CAPTURE_PHASE, 'PAYMENT_UNKNOWN');
        }
        return;
      case 'B_AUTH_VOID':
        if (matchedNow) {
          setAttempt(db, attempt.id, ['OPEN'], 'SUCCEEDED');
          settleObligation(db, obligation.id, after.id);
          const charge = obligationOf(db, c.id, 'B_CHARGE');
          if (charge) {
            db.prepare("UPDATE payment_attempts SET status = 'FAILED' WHERE obligation_id = ? AND status IN ('OPEN', 'ORDER_CREATED', 'AUTHORIZED')").run(charge.id);
            setObligation(db, charge.id, ['OPEN', 'NEEDS_ATTENTION'], 'CANCELLED');
          }
          releaseHolds(db, c.id);
          setCase(db, c, ['VOID_PENDING'], 'REJECTED');
        } else if (failedNow) {
          setAttempt(db, attempt.id, ['OPEN'], 'FAILED');
          setObligation(db, obligation.id, ['OPEN'], 'NEEDS_ATTENTION');
        }
        return;
      default: {
        const isA = obligation.kind === 'A_COMPENSATION_REFUND';
        if (statusChanged && after.status === 'SUCCEEDED') {
          setAttempt(db, attempt.id, ['OPEN'], 'SUCCEEDED');
          settleObligation(db, obligation.id, after.id);
          setCase(db, c, isA ? ['BOOKING_COMMITTED', 'REFUND_PENDING', 'REFUND_FAILED'] : ['B_REFUND_PENDING', 'B_REFUND_FAILED'], isA ? 'COMPLETED' : 'COMPENSATED');
          // D18: the refund itself is confirmed by its id and amount; a disagreeing total is recorded and blocks
          // any further automatic refund of this capture (ledger TOTAL_MISMATCH).
          const captureMinor = captureAmountFor(db, after.target_external_id!, obligation);
          if (captureMinor !== null) {
            const ledger = refundLedger(db, after.target_external_id!, captureMinor);
            if (ledger.problems.length) this.#audit(c, 'ATTENTION', { reason: `LEDGER:${ledger.problems.join(',')}`, opKind: after.op_kind });
          }
        } else if (failedNow) {
          setAttempt(db, attempt.id, ['OPEN'], 'FAILED');
          setObligation(db, obligation.id, ['OPEN'], 'NEEDS_ATTENTION');
          setCase(db, c, isA ? ['BOOKING_COMMITTED', 'REFUND_PENDING'] : ['B_REFUND_PENDING'], isA ? 'REFUND_FAILED' : 'B_REFUND_FAILED');
        } else if (isA && (after.status === 'PENDING' || after.status === 'UNKNOWN')) {
          setCase(db, c, ['BOOKING_COMMITTED'], 'REFUND_PENDING');
        }
      }
    }
  }

  /** DESIGN 6.3 item 5: money found on an attempt that already ended (should not happen): undo it and tell the owner. */
  #defendEndedAttempt(c: CaseRow, order: Order): void {
    const db = this.#s.db;
    const now = this.#s.clock.now();
    const m = moneyInOrder(order);
    if (m.authorizations.length === 0 && m.captures.length === 0) return;
    this.#audit(c, 'ATTENTION', { reason: 'MONEY_ON_ENDED_ATTEMPT', authorizations: m.authorizations.length, captures: m.captures.length });
    const toMoney = (a: { currency_code: string; value: string } | undefined): Money | null => {
      if (!a) return null;
      try {
        const minor = fromPayPalValue(a.value, a.currency_code);
        return minor !== null && minor > 0 ? { currency: a.currency_code, minor } : null;
      } catch {
        return null;
      }
    };
    for (const a of m.authorizations) {
      const amount = toMoney(a.amount);
      if (a.status === 'CREATED' && amount) startVoid(db, now, c, a.id, amount, 'MONEY_ON_ENDED_ATTEMPT', this.#s.owner);
    }
    for (const cap of m.captures) {
      const amount = toMoney(cap.amount);
      if (cap.status === 'COMPLETED' && amount) startRecoveryRefund(db, now, c, cap.id, amount, 'MONEY_ON_ENDED_ATTEMPT', this.#s.owner);
    }
  }

  attention(op: OpRow, reason: string): void {
    const x = this.#ctx(op);
    // NEEDS_ATTENTION = automatic processing of this obligation stopped; other notices are audit entries only.
    if (op.last_error_class?.startsWith(HOLD) || op.status === 'FAILED') setObligation(this.#s.db, x.obligation.id, ['OPEN'], 'NEEDS_ATTENTION');
    this.#audit(x.c, 'ATTENTION', { reason, opKind: op.op_kind, opId: op.id });
  }

  note(op: OpRow, action: string, detail: Record<string, unknown>): void {
    this.#audit(this.#ctx(op).c, action, { ...detail, opKind: op.op_kind, opId: op.id });
  }

  #audit(c: CaseRow, action: string, detail: Record<string, unknown>): void {
    audit(this.#s.db, this.#s.clock.now(), { worldId: c.world_id, caseId: c.id, actor: this.#s.owner, action, detail });
  }
}

// ---- A's original payment: a_payment_operations (DESIGN 6.1, STATUS I08) ------------------------------------

interface AContext {
  bookingId: string;
  worldId: string;
  amount: Money;
  customId: string;
  payee: string | null;
}

export function aBookingContext(db: Db, bookingId: string): AContext | undefined {
  const row = db
    .prepare(
      `SELECT b.id, b.price_minor, s.currency, s.expected_payee_merchant_id AS payee, s.world_id
       FROM bookings b JOIN shops s ON s.id = b.shop_id WHERE b.id = ?`,
    )
    .get(bookingId) as { id: string; price_minor: number; currency: string; payee: string | null; world_id: string } | undefined;
  if (!row) return undefined;
  return { bookingId: row.id, worldId: row.world_id, amount: { currency: row.currency, minor: row.price_minor }, customId: aCustomId(row.id), payee: row.payee };
}

export class AOpHandler implements OpHandler {
  readonly #s: Services;
  readonly #kind: string;

  constructor(s: Services, kind: string) {
    this.#s = s;
    this.#kind = kind;
  }

  get needsReconcile(): boolean {
    return this.#kind === 'ORDER_CAPTURE';
  }

  #ctx(op: OpRow): AContext {
    return aBookingContext(this.#s.db, op.booking_id!)!;
  }

  build(op: OpRow): BuiltRequest {
    return this.#kind === 'ORDER_CREATE' ? buildCreateOrder(JSON.parse(op.request_json) as CreateOrderInput) : buildCaptureOrder(op.target_external_id ?? '');
  }

  async send(op: OpRow, ctx: Parameters<PayPalPort['createOrder']>[1]): Promise<SendResult<Resource>> {
    const p = this.#s.paypal;
    if (this.#kind === 'ORDER_CREATE') return tag(await p.createOrder(JSON.parse(op.request_json) as CreateOrderInput, ctx), (order) => ({ type: 'order', order }));
    return tag(await p.captureOrder(op.target_external_id!, ctx), (r) => ({ type: 'order', order: r.order }));
  }

  identify(op: OpRow, res: Resource): Identification {
    const x = this.#ctx(op);
    if (this.#kind === 'ORDER_CREATE') {
      const input = JSON.parse(op.request_json) as CreateOrderInput;
      return res.type === 'order' ? identifyCreatedOrder(res.order, { amount: input.amount, customId: input.customId, orderId: op.result_external_id }) : wrongType();
    }
    if (res.type === 'order') {
      return identifyCaptureInOrder(res.order, { orderId: op.target_external_id!, amount: x.amount, customId: x.customId, captureId: op.result_external_id });
    }
    if (res.type === 'capture') return identifyCapture(res.capture, { amount: x.amount, customId: x.customId, captureId: op.result_external_id });
    return wrongType();
  }

  mayWork(): boolean {
    return true;
  }

  resendAllowed(): boolean {
    return true;
  }

  async recover(op: OpRow): Promise<Recovery> {
    const p = this.#s.paypal;
    if (this.#kind === 'ORDER_CREATE') {
      if (!op.result_external_id) return { kind: 'RESEND' };
      const q = await p.getOrder(op.result_external_id);
      return q.kind === 'FOUND' ? { kind: 'RESOLVED', resource: { type: 'order', order: q.resource } } : queryWait(q, 'ORDER_QUERY');
    }
    const q = await p.getOrder(op.target_external_id!);
    if (q.kind !== 'FOUND') return queryWait(q, 'ORDER_QUERY');
    if (this.identify(op, { type: 'order', order: q.resource }).ok) return { kind: 'RESOLVED', resource: { type: 'order', order: q.resource } };
    if (moneyInOrder(q.resource).captures.length > 0) return { kind: 'WAIT', reason: 'UNIDENTIFIED:capture', attention: true };
    if (q.resource.status === 'APPROVED') return { kind: 'RESEND' };
    // IE1-01: as for B's authorization, a negative query never ends an unconfirmed capture of A's order.
    if (q.resource.status === 'CREATED' || q.resource.status === 'PAYER_ACTION_REQUIRED') {
      return this.#s.clock.now() >= op.created_at + A_UNCONFIRMED_HOLD_AFTER_MS
        ? { kind: 'WAIT', reason: `${HOLD}UNCONFIRMED_ORDER_NOT_APPROVED`, attention: true }
        : { kind: 'WAIT', reason: 'ORDER_NOT_APPROVED' };
    }
    return { kind: 'WAIT', reason: `ORDER_${q.resource.status}` };
  }

  async poll(op: OpRow): Promise<Poll> {
    if (this.#kind !== 'ORDER_CAPTURE' || !op.result_external_id) return { kind: 'WAIT', reason: 'NOT_POLLABLE' };
    const q = await this.#s.paypal.getCapture(op.result_external_id);
    return q.kind === 'FOUND' ? { kind: 'RESOURCE', resource: { type: 'capture', capture: q.resource } } : queryWait(q, 'CAPTURE_QUERY');
  }

  async reconcile(op: OpRow): Promise<Reconciliation> {
    const x = this.#ctx(op);
    if (!x.payee) return { kind: 'MISMATCH', fields: ['expected_payee_missing'] };
    const q = await this.#s.paypal.getCapture(op.result_external_id!);
    if (q.kind !== 'FOUND') return queryWait(q, 'CAPTURE_QUERY');
    return reconcileCapture(q.resource, { captureId: op.result_external_id!, amount: x.amount, customId: x.customId, payee: x.payee });
  }

  followOn(before: OpRow, after: OpRow): void {
    if (this.#kind !== 'ORDER_CAPTURE' || before.reconcile_status === 'MATCHED' || after.reconcile_status !== 'MATCHED') return;
    // A's booking becomes "payment confirmed" only now, after the GET capture matched (DESIGN 6.1).
    const x = this.#ctx(after);
    const db = this.#s.db;
    const exists = db.prepare('SELECT 1 FROM payments WHERE capture_id = ?').get(after.result_external_id!);
    if (exists) return;
    db.prepare(
      `INSERT INTO payments (id, booking_id, kind, order_id, capture_id, amount_minor, currency, payee_merchant_id, status_raw, verified_at)
       VALUES (?, ?, 'A_ORIGINAL', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`pay:${after.id}`, x.bookingId, after.target_external_id!, after.result_external_id!, x.amount.minor, x.amount.currency, x.payee, after.external_status ?? 'COMPLETED', this.#s.clock.now());
  }

  attention(op: OpRow, reason: string): void {
    this.note(op, 'ATTENTION', { reason });
  }

  note(op: OpRow, action: string, detail: Record<string, unknown>): void {
    const x = this.#ctx(op);
    audit(this.#s.db, this.#s.clock.now(), { worldId: x.worldId, actor: this.#s.owner, action, detail: { ...detail, opKind: op.op_kind, opId: op.id, bookingId: x.bookingId } });
  }
}

export function handlerFactory(s: Services): (table: OpTable, op: OpRow) => OpHandler {
  const cache = new Map<string, OpHandler>();
  return (table, op) => {
    const key = `${table}:${op.op_kind}`;
    let h = cache.get(key);
    if (!h) {
      h = table === 'payment_operations' ? new BOpHandler(s, op.op_kind) : new AOpHandler(s, op.op_kind);
      cache.set(key, h);
    }
    return h;
  };
}
