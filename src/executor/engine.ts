// The operation engine: drives one operation row one step (DESIGN 7, 7.2, 7.3, 7.5).
//   PREPARED            -> first send (after the handler's pre-send checks)
//   SENDING / UNKNOWN   -> recovery: query first where a query can decide, otherwise a same-id resend
//   PENDING             -> poll the resource
//   SUCCEEDED+AWAITING  -> reconciliation query (D20, IP1-04); the POST is never repeated
// Every step holds the row's lease and writes its result only under that lease, forward only. No transaction
// stays open across an await. A hook can stop the process at fixed points (fault-injection tests).

import { immediate, type Db } from '../db/database.ts';
import type { Clock } from '../clock.ts';
import type { SendContext, SendResult } from '../paypal/port.ts';
import { InvalidExternalIdError, type BuiltRequest } from '../paypal/requests.ts';
import { InvalidRequestIdError, ModeMismatchError, RequestHashMismatchError } from '../paypal/rest.ts';
import { effectOf, type Identification, type Reconciliation, type Resource } from './identify.ts';
import {
  MAX_SENDS,
  QUERY_RETRY_MS,
  acquireLease,
  getOp,
  releaseLease,
  retryDelayMs,
  writeUnderLease,
  type Lease,
  type OpPatch,
  type OpRow,
  type OpTable,
} from './ops.ts';

export type CrashPoint =
  /** The operation is committed as SENDING; the POST has not been sent. */
  | 'after-sending-saved'
  /** PayPal answered the POST; nothing about the answer is saved yet. */
  | 'after-send'
  /** The operation's new state is committed (e.g. capture POST success + AWAITING). */
  | 'after-result-saved'
  /** A query (recovery, poll or reconciliation) answered; nothing is saved yet. */
  | 'after-query'
  /** B_CHARGE is settled; the booking commit (E7) has not run. */
  | 'before-e7'
  /** The booking commit (E7) is committed. */
  | 'after-e7';

export interface HookInfo {
  table?: OpTable;
  opId?: string;
  opKind?: string;
  status?: string;
  reconcile?: string | null;
  purpose?: 'recover' | 'poll' | 'reconcile';
  outcome?: string;
  caseId?: string;
}

export interface ExecutorHooks {
  /** Called at each crash point. Throwing here simulates the process stopping at that point. */
  at?(point: CrashPoint, info: HookInfo): void;
}

/** PROGRESSED: the row's state changed. WAITING: nothing due or nothing new. BUSY: another holder has the lease. BLOCKED: held for the owner or not allowed now. */
export type WorkResult = 'PROGRESSED' | 'WAITING' | 'BUSY' | 'BLOCKED';

export type Recovery =
  | { kind: 'RESOLVED'; resource: Resource }
  | { kind: 'RESEND' }
  /** Definitively not processed by PayPal (e.g. authorize of an unapproved order): NOT_ACCEPTED. */
  | { kind: 'NOT_PROCESSED'; reason: string }
  /** Definitively impossible now (e.g. capture of a voided authorization): FAILED. */
  | { kind: 'FAILED'; reason: string }
  | { kind: 'WAIT'; reason: string; attention?: boolean };

export type Poll = { kind: 'RESOURCE'; resource: Resource } | { kind: 'WAIT'; reason: string };

/** Why a first send is not made now. retryAt null = held until the owner acts. */
export interface Block {
  reason: string;
  retryAt: number | null;
  attention: boolean;
}

export interface OpHandler {
  /** True for operations whose POST success must be reconciled by a query before going on (D20). */
  readonly needsReconcile: boolean;
  /** Rebuilds the request from the stored input; its hash must equal the stored one. */
  build(op: OpRow): BuiltRequest;
  send(op: OpRow, ctx: SendContext): Promise<SendResult<Resource>>;
  /** D19: which resource is ours (id, parent, custom_id, amount). */
  identify(op: OpRow, resource: Resource): Identification;
  /** In a transaction: may this row be worked on at all now? */
  mayWork(op: OpRow): boolean;
  /** Same-id resend allowed (DESIGN 6.3 item 8: not for an attempt that already ended). */
  resendAllowed(op: OpRow): boolean;
  /** Outside a transaction, before the first send (e.g. D18: ledger and GET capture). */
  beforeFirstSend?(op: OpRow): Promise<Block | null>;
  /** In the transaction that marks the first send SENDING. */
  checkInTx?(op: OpRow): Block | null;
  recover(op: OpRow): Promise<Recovery>;
  poll(op: OpRow): Promise<Poll>;
  reconcile?(op: OpRow): Promise<Reconciliation>;
  /** Business state written in the same transaction as the operation's new state. */
  followOn(before: OpRow, after: OpRow, resource?: Resource): void;
  /** Something the owner must see. In a transaction. */
  attention(op: OpRow, reason: string): void;
  /** Audit of results that were not adopted. In a transaction. */
  note(op: OpRow, action: string, detail: Record<string, unknown>): void;
}

export interface EngineDeps {
  db: Db;
  clock: Clock;
  owner: string;
  hooks?: ExecutorHooks | undefined;
  handlerFor(table: OpTable, op: OpRow): OpHandler;
  /** DESIGN 10: false when the operation belongs to a world of another payment mode; it is then never worked on. */
  belongs?(table: OpTable, op: OpRow): boolean;
}

const RETRYABLE = new Set(['NETWORK', 'TIMEOUT', 'HTTP_5XX', 'HTTP_429']);
/** Prefix of last_error_class meaning "automatic processing stopped; the owner must act". */
export const HOLD = 'HOLD:';

interface Change {
  patch: OpPatch;
  resource?: Resource;
  attention?: string;
}

export class OpEngine {
  readonly #d: EngineDeps;

  constructor(deps: EngineDeps) {
    this.#d = deps;
  }

  /** One step on one operation. `force` ignores the schedule and holds (startup recovery). */
  async work(table: OpTable, opId: string, opts: { force?: boolean } = {}): Promise<WorkResult> {
    const { db, clock, owner } = this.#d;
    const now = clock.now();
    const got = immediate(db, (): Lease | WorkResult => {
      const op = getOp(db, table, opId);
      if (!op || !isWorkable(op)) return 'WAITING';
      if (this.#d.belongs && !this.#d.belongs(table, op)) return 'BLOCKED';
      if (!opts.force && op.last_error_class?.startsWith(HOLD)) return 'BLOCKED';
      if (!opts.force && op.next_send_at !== null && op.next_send_at > now) return 'WAITING';
      if (!this.#d.handlerFor(table, op).mayWork(op)) return 'BLOCKED';
      return acquireLease(db, table, opId, owner, now) ?? 'BUSY';
    });
    if (typeof got === 'string') return got;
    const h = this.#d.handlerFor(table, got.prev);
    switch (got.prev.status) {
      case 'PREPARED':
        return this.#firstSend(h, got);
      case 'SENDING':
      case 'UNKNOWN':
        return this.#recover(h, got);
      case 'PENDING':
        return this.#poll(h, got);
      default:
        return this.#reconcile(h, got);
    }
  }

  /** Sends an operation that its creator inserted already SENDING under `lease` (DESIGN 6.2 E4). */
  async sendLeased(table: OpTable, opId: string, gen: number): Promise<WorkResult> {
    const op = getOp(this.#d.db, table, opId);
    if (!op) return 'WAITING';
    const lease: Lease = { table, opId, owner: this.#d.owner, gen, prev: op };
    const h = this.#d.handlerFor(table, op);
    if (!this.#hashOk(h, op)) return this.#refuse(h, lease, op, 'HASH_MISMATCH', true);
    this.#hook('after-sending-saved', table, op);
    return this.#sendMarked(h, lease, op);
  }

  // ---- steps -------------------------------------------------------------------

  async #firstSend(h: OpHandler, lease: Lease): Promise<WorkResult> {
    if (!this.#hashOk(h, lease.prev)) return this.#refuse(h, lease, lease.prev, 'HASH_MISMATCH', false);
    const block = h.beforeFirstSend ? await h.beforeFirstSend(lease.prev) : null;
    if (block) return this.#block(h, lease, lease.prev, block);
    return this.#sendNow(h, lease, true);
  }

  async #sendNow(h: OpHandler, lease: Lease, firstSend: boolean): Promise<WorkResult> {
    const { db, clock } = this.#d;
    const op = getOp(db, lease.table, lease.opId)!;
    // DESIGN 7.5 / I13: the stored hash is checked against the stored input and passed on; it is never rebuilt.
    if (!this.#hashOk(h, op)) return this.#refuse(h, lease, op, 'HASH_MISMATCH', false);
    const marked = immediate(db, (): Block | string => {
      if (firstSend && h.checkInTx) {
        const b = h.checkInTx(op);
        if (b) return b;
      }
      return writeUnderLease(db, lease, { status: 'SENDING', sends: op.sends + 1, next_send_at: null }, clock.now(), true);
    });
    if (typeof marked === 'object') return this.#block(h, lease, op, marked);
    if (marked !== 'WRITTEN') return 'BUSY';
    const sending = getOp(db, lease.table, lease.opId)!;
    this.#hook('after-sending-saved', lease.table, sending);
    return this.#sendMarked(h, lease, sending);
  }

  async #sendMarked(h: OpHandler, lease: Lease, op: OpRow): Promise<WorkResult> {
    let result: SendResult<Resource>;
    try {
      result = await h.send(op, { requestId: op.paypal_request_id, expectedRequestHash: op.request_hash, priorUnknownSend: op.prior_unknown === 1 });
    } catch (error) {
      const refusal = refusedBeforeSend(error);
      if (refusal) return this.#refuse(h, lease, op, refusal, true);
      throw error;
    }
    this.#hook('after-send', lease.table, op, { outcome: result.kind });
    return this.#store(h, lease, op, this.#fromSend(h, op, result));
  }

  async #recover(h: OpHandler, lease: Lease): Promise<WorkResult> {
    const { db, clock } = this.#d;
    let op = lease.prev;
    if (op.status === 'SENDING' && op.prior_unknown === 0) {
      // Found SENDING without a live lease: the earlier send may have reached PayPal (DESIGN 7).
      immediate(db, () => writeUnderLease(db, lease, { prior_unknown: 1 }, clock.now(), true));
      op = getOp(db, lease.table, lease.opId)!;
    }
    let decision: Recovery;
    try {
      decision = await h.recover(op);
    } catch (error) {
      const refusal = refusedBeforeSend(error);
      if (!refusal) throw error;
      decision = { kind: 'WAIT', reason: `${HOLD}${refusal}`, attention: true };
    }
    this.#hook('after-query', lease.table, op, { purpose: 'recover', outcome: decision.kind });
    const now = clock.now();
    switch (decision.kind) {
      case 'RESOLVED':
        return this.#store(h, lease, op, this.#fromResource(h, op, decision.resource, now));
      case 'RESEND':
        if (!h.resendAllowed(op)) return this.#store(h, lease, op, { patch: { last_error_class: `${HOLD}RESEND_NOT_ALLOWED`, next_send_at: null }, attention: 'RESEND_NOT_ALLOWED' });
        if (op.sends >= MAX_SENDS) return this.#store(h, lease, op, { patch: { last_error_class: `${HOLD}RETRY_LIMIT`, next_send_at: null }, attention: 'RETRY_LIMIT' });
        return this.#sendNow(h, lease, false);
      case 'NOT_PROCESSED':
        return this.#store(h, lease, op, { patch: { status: 'NOT_ACCEPTED', last_error_class: decision.reason, next_send_at: null } });
      case 'FAILED':
        return this.#store(h, lease, op, { patch: { status: 'FAILED', last_error_class: decision.reason, next_send_at: null }, attention: decision.reason });
      case 'WAIT': {
        const held = decision.reason.startsWith(HOLD);
        return this.#store(h, lease, op, {
          patch: { last_error_class: decision.reason, next_send_at: held ? null : now + QUERY_RETRY_MS },
          ...(decision.attention ? { attention: decision.reason } : {}),
        });
      }
    }
  }

  async #poll(h: OpHandler, lease: Lease): Promise<WorkResult> {
    const op = lease.prev;
    const p = await h.poll(op);
    this.#hook('after-query', lease.table, op, { purpose: 'poll', outcome: p.kind });
    const now = this.#d.clock.now();
    if (p.kind === 'WAIT') return this.#store(h, lease, op, { patch: { last_error_class: p.reason, next_send_at: now + QUERY_RETRY_MS } });
    return this.#store(h, lease, op, this.#fromResource(h, op, p.resource, now));
  }

  async #reconcile(h: OpHandler, lease: Lease): Promise<WorkResult> {
    const op = lease.prev;
    if (!h.reconcile) return this.#store(h, lease, op, { patch: { last_error_class: `${HOLD}NO_RECONCILER`, next_send_at: null }, attention: 'NO_RECONCILER' });
    const r = await h.reconcile(op);
    this.#hook('after-query', lease.table, op, { purpose: 'reconcile', outcome: r.kind });
    const now = this.#d.clock.now();
    switch (r.kind) {
      case 'MATCHED':
        return this.#store(h, lease, op, {
          patch: {
            reconcile_status: 'MATCHED',
            reconciled_at: now,
            external_status: r.status,
            ...(r.updateTime ? { external_update_time: r.updateTime } : {}),
            last_error_class: null,
            next_send_at: null,
          },
        });
      case 'WAIT':
        return this.#store(h, lease, op, { patch: { last_error_class: r.reason, next_send_at: now + QUERY_RETRY_MS } });
      case 'MISMATCH': {
        const reason = `MISMATCH:${r.fields.join(',')}`;
        return this.#store(h, lease, op, { patch: { last_error_class: reason, next_send_at: now + QUERY_RETRY_MS }, attention: reason });
      }
      case 'STOP':
        return this.#store(h, lease, op, { patch: { last_error_class: `${HOLD}${r.reason}`, next_send_at: null }, attention: r.reason });
    }
  }

  // ---- interpreting answers ----------------------------------------------------

  #fromSend(h: OpHandler, op: OpRow, result: SendResult<Resource>): Change {
    const now = this.#d.clock.now();
    switch (result.kind) {
      case 'SUCCEEDED':
      case 'PENDING':
      case 'FAILED':
        return this.#fromResource(h, op, result.resource, now);
      case 'UNKNOWN': {
        // A replay may return the original answer or the current state (D19): identify, then judge the state.
        if (result.resource) return this.#fromResource(h, op, result.resource, now);
        const retryable = RETRYABLE.has(result.reason);
        const next = retryable && op.sends < MAX_SENDS ? now + retryDelayMs(op.sends) : now + QUERY_RETRY_MS;
        return { patch: { status: 'UNKNOWN', prior_unknown: 1, last_error_class: result.reason, next_send_at: next } };
      }
      case 'NOT_ACCEPTED':
        return { patch: { status: 'NOT_ACCEPTED', last_error_class: `NOT_ACCEPTED:${result.error.issues.join('|') || result.httpStatus}`, next_send_at: null } };
      case 'AUTH_ERROR':
        // Not processed, but the operation is not finished: fix the credentials, resend with the same id. A
        // previous UNKNOWN stays recorded (prior_unknown is not cleared, I12).
        return { patch: { status: 'UNKNOWN', last_error_class: 'AUTH_ERROR', next_send_at: now + QUERY_RETRY_MS } };
      case 'NOT_SENT':
        // Only "this send did not happen" (I09): earlier unknown sends stay unknown.
        return { patch: { status: 'UNKNOWN', sends: op.sends - 1, last_error_class: `NOT_SENT:${result.reason}`, next_send_at: now + retryDelayMs(Math.max(1, op.sends - 1)) } };
    }
  }

  #fromResource(h: OpHandler, op: OpRow, resource: Resource, now: number): Change {
    const keepPending = op.status === 'PENDING';
    const id = h.identify(op, resource);
    if (!id.ok) {
      return {
        patch: { ...(keepPending ? {} : { status: 'UNKNOWN' as const }), prior_unknown: 1, last_error_class: `UNIDENTIFIED:${id.reason}`, next_send_at: now + QUERY_RETRY_MS },
        attention: `UNIDENTIFIED:${id.reason}`,
      };
    }
    const f = id.found;
    const common: OpPatch = {
      result_external_id: f.id,
      external_status: f.status,
      ...(f.updateTime ? { external_update_time: f.updateTime } : {}),
      ...(f.amountMinor !== undefined ? { result_amount_minor: f.amountMinor } : {}),
      ...(f.totalRefundedMinor !== undefined ? { observed_total_refunded_minor: f.totalRefundedMinor } : {}),
    };
    switch (effectOf(op.op_kind, f.status)) {
      case 'SUCCEEDED':
        return {
          patch: { ...common, status: 'SUCCEEDED', ...(h.needsReconcile ? { reconcile_status: 'AWAITING' as const } : {}), last_error_class: null, next_send_at: null },
          resource,
        };
      case 'PENDING':
        return { patch: { ...common, status: 'PENDING', last_error_class: null, next_send_at: now + QUERY_RETRY_MS }, resource };
      case 'FAILED':
        return { patch: { ...common, status: 'FAILED', last_error_class: `EXTERNAL_${f.status}`, next_send_at: null }, resource };
      case 'UNKNOWN':
        return {
          patch: { ...common, ...(keepPending ? {} : { status: 'UNKNOWN' as const }), prior_unknown: 1, last_error_class: `UNEXPECTED_STATUS:${f.status}`, next_send_at: now + QUERY_RETRY_MS },
          resource,
        };
    }
  }

  // ---- writing -----------------------------------------------------------------

  #store(h: OpHandler, lease: Lease, before: OpRow, change: Change): WorkResult {
    const { db, clock } = this.#d;
    const now = clock.now();
    const out = immediate(db, () => {
      const w = writeUnderLease(db, lease, change.patch, now);
      if (w === 'WRITTEN') {
        const after = getOp(db, lease.table, lease.opId)!;
        h.followOn(before, after, change.resource);
        if (change.attention && before.last_error_class !== after.last_error_class) h.attention(after, change.attention);
        return { after };
      }
      // DESIGN 7.2: a result under a lost lease, or one that would move the row backwards, is not adopted.
      if (w === 'REGRESSION') releaseLease(db, lease, now, now + QUERY_RETRY_MS);
      h.note(before, w === 'LEASE_LOST' ? 'STALE_RESULT_IGNORED' : 'REGRESSION_REFUSED', { status: change.patch.status ?? null, leaseGen: lease.gen });
      return null;
    });
    if (!out) return 'BUSY';
    this.#hook('after-result-saved', lease.table, out.after);
    const a = out.after;
    const changed = a.status !== before.status || a.reconcile_status !== before.reconcile_status || a.result_external_id !== before.result_external_id;
    return changed ? 'PROGRESSED' : 'WAITING';
  }

  #block(h: OpHandler, lease: Lease, op: OpRow, b: Block): WorkResult {
    const patch: OpPatch = { last_error_class: b.retryAt === null ? `${HOLD}${b.reason}` : b.reason, next_send_at: b.retryAt };
    this.#store(h, lease, op, { patch, ...(b.attention ? { attention: b.reason } : {}) });
    return 'BLOCKED';
  }

  /** Refused before sending (hash mismatch, mode mismatch): nothing was sent; held for the owner. */
  #refuse(h: OpHandler, lease: Lease, op: OpRow, reason: string, undoSend: boolean): WorkResult {
    const patch: OpPatch = {
      ...(op.status === 'SENDING' ? { status: 'UNKNOWN' as const } : {}),
      ...(undoSend && op.status === 'SENDING' ? { sends: Math.max(0, op.sends - 1) } : {}),
      last_error_class: `${HOLD}${reason}`,
      next_send_at: null,
    };
    this.#store(h, lease, op, { patch, attention: reason });
    return 'BLOCKED';
  }

  #hashOk(h: OpHandler, op: OpRow): boolean {
    try {
      return h.build(op).hash === op.request_hash;
    } catch {
      return false;
    }
  }

  #hook(point: CrashPoint, table: OpTable, op: OpRow, extra: Partial<HookInfo> = {}): void {
    this.#d.hooks?.at?.(point, { table, opId: op.id, opKind: op.op_kind, status: op.status, reconcile: op.reconcile_status, ...extra });
  }
}

export function isWorkable(op: OpRow): boolean {
  return op.status === 'PREPARED' || op.status === 'SENDING' || op.status === 'UNKNOWN' || op.status === 'PENDING' || (op.status === 'SUCCEEDED' && op.reconcile_status === 'AWAITING');
}

function refusedBeforeSend(error: unknown): string | null {
  if (error instanceof RequestHashMismatchError) return 'HASH_MISMATCH';
  if (error instanceof ModeMismatchError) return 'MODE_MISMATCH';
  if (error instanceof InvalidExternalIdError) return 'INVALID_EXTERNAL_ID';
  if (error instanceof InvalidRequestIdError) return 'INVALID_REQUEST_ID';
  return null;
}
