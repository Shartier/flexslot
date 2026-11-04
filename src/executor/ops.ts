// Operation rows, leases and guarded result writes (DESIGN 7.1, 7.2). Every function here runs inside a
// transaction opened by the caller (immediate()); none of them awaits.

import type { Db } from '../db/database.ts';

export type OpTable = 'payment_operations' | 'a_payment_operations';
export type OpStatus = 'PREPARED' | 'SENDING' | 'UNKNOWN' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'NOT_ACCEPTED';

export interface OpRow {
  id: string;
  /** payment_operations only. */
  attempt_id?: string;
  /** a_payment_operations only. */
  booking_id?: string;
  op_kind: string;
  op_seq: number;
  previous_operation_id: string | null;
  target_external_id: string | null;
  paypal_request_id: string;
  request_hash: string;
  request_json: string;
  status: OpStatus;
  result_external_id: string | null;
  external_status: string | null;
  external_update_time: string | null;
  reconcile_status: 'AWAITING' | 'MATCHED' | null;
  reconciled_at: number | null;
  result_amount_minor: number | null;
  observed_total_refunded_minor: number | null;
  lease_owner: string | null;
  lease_gen: number;
  lease_until: number | null;
  sends: number;
  prior_unknown: number;
  next_send_at: number | null;
  last_error_class: string | null;
  created_at: number;
  updated_at: number;
}

/** DESIGN 7.2: one PayPal call times out at 20 s, a lease lasts 60 s. */
export const LEASE_MS = 60_000;
/** DESIGN 7: resend on network errors, 5xx and 429, 2 s doubling, at most 6 resends (7 sends in all). */
export const MAX_SENDS = 7;
export const FIRST_RETRY_MS = 2_000;
/** Interval for queries (PENDING, reconciliation, recovery) after a miss. */
export const QUERY_RETRY_MS = 10_000;

/** Delay before the next resend, after `sendsSoFar` sends ended unknown: 2, 4, 8, 16, 32, 64 s. */
export function retryDelayMs(sendsSoFar: number): number {
  return FIRST_RETRY_MS * 2 ** Math.max(0, sendsSoFar - 1);
}

const RANK: Readonly<Record<OpStatus, number>> = {
  PREPARED: 0,
  SENDING: 1,
  UNKNOWN: 1,
  PENDING: 2,
  SUCCEEDED: 3,
  FAILED: 3,
  NOT_ACCEPTED: 3,
};

export const FINAL_STATUSES: ReadonlySet<OpStatus> = new Set(['SUCCEEDED', 'FAILED', 'NOT_ACCEPTED']);
export const UNCONFIRMED: ReadonlySet<OpStatus> = new Set(['PREPARED', 'SENDING', 'UNKNOWN', 'PENDING']);

/** DESIGN 7.2: an operation never moves back (final stays final; PENDING never returns to SENDING/UNKNOWN). */
export function canMove(from: OpStatus, to: OpStatus): boolean {
  if (FINAL_STATUSES.has(from)) return from === to;
  return RANK[to] >= RANK[from];
}

export function getOp(db: Db, table: OpTable, id: string): OpRow | undefined {
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as OpRow | undefined;
}

/** States in which an operation still has work: send, recover, poll, or reconcile (D20). */
export const WORKABLE_SQL = `(status IN ('PREPARED', 'SENDING', 'UNKNOWN', 'PENDING') OR (status = 'SUCCEEDED' AND reconcile_status = 'AWAITING'))`;

export interface Lease {
  table: OpTable;
  opId: string;
  owner: string;
  gen: number;
  /** The row as it was when the lease was taken. */
  prev: OpRow;
}

/**
 * DESIGN 7.2: takes the lease on a workable operation whose lease is free or expired. Returns null if someone
 * else holds it. The new generation number is what every later write must present.
 */
export function acquireLease(db: Db, table: OpTable, id: string, owner: string, now: number): Lease | null {
  const prev = getOp(db, table, id);
  if (!prev) return null;
  const r = db
    .prepare(
      `UPDATE ${table} SET lease_owner = ?, lease_gen = lease_gen + 1, lease_until = ?, updated_at = ?
       WHERE id = ? AND (lease_until IS NULL OR lease_until < ?) AND ${WORKABLE_SQL}`,
    )
    .run(owner, now + LEASE_MS, now, id, now);
  if (r.changes !== 1) return null;
  return { table, opId: id, owner, gen: prev.lease_gen + 1, prev };
}

export interface OpPatch {
  status?: OpStatus;
  result_external_id?: string | null;
  external_status?: string | null;
  external_update_time?: string | null;
  reconcile_status?: 'AWAITING' | 'MATCHED' | null;
  reconciled_at?: number | null;
  result_amount_minor?: number | null;
  observed_total_refunded_minor?: number | null;
  sends?: number;
  prior_unknown?: 0 | 1;
  next_send_at?: number | null;
  last_error_class?: string | null;
}

export type WriteOutcome = 'WRITTEN' | 'LEASE_LOST' | 'REGRESSION';

/**
 * DESIGN 7.2: writes a result only under the caller's lease (owner and generation) and only forward: the
 * status rank never drops, and an external update_time older than the stored one is not adopted.
 * `keepLease` keeps the lease for a follow-up step (e.g. SENDING before the POST); otherwise it is released.
 */
export function writeUnderLease(db: Db, lease: Lease, patch: OpPatch, now: number, keepLease = false): WriteOutcome {
  const cur = getOp(db, lease.table, lease.opId);
  if (!cur || cur.lease_owner !== lease.owner || cur.lease_gen !== lease.gen) return 'LEASE_LOST';
  if (patch.status !== undefined && !canMove(cur.status, patch.status)) return 'REGRESSION';
  if (cur.reconcile_status === 'MATCHED' && patch.reconcile_status !== undefined && patch.reconcile_status !== 'MATCHED') return 'REGRESSION';
  if (isOlder(patch.external_update_time, cur.external_update_time)) return 'REGRESSION';
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  const sets = [...fields.map(([k]) => `${k} = ?`), 'updated_at = ?'];
  if (!keepLease) sets.push('lease_until = NULL');
  const r = db
    .prepare(`UPDATE ${lease.table} SET ${sets.join(', ')} WHERE id = ? AND lease_owner = ? AND lease_gen = ?`)
    .run(...fields.map(([, v]) => v as string | number | null), now, lease.opId, lease.owner, lease.gen);
  return r.changes === 1 ? 'WRITTEN' : 'LEASE_LOST';
}

/** Releases the lease without changing the result (e.g. a refused or stale result); schedules the next try. */
export function releaseLease(db: Db, lease: Lease, now: number, nextSendAt: number | null): boolean {
  const r = db
    .prepare(`UPDATE ${lease.table} SET lease_until = NULL, next_send_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND lease_gen = ?`)
    .run(nextSendAt, now, lease.opId, lease.owner, lease.gen);
  return r.changes === 1;
}

function isOlder(incoming: string | null | undefined, stored: string | null): boolean {
  if (!incoming || !stored) return false;
  const a = Date.parse(incoming);
  const b = Date.parse(stored);
  return Number.isFinite(a) && Number.isFinite(b) && a < b;
}
