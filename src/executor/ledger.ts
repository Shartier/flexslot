// Refundable amount as a value managed from FlexSlot's own records (DESIGN 7.1, D18).
// It is not "PayPal's latest refundable amount": GET capture has no refunded total (STATUS F3), so FlexSlot
// counts its own confirmed refunds, refuses to send while one is unconfirmed, and stops on any inconsistency.
// MVP premise: refunds of these Sandbox captures are made only through FlexSlot's obligations.

import type { Db } from '../db/database.ts';
import type { Capture } from '../paypal/schemas.ts';
import { amountEquals } from '../paypal/money.ts';
import type { OpRow } from './ops.ts';

export interface RefundLedger {
  captureId: string;
  captureMinor: number;
  /** Sum of confirmed COMPLETED refunds, each refund id counted once. */
  confirmedMinor: number;
  remainingMinor: number;
  refundIds: string[];
  /** Refund operations on this capture that were (or may have been) sent and are not confirmed. */
  unconfirmedOpIds: string[];
  /** Reasons the records cannot be trusted; any entry stops automatic sending. */
  problems: string[];
}

/** Ledger of one capture from the CAPTURE_REFUND operations that target it. `excludeOpId`: the op about to be sent. */
export function refundLedger(db: Db, captureId: string, captureMinor: number, excludeOpId?: string): RefundLedger {
  const ops = db
    .prepare("SELECT * FROM payment_operations WHERE op_kind = 'CAPTURE_REFUND' AND target_external_id = ? ORDER BY rowid")
    .all(captureId) as unknown as OpRow[];
  const amounts = new Map<string, number>();
  const unconfirmed: string[] = [];
  const problems: string[] = [];
  let lastConfirmed: OpRow | undefined;
  for (const op of ops) {
    if (op.id === excludeOpId) continue;
    // PREPARED rows of other operations were never sent; SENDING/UNKNOWN/PENDING may have moved money.
    if (op.status === 'SENDING' || op.status === 'UNKNOWN' || op.status === 'PENDING') unconfirmed.push(op.id);
    if (op.status !== 'SUCCEEDED') continue;
    if (!op.result_external_id || op.result_amount_minor === null) {
      problems.push('RECORD_MISSING');
      continue;
    }
    const seen = amounts.get(op.result_external_id);
    if (seen !== undefined && seen !== op.result_amount_minor) problems.push('REFUND_ID_CONFLICT');
    amounts.set(op.result_external_id, op.result_amount_minor);
    if (!lastConfirmed || op.updated_at >= lastConfirmed.updated_at) lastConfirmed = op;
  }
  const confirmedMinor = [...amounts.values()].reduce((s, v) => s + v, 0);
  if (confirmedMinor > captureMinor) problems.push('OVER_REFUNDED');
  // Refunds of one capture are serialized, so the latest confirmed refund's reported total covers them all.
  if (lastConfirmed && lastConfirmed.observed_total_refunded_minor !== null && lastConfirmed.observed_total_refunded_minor !== confirmedMinor) {
    problems.push('TOTAL_MISMATCH');
  }
  return {
    captureId,
    captureMinor,
    confirmedMinor,
    remainingMinor: captureMinor - confirmedMinor,
    refundIds: [...amounts.keys()],
    unconfirmedOpIds: unconfirmed,
    problems: [...new Set(problems)],
  };
}

/**
 * Cross-check with GET capture before a first refund send: the amount must be the one FlexSlot recorded and
 * the status must agree with the confirmed refunds (otherwise a refund outside FlexSlot is suspected).
 */
export function captureStateProblems(ledger: RefundLedger, capture: Capture, currency: string): string[] {
  const problems: string[] = [];
  if (capture.id !== ledger.captureId) problems.push('CAPTURE_ID');
  if (!amountEquals(capture.amount, { currency, minor: ledger.captureMinor })) problems.push('CAPTURE_AMOUNT');
  const expected =
    ledger.confirmedMinor === 0 ? 'COMPLETED' : ledger.confirmedMinor >= ledger.captureMinor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  if (capture.status !== expected) problems.push(`CAPTURE_STATUS_${capture.status}`);
  return problems;
}
