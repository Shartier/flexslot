// Small SQL helpers for cases, attempts, obligations, operations and the audit log. Callers own the
// transaction. State changes are conditional updates (DESIGN 7.2); a 0-row update means "not in that state".

import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.ts';
import type { BuiltRequest } from '../paypal/requests.ts';
import type { CaseRow } from './terms.ts';
import { LEASE_MS, type OpRow, type OpStatus, type OpTable } from './ops.ts';

export interface AttemptRow {
  id: string;
  obligation_id: string;
  attempt_no: number;
  previous_attempt_id: string | null;
  case_version: number;
  terms_hash: string;
  expires_at: number | null;
  status: string;
}

export interface ObligationRow {
  id: string;
  case_id: string;
  kind: 'B_CHARGE' | 'B_AUTH_VOID' | 'A_COMPENSATION_REFUND' | 'B_RECOVERY_REFUND';
  amount_minor: number;
  currency: string;
  target_external_id: string | null;
  status: 'OPEN' | 'SETTLED' | 'NEEDS_ATTENTION' | 'CANCELLED';
  settled_by_operation_id: string | null;
}

export const UNFINISHED_ATTEMPT: ReadonlySet<string> = new Set(['OPEN', 'ORDER_CREATED', 'AUTHORIZED']);
/** Case statuses of the capture step (E6), shown differently while the capture is unknown/pending/reconciling. */
export const CAPTURE_PHASE = ['CAPTURING', 'PAYMENT_PENDING', 'RECONCILING', 'PAYMENT_UNKNOWN'] as const;

export const newId = () => randomUUID();

export function getCase(db: Db, id: string): CaseRow | undefined {
  return db.prepare('SELECT * FROM swap_cases WHERE id = ?').get(id) as CaseRow | undefined;
}

export function getAttempt(db: Db, id: string): AttemptRow {
  return db.prepare('SELECT * FROM payment_attempts WHERE id = ?').get(id) as unknown as AttemptRow;
}

export function getObligation(db: Db, id: string): ObligationRow {
  return db.prepare('SELECT * FROM money_obligations WHERE id = ?').get(id) as unknown as ObligationRow;
}

export function obligationOf(db: Db, caseId: string, kind: ObligationRow['kind']): ObligationRow | undefined {
  return db.prepare('SELECT * FROM money_obligations WHERE case_id = ? AND kind = ?').get(caseId, kind) as ObligationRow | undefined;
}

export function latestAttempt(db: Db, obligationId: string): AttemptRow | undefined {
  return db.prepare('SELECT * FROM payment_attempts WHERE obligation_id = ? ORDER BY attempt_no DESC LIMIT 1').get(obligationId) as
    | AttemptRow
    | undefined;
}

export function latestOp(db: Db, attemptId: string, kind?: string): OpRow | undefined {
  return (
    kind
      ? db.prepare('SELECT * FROM payment_operations WHERE attempt_id = ? AND op_kind = ? ORDER BY rowid DESC LIMIT 1').get(attemptId, kind)
      : db.prepare('SELECT * FROM payment_operations WHERE attempt_id = ? ORDER BY rowid DESC LIMIT 1').get(attemptId)
  ) as OpRow | undefined;
}

export function succeededOp(db: Db, attemptId: string, kind: string): OpRow | undefined {
  return db.prepare("SELECT * FROM payment_operations WHERE attempt_id = ? AND op_kind = ? AND status = 'SUCCEEDED'").get(attemptId, kind) as
    | OpRow
    | undefined;
}

/** Conditional case update: only from one of `from`, and only for the same terms version. */
export function setCase(db: Db, c: Pick<CaseRow, 'id' | 'version'>, from: readonly string[], to: string): boolean {
  const r = db
    .prepare(`UPDATE swap_cases SET status = ? WHERE id = ? AND version = ? AND status IN (${from.map(() => '?').join(', ')})`)
    .run(to, c.id, c.version, ...from);
  return r.changes === 1;
}

export function setAttempt(db: Db, id: string, from: readonly string[], to: string): boolean {
  const r = db.prepare(`UPDATE payment_attempts SET status = ? WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`).run(to, id, ...from);
  return r.changes === 1;
}

export function settleObligation(db: Db, obligationId: string, operationId: string): boolean {
  const r = db
    .prepare("UPDATE money_obligations SET status = 'SETTLED', settled_by_operation_id = ? WHERE id = ? AND status IN ('OPEN', 'NEEDS_ATTENTION')")
    .run(operationId, obligationId);
  return r.changes === 1;
}

export function setObligation(db: Db, id: string, from: readonly string[], to: ObligationRow['status']): boolean {
  const r = db.prepare(`UPDATE money_obligations SET status = ? WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`).run(to, id, ...from);
  return r.changes === 1;
}

export function releaseHolds(db: Db, caseId: string): void {
  db.prepare("UPDATE slot_holds SET status = 'RELEASED' WHERE case_id = ? AND status IN ('ACTIVE', 'FROZEN')").run(caseId);
}

/** Audit entries never contain credentials, tokens or request ids (DESIGN 3). */
export function audit(db: Db, now: number, e: { worldId?: string | null; caseId?: string | null; actor: string; action: string; detail?: Record<string, unknown> }): void {
  db.prepare('INSERT INTO audit_log (world_id, case_id, actor, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    e.worldId ?? null,
    e.caseId ?? null,
    e.actor,
    e.action,
    JSON.stringify(e.detail ?? {}),
    now,
  );
}

export interface NewOp {
  table: OpTable;
  /** attempt_id (payment_operations) or booking_id (a_payment_operations). */
  parentId: string;
  kind: string;
  seq?: number;
  previousId?: string | null;
  target: string | null;
  /** Fixed input the hash was computed from (stored as request_json, never rebuilt). */
  input: unknown;
  built: BuiltRequest;
  now: number;
  /** Create the row already SENDING under a lease held by `leaseOwner` (DESIGN 6.2 E4). */
  leaseOwner?: string;
}

/** Inserts an operation row with a new PayPal-Request-Id and the stored hash (DESIGN 7: write before calling). */
export function insertOp(db: Db, o: NewOp): { id: string; leaseGen: number } {
  const id = newId();
  const parentCol = o.table === 'payment_operations' ? 'attempt_id' : 'booking_id';
  const status: OpStatus = o.leaseOwner ? 'SENDING' : 'PREPARED';
  db.prepare(
    `INSERT INTO ${o.table} (id, ${parentCol}, op_kind, op_seq, previous_operation_id, target_external_id, paypal_request_id,
       request_hash, request_json, status, sends, lease_owner, lease_gen, lease_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, o.parentId, o.kind, o.seq ?? 1, o.previousId ?? null, o.target, newId(), o.built.hash, JSON.stringify(o.input ?? {}), status,
    o.leaseOwner ? 1 : 0, o.leaseOwner ?? null, o.leaseOwner ? 1 : 0, o.leaseOwner ? o.now + LEASE_MS : null, o.now, o.now,
  );
  return { id, leaseGen: o.leaseOwner ? 1 : 0 };
}

export function insertObligation(
  db: Db,
  o: { caseId: string; kind: ObligationRow['kind']; amountMinor: number; currency: string; target: string | null },
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO money_obligations (id, case_id, kind, amount_minor, currency, target_external_id, status) VALUES (?, ?, ?, ?, ?, ?, 'OPEN')`,
  ).run(id, o.caseId, o.kind, o.amountMinor, o.currency, o.target);
  return id;
}

export function insertAttempt(
  db: Db,
  a: { obligationId: string; attemptNo: number; previousId: string | null; caseVersion: number; termsHash: string; expiresAt: number | null },
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO payment_attempts (id, obligation_id, attempt_no, previous_attempt_id, case_version, terms_hash, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
  ).run(id, a.obligationId, a.attemptNo, a.previousId, a.caseVersion, a.termsHash, a.expiresAt);
  return id;
}

/** custom_id of B's checkout attempt: case, terms version and attempt (DESIGN 6.2 E2, 6.3 item 1). */
export const bCustomId = (caseId: string, version: number, attemptId: string) => `case:${caseId}:v${version}:att:${attemptId}`;
/** custom_id of A's original payment. */
export const aCustomId = (bookingId: string) => `booking:${bookingId}:a`;
