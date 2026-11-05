// The executor (DESIGN 6.2 E1-E8, E-V, E-R; 6.3; 7; 8; 14.3): starts a swap's payment, drives its PayPal
// operations through the send queue, commits the booking, refunds A, and recovers everything after a restart.
// Single process (DESIGN 2), but concurrent flows (browser, webhook, queue, a second executor) are kept
// apart by BEGIN IMMEDIATE, conditional updates and per-operation leases, never by in-process locks.

import { randomUUID } from 'node:crypto';
import { immediate, isSlotConflict, type Db } from '../db/database.ts';
import type { Clock } from '../clock.ts';
import type { PayPalPort } from '../paypal/port.ts';
import {
  buildAuthorizeOrder,
  buildCaptureAuthorization,
  buildCaptureOrder,
  buildCreateOrder,
  buildRefundCapture,
  buildVoidAuthorization,
  type CaptureAuthorizationInput,
  type CreateOrderInput,
  type RefundCaptureInput,
} from '../paypal/requests.ts';
import { OpEngine, type ExecutorHooks, type WorkResult } from './engine.ts';
import { aBookingContext, captureAmountFor, handlerFactory, startRecoveryRefund, startVoid } from './handlers.ts';
import { refundLedger } from './ledger.ts';
import { getOp, type OpRow, type OpTable } from './ops.ts';
import {
  CAPTURE_PHASE,
  UNFINISHED_ATTEMPT,
  audit,
  bCustomId,
  getAttempt,
  getCase,
  getObligation,
  insertAttempt,
  insertObligation,
  insertOp,
  latestAttempt,
  latestOp,
  obligationOf,
  releaseHolds,
  setAttempt,
  setCase,
  setObligation,
  succeededOp,
  type ObligationRow,
} from './store.ts';
import { readTerms, termsMismatches, type CaseRow } from './terms.ts';

export const PAYMENT_WINDOW_MS = 15 * 60_000;

export interface ExecutorOptions {
  db: Db;
  paypal: PayPalPort;
  clock: Clock;
  /** Lease owner name; a new process gets a new one. */
  owner?: string;
  hooks?: ExecutorHooks;
  /** DESIGN 6.3: B's payment deadline (default 15 minutes). */
  paymentWindowMs?: number;
  returnUrl?: string;
  cancelUrl?: string;
}

export type Refusal = { ok: false; reason: string };
const no = (reason: string): Refusal => ({ ok: false, reason });

export type StartResult = { ok: true; obligationId: string; attemptId: string; operationId: string } | Refusal;

export interface RecoveryReport {
  /** Operations found SENDING / UNKNOWN / PENDING / awaiting reconciliation and worked on. */
  recovered: string[];
  /** DESIGN 6.3 item 8: unknown order creations of ended attempts without an order id (not scanned). */
  excluded: string[];
  /** Operations whose lease was still held by someone else. */
  busy: string[];
}

const T: OpTable = 'payment_operations';
const A: OpTable = 'a_payment_operations';
const ACTIVE_CASE_STATUSES = [
  'PAYMENT_STARTED', 'AUTHORIZED', ...CAPTURE_PHASE, 'CAPTURED', 'BOOKING_COMMITTED', 'REFUND_PENDING', 'VOID_PENDING', 'B_REFUND_PENDING',
] as const;
/** DESIGN 6.3 item 8 / STATUS I07, as SQL over payment_operations o JOIN payment_attempts t. Only order creation. */
const EXCLUDED_SQL = `(t.status = 'EXPIRED' AND o.op_kind = 'ORDER_CREATE' AND o.result_external_id IS NULL)`;
/**
 * DESIGN 10 / AC12: an executor works only on worlds of its own payment mode. These joins name the world of a
 * B operation (o JOIN payment_attempts t) and of an A operation (a_payment_operations o).
 */
const B_WORLD_JOIN = 'JOIN money_obligations mo ON mo.id = t.obligation_id JOIN swap_cases mc ON mc.id = mo.case_id JOIN worlds mw ON mw.id = mc.world_id';
const A_WORLD_JOIN = 'JOIN bookings mb ON mb.id = o.booking_id JOIN shops ms ON ms.id = mb.shop_id JOIN worlds mw ON mw.id = ms.world_id';

class BookingImpossible extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BookingImpossible';
  }
}

export class Executor {
  readonly owner: string;
  readonly #db: Db;
  readonly #paypal: PayPalPort;
  readonly #clock: Clock;
  readonly #hooks: ExecutorHooks | undefined;
  readonly #engine: OpEngine;
  readonly #window: number;
  readonly #returnUrl: string;
  readonly #cancelUrl: string;

  constructor(o: ExecutorOptions) {
    this.owner = o.owner ?? `executor-${randomUUID()}`;
    this.#db = o.db;
    this.#paypal = o.paypal;
    this.#clock = o.clock;
    this.#hooks = o.hooks;
    this.#window = o.paymentWindowMs ?? PAYMENT_WINDOW_MS;
    this.#returnUrl = o.returnUrl ?? 'http://localhost:5173/paypal/return';
    this.#cancelUrl = o.cancelUrl ?? 'http://localhost:5173/paypal/cancel';
    const handlerFor = handlerFactory({ db: o.db, paypal: o.paypal, clock: o.clock, owner: this.owner });
    this.#engine = new OpEngine({ db: o.db, clock: o.clock, owner: this.owner, hooks: o.hooks, handlerFor, belongs: (table, op) => this.#ownsOp(table, op) });
  }

  /** The payment mode this executor serves (DESIGN 10). */
  get mode(): string {
    return this.#paypal.mode;
  }

  /** True when the operation belongs to a world of this executor's payment mode (DESIGN 10, AC12). */
  #caseInMode(caseId: string): boolean {
    const row = this.#db.prepare('SELECT w.mode_payment AS mode FROM swap_cases c JOIN worlds w ON w.id = c.world_id WHERE c.id = ?').get(caseId) as
      | { mode: string }
      | undefined;
    return row?.mode === this.#paypal.mode;
  }

  #bookingInMode(bookingId: string): boolean {
    const row = this.#db
      .prepare('SELECT w.mode_payment AS mode FROM bookings b JOIN shops s ON s.id = b.shop_id JOIN worlds w ON w.id = s.world_id WHERE b.id = ?')
      .get(bookingId) as { mode: string } | undefined;
    return row?.mode === this.#paypal.mode;
  }

  #ownsOp(table: OpTable, op: OpRow): boolean {
    const sql =
      table === 'payment_operations'
        ? `SELECT mw.mode_payment AS mode FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id ${B_WORLD_JOIN} WHERE o.id = ?`
        : `SELECT mw.mode_payment AS mode FROM a_payment_operations o ${A_WORLD_JOIN} WHERE o.id = ?`;
    const row = this.#db.prepare(sql).get(op.id) as { mode: string } | undefined;
    return row?.mode === this.#paypal.mode;
  }

  // ---- E1: start (B approves the terms and presses pay) ----------------------------------------------

  startPayment(req: { caseId: string; version: number; termsHash: string; bPartyId: string }): StartResult {
    const db = this.#db;
    const now = this.#clock.now();
    return immediate(db, (): StartResult => {
      const c = getCase(db, req.caseId);
      if (!c) return no('CASE_NOT_FOUND');
      if (c.status !== 'A_ACCEPTED') return no(c.status === 'PAYMENT_STARTED' ? 'ALREADY_STARTED' : 'NOT_STARTABLE');
      if (c.version !== req.version || c.terms_hash !== req.termsHash) return no('TERMS_CHANGED');
      if (now >= c.offer_expires_at) return no('OFFER_EXPIRED');
      const b = db.prepare('SELECT customer_id FROM b_requests WHERE id = ?').get(c.b_request_id) as { customer_id: string } | undefined;
      if (b?.customer_id !== req.bPartyId) return no('NOT_B');
      const problems = this.#executionProblems(c, 'ACTIVE', ['OWNER', 'A']);
      if (problems.length) return no(problems[0]!);
      // DESIGN 6.2: exactly one execution right (AC06, C04).
      const r = db.prepare("UPDATE swap_cases SET status = 'PAYMENT_STARTED' WHERE id = ? AND status = 'A_ACCEPTED' AND version = ?").run(c.id, c.version);
      if (r.changes !== 1) return no('ALREADY_STARTED');
      db.prepare(
        "INSERT INTO approvals (case_id, role, party_id, terms_hash, decision, decided_at) VALUES (?, 'B', ?, ?, 'APPROVED', ?) ON CONFLICT (case_id, role, terms_hash) DO NOTHING",
      ).run(c.id, req.bPartyId, c.terms_hash, now);
      db.prepare(
        "UPDATE slot_holds SET status = 'FROZEN' WHERE case_id = ? AND status = 'ACTIVE' AND stylist_id = ? AND start_ms = ? AND end_ms = ?",
      ).run(c.id, c.stylist_id, c.dest_start_ms, c.dest_end_ms);
      const obligationId = insertObligation(db, { caseId: c.id, kind: 'B_CHARGE', amountMinor: c.b_price_minor, currency: c.currency, target: null });
      const attemptId = insertAttempt(db, { obligationId, attemptNo: 1, previousId: null, caseVersion: c.version, termsHash: c.terms_hash, expiresAt: now + this.#window });
      const input: CreateOrderInput = {
        intent: 'AUTHORIZE',
        amount: { currency: c.currency, minor: c.b_price_minor },
        customId: bCustomId(c.id, c.version, attemptId),
        invoiceId: `FS-${c.id}-B-1`,
        returnUrl: this.#returnUrl,
        cancelUrl: this.#cancelUrl,
      };
      // DESIGN 6.1 / 7.5: before the send only the request id, the fixed input and its hash exist (no order id yet).
      const op = insertOp(db, { table: T, parentId: attemptId, kind: 'ORDER_CREATE', target: null, input, built: buildCreateOrder(input), now });
      this.#audit(c, 'PAYMENT_STARTED', { attemptId });
      return { ok: true, obligationId, attemptId, operationId: op.id };
    });
  }

  /** Re-checks of E1 and E5: terms, approvals, A's booking and payment, the destination hold, payee, mode. */
  #executionProblems(c: CaseRow, holdStatus: 'ACTIVE' | 'FROZEN', roles: readonly string[]): string[] {
    const db = this.#db;
    const now = this.#clock.now();
    const out: string[] = [];
    const terms = readTerms(c);
    if (!terms || termsMismatches(c, terms).length) out.push('TERMS_INVALID');
    const world = db.prepare('SELECT mode_payment FROM worlds WHERE id = ?').get(c.world_id) as { mode_payment: string } | undefined;
    if (world?.mode_payment !== this.#paypal.mode) out.push('MODE_MISMATCH');
    for (const role of roles) {
      const ok = db.prepare("SELECT 1 FROM approvals WHERE case_id = ? AND role = ? AND terms_hash = ? AND decision = 'APPROVED'").get(c.id, role, c.terms_hash);
      if (!ok) out.push('NOT_APPROVED');
    }
    const shop = db
      .prepare('SELECT s.currency, s.expected_payee_merchant_id AS payee FROM bookings b JOIN shops s ON s.id = b.shop_id WHERE b.id = ?')
      .get(c.a_booking_id) as { currency: string; payee: string | null } | undefined;
    if (!shop?.payee) out.push('PAYEE_NOT_SET');
    else if (shop.payee !== terms?.payeeMerchantId) out.push('PAYEE_CHANGED');
    if (shop && shop.currency !== c.currency) out.push('CURRENCY_MISMATCH');
    const a = db
      .prepare("SELECT 1 FROM bookings WHERE id = ? AND status = 'CONFIRMED' AND version = ? AND stylist_id = ? AND start_ms = ? AND end_ms = ?")
      .get(c.a_booking_id, c.a_booking_version, c.stylist_id, c.origin_start_ms, c.origin_end_ms);
    if (!a) out.push('A_BOOKING_CHANGED');
    const paid = db
      .prepare("SELECT 1 FROM payments WHERE booking_id = ? AND kind = 'A_ORIGINAL' AND capture_id = ? AND verified_at IS NOT NULL")
      .get(c.a_booking_id, c.a_capture_id);
    if (!paid) out.push('A_PAYMENT_NOT_CONFIRMED');
    const hold = db
      .prepare('SELECT status, expires_at FROM slot_holds WHERE case_id = ? AND stylist_id = ? AND start_ms = ? AND end_ms = ? AND status = ?')
      .get(c.id, c.stylist_id, c.dest_start_ms, c.dest_end_ms, holdStatus) as { status: string; expires_at: number } | undefined;
    // An ACTIVE hold is valid while now < expires_at (STATUS I03); a FROZEN one never lapses by time.
    if (!hold || (holdStatus === 'ACTIVE' && now >= hold.expires_at)) out.push('HOLD_INVALID');
    return [...new Set(out)];
  }

  // ---- E2: create the order -----------------------------------------------------------------------------

  async createOrder(caseId: string): Promise<{ ok: true; orderId: string } | Refusal> {
    if (!this.#caseInMode(caseId)) return no('MODE_MISMATCH');
    const charge = obligationOf(this.#db, caseId, 'B_CHARGE');
    const att = charge && latestAttempt(this.#db, charge.id);
    const op = att && latestOp(this.#db, att.id, 'ORDER_CREATE');
    if (!op) return no('NOT_STARTED');
    await this.#drive(T, op.id);
    const after = getOp(this.#db, T, op.id)!;
    if (after.status === 'SUCCEEDED' && after.result_external_id) return { ok: true, orderId: after.result_external_id };
    return no(after.status === 'FAILED' || after.status === 'NOT_ACCEPTED' ? 'ORDER_CREATE_FAILED' : 'ORDER_CREATE_UNCONFIRMED');
  }

  // ---- E3 / E4: B approved on PayPal (browser signal, webhook or executor) -> authorize -----------------

  async onBuyerApproved(caseId: string): Promise<{ ok: true; status: string } | Refusal> {
    if (!this.#caseInMode(caseId)) return no('MODE_MISMATCH');
    const db = this.#db;
    const now = this.#clock.now();
    const r = immediate(db, (): Refusal | { opId: string; leaseGen: number | null } => {
      const c = getCase(db, caseId);
      if (!c) return no('CASE_NOT_FOUND');
      const charge = obligationOf(db, c.id, 'B_CHARGE');
      const att = charge && latestAttempt(db, charge.id);
      if (!att) return no(c.status === 'EXPIRED' ? 'PAYMENT_EXPIRED' : 'NOT_STARTED');
      const existing = db
        .prepare("SELECT * FROM payment_operations WHERE attempt_id = ? AND op_kind = 'ORDER_AUTHORIZE' AND status NOT IN ('FAILED', 'NOT_ACCEPTED')")
        .get(att.id) as OpRow | undefined;
      if (existing) return { opId: existing.id, leaseGen: null };
      // DESIGN 6.3 item 4: the attempt must still be valid; checked in the same transaction that records the authorize.
      if (att.status === 'EXPIRED' || c.status === 'EXPIRED') return no('PAYMENT_EXPIRED');
      if (att.status !== 'ORDER_CREATED') return no(att.status === 'OPEN' ? 'ORDER_NOT_CREATED' : `ATTEMPT_${att.status}`);
      if (att.expires_at !== null && now >= att.expires_at) return no('PAYMENT_EXPIRED');
      if (c.status !== 'PAYMENT_STARTED') return no('NOT_PAYABLE');
      const orderId = succeededOp(db, att.id, 'ORDER_CREATE')!.result_external_id!;
      const last = latestOp(db, att.id, 'ORDER_AUTHORIZE');
      const ins = insertOp(db, {
        table: T,
        parentId: att.id,
        kind: 'ORDER_AUTHORIZE',
        seq: (last?.op_seq ?? 0) + 1,
        previousId: last?.id ?? null,
        target: orderId,
        input: {},
        built: buildAuthorizeOrder(orderId),
        now,
        leaseOwner: this.owner,
      });
      return { opId: ins.id, leaseGen: ins.leaseGen };
    });
    if ('ok' in r) return r;
    if (r.leaseGen !== null) await this.#engine.sendLeased(T, r.opId, r.leaseGen);
    await this.#drive(T, r.opId);
    return { ok: true, status: getCase(db, caseId)!.status };
  }

  // ---- driving --------------------------------------------------------------------------------------------

  /** Drives one case as far as it can go now (E4-E8, E-V, E-R). Returns the case status. */
  async advance(caseId: string): Promise<string> {
    // DESIGN 10: never move a case of the other payment mode (E5 would otherwise see MODE_MISMATCH and void).
    if (!this.#caseInMode(caseId)) return getCase(this.#db, caseId)?.status ?? 'MISSING';
    for (let i = 0; i < 60; i++) {
      if ((await this.#step(caseId)) !== 'PROGRESSED') break;
    }
    return getCase(this.#db, caseId)?.status ?? 'MISSING';
  }

  async #step(caseId: string): Promise<WorkResult> {
    const db = this.#db;
    const c = getCase(db, caseId);
    if (!c) return 'WAITING';
    const opOf = (kind: ObligationRow['kind'], opKind?: string): OpRow | undefined => {
      const ob = obligationOf(db, c.id, kind);
      const att = ob && latestAttempt(db, ob.id);
      return att ? latestOp(db, att.id, opKind) : undefined;
    };
    const work = async (op: OpRow | undefined) => (op ? this.#engine.work(T, op.id) : 'WAITING');
    switch (c.status) {
      case 'PAYMENT_STARTED':
        return work(opOf('B_CHARGE'));
      case 'AUTHORIZED':
        return this.#preCapture(c.id) ? 'PROGRESSED' : 'WAITING';
      case 'CAPTURING':
      case 'PAYMENT_PENDING':
      case 'RECONCILING':
      case 'PAYMENT_UNKNOWN':
        return work(opOf('B_CHARGE', 'AUTH_CAPTURE'));
      case 'CAPTURED':
        return this.#commitBooking(c.id);
      case 'BOOKING_COMMITTED':
      case 'REFUND_PENDING':
        return work(opOf('A_COMPENSATION_REFUND'));
      case 'VOID_PENDING':
        return work(opOf('B_AUTH_VOID'));
      case 'B_REFUND_PENDING':
        return work(opOf('B_RECOVERY_REFUND'));
      default:
        return 'WAITING';
    }
  }

  async #drive(table: OpTable, opId: string, force = false): Promise<WorkResult> {
    let r: WorkResult = 'WAITING';
    for (let i = 0; i < 12; i++) {
      r = await this.#engine.work(table, opId, { force: force && i === 0 });
      if (r !== 'PROGRESSED') break;
    }
    return r;
  }

  // ---- E5: checks before the capture; E-V when they fail ---------------------------------------------------

  #preCapture(caseId: string): boolean {
    const db = this.#db;
    const now = this.#clock.now();
    return immediate(db, () => {
      const c = getCase(db, caseId)!;
      if (c.status !== 'AUTHORIZED') return false;
      const charge = obligationOf(db, c.id, 'B_CHARGE')!;
      const att = latestAttempt(db, charge.id)!;
      const auth = succeededOp(db, att.id, 'ORDER_AUTHORIZE');
      const problems = this.#executionProblems(c, 'FROZEN', ['OWNER', 'A', 'B']);
      if (!auth || auth.reconcile_status !== 'MATCHED' || att.status !== 'AUTHORIZED' || charge.status !== 'OPEN') problems.push('AUTHORIZATION_STATE');
      if (problems.length === 0) {
        if (latestOp(db, att.id, 'AUTH_CAPTURE')) return false;
        const input: CaptureAuthorizationInput = { amount: { currency: c.currency, minor: c.b_price_minor } };
        const authId = auth!.result_external_id!;
        insertOp(db, { table: T, parentId: att.id, kind: 'AUTH_CAPTURE', target: authId, input, built: buildCaptureAuthorization(authId, input), now });
        return setCase(db, c, ['AUTHORIZED'], 'CAPTURING');
      }
      this.#audit(c, 'PRE_CAPTURE_CHECK_FAILED', { problems });
      if (auth?.result_external_id) startVoid(db, now, c, auth.result_external_id, { currency: c.currency, minor: c.b_price_minor }, problems.join(','), this.owner);
      return setCase(db, c, ['AUTHORIZED'], 'VOID_PENDING');
    });
  }

  // ---- E7: booking commit with its processed marker; E-R when definitively impossible ---------------------

  #commitBooking(caseId: string): WorkResult {
    const db = this.#db;
    this.#hooks?.at?.('before-e7', { caseId });
    const now = this.#clock.now();
    try {
      const done = immediate(db, () => {
        const c = getCase(db, caseId)!;
        if (c.status !== 'CAPTURED') return false;
        const charge = obligationOf(db, c.id, 'B_CHARGE')!;
        if (charge.status !== 'SETTLED') return false;
        const capOp = getOp(db, T, charge.settled_by_operation_id!)!;
        const createOp = succeededOp(db, capOp.attempt_id!, 'ORDER_CREATE')!;
        // DESIGN 4.4: hold CONVERTED -> A moves to the destination -> B takes the original slot (triggers check each).
        const hold = db
          .prepare("UPDATE slot_holds SET status = 'CONVERTED' WHERE case_id = ? AND status = 'FROZEN' AND stylist_id = ? AND start_ms = ? AND end_ms = ?")
          .run(c.id, c.stylist_id, c.dest_start_ms, c.dest_end_ms);
        if (hold.changes !== 1) throw new BookingImpossible('HOLD_NOT_FROZEN');
        const moved = db
          .prepare(
            "UPDATE bookings SET start_ms = ?, end_ms = ?, version = version + 1 WHERE id = ? AND version = ? AND status = 'CONFIRMED' AND start_ms = ? AND end_ms = ?",
          )
          .run(c.dest_start_ms, c.dest_end_ms, c.a_booking_id, c.a_booking_version, c.origin_start_ms, c.origin_end_ms);
        if (moved.changes !== 1) throw new BookingImpossible('A_BOOKING_CHANGED');
        const req = db.prepare('SELECT customer_id, structured_json FROM b_requests WHERE id = ?').get(c.b_request_id) as { customer_id: string; structured_json: string };
        const serviceId = (JSON.parse(req.structured_json) as { serviceId?: string }).serviceId;
        if (!serviceId) throw new BookingImpossible('B_SERVICE_MISSING');
        const shopId = (db.prepare('SELECT shop_id FROM bookings WHERE id = ?').get(c.a_booking_id) as { shop_id: string }).shop_id;
        const bBookingId = `${c.id}:booking:b`;
        db.prepare(
          `INSERT INTO bookings (id, shop_id, stylist_id, customer_id, service_id, start_ms, end_ms, status, version, price_minor)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', 1, ?)`,
        ).run(bBookingId, shopId, c.stylist_id, req.customer_id, serviceId, c.b_start_ms, c.b_end_ms, c.b_price_minor);
        // payments references bookings, so B's row is written here, with the reconciled capture (DESIGN 7.5).
        db.prepare(
          `INSERT INTO payments (id, booking_id, kind, order_id, capture_id, amount_minor, currency, payee_merchant_id, status_raw, verified_at)
           VALUES (?, ?, 'B_SWAP', ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `${c.id}:payment:b`, bBookingId, createOp.result_external_id!, capOp.result_external_id!, charge.amount_minor, charge.currency,
          readTerms(c)!.payeeMerchantId, capOp.external_status ?? 'COMPLETED', capOp.reconciled_at,
        );
        // Processed marker (DESIGN 6.2): status, compensation grant and A's refund obligation, all or nothing.
        db.prepare('INSERT INTO compensation_grants (booking_id, case_id, granted_at) VALUES (?, ?, ?)').run(c.a_booking_id, c.id, now);
        if (c.a_comp_minor > 0) {
          const obligationId = insertObligation(db, { caseId: c.id, kind: 'A_COMPENSATION_REFUND', amountMinor: c.a_comp_minor, currency: c.currency, target: c.a_capture_id });
          const attemptId = insertAttempt(db, { obligationId, attemptNo: 1, previousId: null, caseVersion: c.version, termsHash: c.terms_hash, expiresAt: null });
          const input: RefundCaptureInput = { amount: { currency: c.currency, minor: c.a_comp_minor } };
          insertOp(db, { table: T, parentId: attemptId, kind: 'CAPTURE_REFUND', target: c.a_capture_id, input, built: buildRefundCapture(c.a_capture_id, input), now });
        }
        if (!setCase(db, c, ['CAPTURED'], c.a_comp_minor > 0 ? 'BOOKING_COMMITTED' : 'COMPLETED')) throw new Error('case moved during the booking commit');
        this.#audit(c, 'BOOKING_COMMITTED', { bBookingId });
        return true;
      });
      if (done) this.#hooks?.at?.('after-e7', { caseId });
      return done ? 'PROGRESSED' : 'WAITING';
    } catch (error) {
      if (!(error instanceof BookingImpossible) && !isSlotConflict(error) && !isConstraintError(error)) throw error;
      // DESIGN 8: definitively impossible. A keeps the original booking; B is refunded in full (E-R).
      return immediate(db, () => {
        const c = getCase(db, caseId)!;
        if (c.status !== 'CAPTURED') return 'WAITING';
        const charge = obligationOf(db, c.id, 'B_CHARGE')!;
        const capOp = getOp(db, T, charge.settled_by_operation_id!)!;
        const reason = error instanceof Error ? error.message : 'BOOKING_COMMIT_FAILED';
        startRecoveryRefund(db, now, c, capOp.result_external_id!, { currency: charge.currency, minor: charge.amount_minor }, reason, this.owner);
        releaseHolds(db, c.id);
        setCase(db, c, ['CAPTURED'], 'B_REFUND_PENDING');
        return 'PROGRESSED';
      });
    }
  }

  // ---- DESIGN 6.3: payment deadline -------------------------------------------------------------------------

  /** Ends B attempts past their deadline that never started an authorization. Returns the ended attempt ids. */
  expireAttempts(): string[] {
    const db = this.#db;
    const now = this.#clock.now();
    const due = db
      .prepare(
        `SELECT t.id FROM payment_attempts t JOIN money_obligations o ON o.id = t.obligation_id
         JOIN swap_cases c ON c.id = o.case_id JOIN worlds w ON w.id = c.world_id
         WHERE o.kind = 'B_CHARGE' AND t.status IN ('OPEN', 'ORDER_CREATED') AND t.expires_at IS NOT NULL AND t.expires_at <= ?
           AND w.mode_payment = ?`,
      )
      .all(now, this.#paypal.mode) as Array<{ id: string }>;
    const ended: string[] = [];
    for (const { id } of due) {
      immediate(db, () => {
        const att = getAttempt(db, id);
        if (!(att.status === 'OPEN' || att.status === 'ORDER_CREATED') || att.expires_at === null || att.expires_at > now) return;
        // 6.3 items 2-3: never while an authorization exists or may exist (PREPARED, SENDING, unknown, PENDING, done), or any capture.
        const blocking = db
          .prepare(
            `SELECT 1 FROM payment_operations WHERE attempt_id = ? AND (op_kind = 'AUTH_CAPTURE'
               OR (op_kind = 'ORDER_AUTHORIZE' AND status IN ('PREPARED', 'SENDING', 'UNKNOWN', 'PENDING', 'SUCCEEDED')))`,
          )
          .get(id);
        if (blocking) return;
        setAttempt(db, id, ['OPEN', 'ORDER_CREATED'], 'EXPIRED');
        const ob = getObligation(db, att.obligation_id);
        setObligation(db, ob.id, ['OPEN', 'NEEDS_ATTENTION'], 'CANCELLED');
        const c = getCase(db, ob.case_id)!;
        releaseHolds(db, c.id);
        setCase(db, c, ['PAYMENT_STARTED'], 'EXPIRED');
        this.#audit(c, 'PAYMENT_EXPIRED', { attemptId: id });
        const create = latestOp(db, id, 'ORDER_CREATE');
        if (create && create.status !== 'SUCCEEDED' && create.result_external_id === null) {
          // No order id: FlexSlot never authorizes this attempt, so no money can move. Left out of the scan (I07).
          this.#audit(c, 'RECOVERY_EXCLUDED', { opId: create.id, opKind: 'ORDER_CREATE', reason: 'ATTEMPT_EXPIRED_WITHOUT_ORDER_ID' });
        }
        ended.push(id);
      });
    }
    return ended;
  }

  // ---- the send queue and startup recovery -----------------------------------------------------------------

  /** One queue tick: deadlines, due operations (resends with backoff, polls, reconciliations), then cases. */
  async processDue(): Promise<void> {
    this.expireAttempts();
    const now = this.#clock.now();
    for (const { table, id } of this.#scan({ now, due: true })) await this.#drive(table, id);
    for (const caseId of this.#activeCases()) await this.advance(caseId);
  }

  /**
   * Startup recovery (DESIGN 7.5, 8): every operation left SENDING, UNKNOWN, PENDING or awaiting
   * reconciliation is recovered by itself (query, or same-id resend), then every active case is advanced.
   * No new operation or attempt is created for an unknown one.
   */
  async recover(): Promise<RecoveryReport> {
    const db = this.#db;
    const now = this.#clock.now();
    const excluded = (
      db
        .prepare(
          `SELECT o.id FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id ${B_WORLD_JOIN}
           WHERE o.status IN ('PREPARED', 'SENDING', 'UNKNOWN', 'PENDING') AND ${EXCLUDED_SQL} AND mw.mode_payment = ?`,
        )
        .all(this.#paypal.mode) as Array<{ id: string }>
    ).map((r) => r.id);
    const targets = this.#scan({ now, due: false, unconfirmedOnly: true });
    const busy: string[] = [];
    for (const { table, id } of targets) {
      const r = await this.#drive(table, id, true);
      if (r === 'BUSY') busy.push(id);
    }
    for (const caseId of this.#activeCases()) await this.advance(caseId);
    return { recovered: targets.map((t) => t.id), excluded, busy };
  }

  #scan(o: { now: number; due: boolean; unconfirmedOnly?: boolean }): Array<{ table: OpTable; id: string }> {
    const db = this.#db;
    const state = o.unconfirmedOnly
      ? `(o.status IN ('SENDING', 'UNKNOWN', 'PENDING') OR (o.status = 'SUCCEEDED' AND o.reconcile_status = 'AWAITING'))`
      : `(o.status IN ('PREPARED', 'SENDING', 'UNKNOWN', 'PENDING') OR (o.status = 'SUCCEEDED' AND o.reconcile_status = 'AWAITING'))`;
    const schedule = o.due ? `AND (o.next_send_at IS NULL OR o.next_send_at <= ${o.now}) AND (o.last_error_class IS NULL OR o.last_error_class NOT LIKE 'HOLD:%')` : '';
    const lease = `AND (o.lease_until IS NULL OR o.lease_until < ${o.now})`;
    const mode = this.#paypal.mode;
    const b = db
      .prepare(
        `SELECT o.id FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id ${B_WORLD_JOIN}
         WHERE ${state} ${schedule} ${lease} AND NOT ${EXCLUDED_SQL} AND mw.mode_payment = ? ORDER BY o.rowid`,
      )
      .all(mode) as Array<{ id: string }>;
    const a = db
      .prepare(`SELECT o.id FROM a_payment_operations o ${A_WORLD_JOIN} WHERE ${state} ${schedule} ${lease} AND mw.mode_payment = ? ORDER BY o.rowid`)
      .all(mode) as Array<{ id: string }>;
    return [...b.map((r) => ({ table: T, id: r.id })), ...a.map((r) => ({ table: A, id: r.id }))];
  }

  #activeCases(): string[] {
    return (
      this.#db
        .prepare(
          `SELECT c.id FROM swap_cases c JOIN worlds w ON w.id = c.world_id
           WHERE c.status IN (${ACTIVE_CASE_STATUSES.map(() => '?').join(', ')}) AND w.mode_payment = ? ORDER BY c.rowid`,
        )
        .all(...ACTIVE_CASE_STATUSES, this.#paypal.mode) as Array<{ id: string }>
    ).map((r) => r.id);
  }

  // ---- owner: recover an existing obligation after a definitive failure (DESIGN 5, 7.1, 8) -------------------

  retryObligation(obligationId: string): { ok: true; attemptId: string; operationId: string } | Refusal {
    const db = this.#db;
    const now = this.#clock.now();
    return immediate(db, () => {
      const ob = db.prepare('SELECT * FROM money_obligations WHERE id = ?').get(obligationId) as ObligationRow | undefined;
      if (!ob) return no('OBLIGATION_NOT_FOUND');
      if (!this.#caseInMode(ob.case_id)) return no('MODE_MISMATCH');
      if (ob.kind === 'B_CHARGE') return no('NOT_RETRYABLE'); // a new checkout needs a new case (6.3 item 6)
      if (ob.status === 'SETTLED') return no('ALREADY_SETTLED');
      if (ob.status === 'CANCELLED') return no('NOT_RETRYABLE');
      const last = latestAttempt(db, ob.id);
      if (!last) return no('NO_ATTEMPT');
      if (UNFINISHED_ATTEMPT.has(last.status)) return no('ATTEMPT_UNFINISHED');
      if (last.status !== 'FAILED') return no('NOT_FAILED');
      const lastOp = latestOp(db, last.id)!;
      // Only after a confirmed failure (FAILED / NOT_ACCEPTED), never after PENDING or unknown (DESIGN 7.1, DR1-02).
      if (lastOp.status !== 'FAILED' && lastOp.status !== 'NOT_ACCEPTED') return no('FAILURE_NOT_CONFIRMED');
      const c = getCase(db, ob.case_id)!;
      if (ob.kind !== 'B_AUTH_VOID') {
        const captureMinor = captureAmountFor(db, ob.target_external_id!, ob);
        if (captureMinor === null) return no('CAPTURE_UNKNOWN');
        const ledger = refundLedger(db, ob.target_external_id!, captureMinor);
        if (ledger.unconfirmedOpIds.length) return no('REFUND_IN_FLIGHT');
        if (ledger.problems.length) return no(`LEDGER:${ledger.problems.join(',')}`);
        if (ob.amount_minor > ledger.remainingMinor) return no('LEDGER:EXCEEDS_REMAINING');
      }
      const attemptId = insertAttempt(db, { obligationId: ob.id, attemptNo: last.attempt_no + 1, previousId: last.id, caseVersion: c.version, termsHash: c.terms_hash, expiresAt: null });
      const target = ob.target_external_id!;
      let operationId: string;
      if (ob.kind === 'B_AUTH_VOID') {
        operationId = insertOp(db, { table: T, parentId: attemptId, kind: 'AUTH_VOID', target, input: {}, built: buildVoidAuthorization(target), now }).id;
      } else {
        // Same amount as the obligation; a new operation gets a new PayPal-Request-Id.
        const input: RefundCaptureInput = { amount: { currency: ob.currency, minor: ob.amount_minor } };
        operationId = insertOp(db, { table: T, parentId: attemptId, kind: 'CAPTURE_REFUND', target, input, built: buildRefundCapture(target, input), now }).id;
      }
      setObligation(db, ob.id, ['NEEDS_ATTENTION'], 'OPEN');
      if (ob.kind === 'A_COMPENSATION_REFUND') setCase(db, c, ['REFUND_FAILED'], 'REFUND_PENDING');
      if (ob.kind === 'B_RECOVERY_REFUND') setCase(db, c, ['B_REFUND_FAILED'], 'B_REFUND_PENDING');
      this.#audit(c, 'OBLIGATION_RETRY', { obligationId: ob.id, attemptNo: last.attempt_no + 1 });
      return { ok: true, attemptId, operationId };
    });
  }

  // ---- A's original payment, per operation (DESIGN 6.1, STATUS I08) -----------------------------------------

  prepareAPayment(bookingId: string): { ok: true; operationId: string } | Refusal {
    const db = this.#db;
    const now = this.#clock.now();
    return immediate(db, () => {
      const x = aBookingContext(db, bookingId);
      if (!x) return no('BOOKING_NOT_FOUND');
      if (!x.payee) return no('PAYEE_NOT_SET');
      const world = db.prepare('SELECT mode_payment FROM worlds WHERE id = ?').get(x.worldId) as { mode_payment: string };
      if (world.mode_payment !== this.#paypal.mode) return no('MODE_MISMATCH');
      if (db.prepare("SELECT 1 FROM payments WHERE booking_id = ? AND kind = 'A_ORIGINAL'").get(bookingId)) return no('ALREADY_PAID');
      const existing = db
        .prepare("SELECT id FROM a_payment_operations WHERE booking_id = ? AND op_kind = 'ORDER_CREATE' AND status NOT IN ('FAILED', 'NOT_ACCEPTED')")
        .get(bookingId) as { id: string } | undefined;
      if (existing) return { ok: true, operationId: existing.id };
      const last = db.prepare("SELECT * FROM a_payment_operations WHERE booking_id = ? AND op_kind = 'ORDER_CREATE' ORDER BY op_seq DESC LIMIT 1").get(bookingId) as
        | OpRow
        | undefined;
      const seq = (last?.op_seq ?? 0) + 1;
      const input: CreateOrderInput = {
        intent: 'CAPTURE',
        amount: x.amount,
        customId: x.customId,
        invoiceId: `FS-${bookingId}-A-${seq}`,
        returnUrl: this.#returnUrl,
        cancelUrl: this.#cancelUrl,
      };
      // Before the send: request id, fixed input and hash only; the order id is stored from the answer (6.1).
      const op = insertOp(db, { table: A, parentId: bookingId, kind: 'ORDER_CREATE', seq, previousId: last?.id ?? null, target: null, input, built: buildCreateOrder(input), now });
      audit(db, now, { worldId: x.worldId, actor: this.owner, action: 'A_PAYMENT_PREPARED', detail: { bookingId } });
      return { ok: true, operationId: op.id };
    });
  }

  async createAOrder(bookingId: string): Promise<{ ok: true; orderId: string } | Refusal> {
    if (!this.#bookingInMode(bookingId)) return no('MODE_MISMATCH');
    const op = this.#db
      .prepare("SELECT id FROM a_payment_operations WHERE booking_id = ? AND op_kind = 'ORDER_CREATE' ORDER BY op_seq DESC LIMIT 1")
      .get(bookingId) as { id: string } | undefined;
    if (!op) return no('NOT_PREPARED');
    await this.#drive(A, op.id);
    const after = getOp(this.#db, A, op.id)!;
    if (after.status === 'SUCCEEDED' && after.result_external_id) return { ok: true, orderId: after.result_external_id };
    return no(after.status === 'FAILED' || after.status === 'NOT_ACCEPTED' ? 'ORDER_CREATE_FAILED' : 'ORDER_CREATE_UNCONFIRMED');
  }

  /** A approved on PayPal: capture the order, then reconcile with GET capture before A's booking counts as paid. */
  async captureAPayment(bookingId: string): Promise<{ ok: true; paid: boolean } | Refusal> {
    if (!this.#bookingInMode(bookingId)) return no('MODE_MISMATCH');
    const db = this.#db;
    const now = this.#clock.now();
    const r = immediate(db, (): Refusal | { opId: string; leaseGen: number | null } => {
      const create = db
        .prepare("SELECT * FROM a_payment_operations WHERE booking_id = ? AND op_kind = 'ORDER_CREATE' AND status = 'SUCCEEDED'")
        .get(bookingId) as OpRow | undefined;
      if (!create?.result_external_id) return no('ORDER_NOT_CREATED');
      const existing = db
        .prepare("SELECT id FROM a_payment_operations WHERE booking_id = ? AND op_kind = 'ORDER_CAPTURE' AND status NOT IN ('FAILED', 'NOT_ACCEPTED')")
        .get(bookingId) as { id: string } | undefined;
      if (existing) return { opId: existing.id, leaseGen: null };
      const last = db.prepare("SELECT * FROM a_payment_operations WHERE booking_id = ? AND op_kind = 'ORDER_CAPTURE' ORDER BY op_seq DESC LIMIT 1").get(bookingId) as
        | OpRow
        | undefined;
      const orderId = create.result_external_id;
      // The capture targets the stored order id, so the order id is saved before this send (6.1).
      const ins = insertOp(db, {
        table: A, parentId: bookingId, kind: 'ORDER_CAPTURE', seq: (last?.op_seq ?? 0) + 1, previousId: last?.id ?? null, target: orderId,
        input: {}, built: buildCaptureOrder(orderId), now, leaseOwner: this.owner,
      });
      return { opId: ins.id, leaseGen: ins.leaseGen };
    });
    if ('ok' in r) return r;
    if (r.leaseGen !== null) await this.#engine.sendLeased(A, r.opId, r.leaseGen);
    await this.#drive(A, r.opId);
    const paid = !!db.prepare("SELECT 1 FROM payments WHERE booking_id = ? AND kind = 'A_ORIGINAL'").get(bookingId);
    return { ok: true, paid };
  }

  #audit(c: CaseRow, action: string, detail: Record<string, unknown>): void {
    audit(this.#db, this.#clock.now(), { worldId: c.world_id, caseId: c.id, actor: this.owner, action, detail });
  }
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && (error as { code?: unknown }).code === 'ERR_SQLITE_ERROR' && /constraint failed/i.test(error.message);
}
