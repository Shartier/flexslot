// AC09: A's compensation refund (E8) and the refundable amount managed from FlexSlot's records (D18).
// PENDING and FAILED refunds, a new attempt only after a confirmed failure, no send while a refund is
// unconfirmed or the records disagree, and compensation exactly once. Mock only.

import { describe, expect, it } from 'vitest';
import { immediate } from '../src/db/database.ts';
import { captureStateProblems, refundLedger } from '../src/executor/ledger.ts';
import { getOp } from '../src/executor/ops.ts';
import { insertAttempt, insertObligation, insertOp } from '../src/executor/store.ts';
import { buildRefundCapture } from '../src/paypal/requests.ts';
import { randomUUID } from 'node:crypto';
import { insertCase, insertOperation } from './helpers.ts';
import { SimulatedCrash, audits, caseStatus, crashAt, expectCompletedSwap, gets, obligation, opsOf, posts, swapWorld, toAuthorized } from './executor-helpers.ts';

async function atRefund() {
  const w = await swapWorld();
  const ex = w.exec({ hooks: crashAt('after-e7') });
  await toAuthorized(w, ex);
  await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
  return { w, ex: w.exec({ owner: 'exec-r' }) };
}

const refundOb = (w: Awaited<ReturnType<typeof swapWorld>>) => obligation(w, 'A_COMPENSATION_REFUND')!;
const ledgerOfA = (w: Awaited<ReturnType<typeof swapWorld>>) => refundLedger(w.db, w.aCaptureId, 6000);

describe('AC09: PENDING and unknown refunds', () => {
  it('a PENDING refund is only polled; no new attempt while it is open; it settles once COMPLETED', async () => {
    const { w, ex } = await atRefund();
    w.server.inject('CAPTURE_REFUND', { type: 'PENDING' });
    expect(await ex.advance(w.caseId)).toBe('REFUND_PENDING');
    const op = opsOf(w, 'CAPTURE_REFUND')[0]!;
    expect(op).toMatchObject({ status: 'PENDING', external_status: 'PENDING' });
    expect(refundOb(w).status).toBe('OPEN');
    expect(ex.retryObligation(refundOb(w).id)).toEqual({ ok: false, reason: 'ATTEMPT_UNFINISHED' });

    w.clock.advance(10_000);
    await ex.processDue();
    expect(gets(w, 'REFUND_GET')).toHaveLength(1);
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(1);
    w.server.settle(op.result_external_id!, 'COMPLETED');
    w.clock.advance(10_000);
    await ex.processDue();
    expectCompletedSwap(w, expect);
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(1);
  });

  it('an unknown refund (answer lost) is recovered with the same id, never with a new attempt', async () => {
    const { w, ex } = await atRefund();
    w.server.inject('CAPTURE_REFUND', { type: 'RESPONSE_LOST' });
    expect(await ex.advance(w.caseId)).toBe('REFUND_PENDING');
    expect(ex.retryObligation(refundOb(w).id)).toEqual({ ok: false, reason: 'ATTEMPT_UNFINISHED' });
    w.clock.advance(2_000);
    await ex.processDue();
    expect(w.server.count('refunds')).toBe(1);
    expect(posts(w, 'CAPTURE_REFUND')[1]!.requestId).toBe(posts(w, 'CAPTURE_REFUND')[0]!.requestId);
    expectCompletedSwap(w, expect);
  });
});

describe('AC09: a new attempt only after a confirmed failure', () => {
  it.each([
    ['FAILED (PayPal reports the refund FAILED)', { type: 'REFUND_FAILED' as const }, 'FAILED'],
    ['NOT_ACCEPTED (first send rejected with 422)', { type: 'HTTP_ERROR' as const, status: 422 }, 'NOT_ACCEPTED'],
  ])('%s: held for the owner, then the owner retry pays exactly 10.00', async (_label, fault, opStatus) => {
    const { w, ex } = await atRefund();
    w.server.inject('CAPTURE_REFUND', fault);
    expect(await ex.advance(w.caseId)).toBe('REFUND_FAILED');
    const first = opsOf(w, 'CAPTURE_REFUND')[0]!;
    expect(first.status).toBe(opStatus);
    expect(refundOb(w).status).toBe('NEEDS_ATTENTION');
    w.clock.advance(120_000);
    await ex.processDue();
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(1); // nothing automatic after a definitive failure

    const retry = ex.retryObligation(refundOb(w).id);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const attempts = w.db.prepare('SELECT id, attempt_no, previous_attempt_id, status FROM payment_attempts WHERE obligation_id = ? ORDER BY attempt_no').all(refundOb(w).id) as Array<{ id: string; attempt_no: number; previous_attempt_id: string | null; status: string }>;
    expect(attempts.map((a) => [a.attempt_no, a.status])).toEqual([[1, 'FAILED'], [2, 'OPEN']]);
    expect(attempts[1]!.previous_attempt_id).toBe(attempts[0]!.id);
    expect(caseStatus(w)).toBe('REFUND_PENDING');

    await ex.advance(w.caseId);
    expectCompletedSwap(w, expect, { refundsAtPayPal: opStatus === 'FAILED' ? 2 : 1 });
    const sends = posts(w, 'CAPTURE_REFUND');
    expect(sends).toHaveLength(2);
    expect(sends[0]!.requestId).not.toBe(sends[1]!.requestId);
    expect(ledgerOfA(w)).toMatchObject({ confirmedMinor: 1000, remainingMinor: 5000, problems: [] });
    // Compensation once: settled obligations cannot be retried; a second grant or obligation is refused.
    expect(ex.retryObligation(refundOb(w).id)).toEqual({ ok: false, reason: 'ALREADY_SETTLED' });
    expect(w.db.prepare('SELECT count(*) AS n FROM compensation_grants').get()).toEqual({ n: 1 });
    expect(() => insertObligation(w.db, { caseId: w.caseId, kind: 'A_COMPENSATION_REFUND', amountMinor: 1000, currency: 'USD', target: w.aCaptureId })).toThrow(/UNIQUE/);
  });

  it('refuses a retry of B_CHARGE (a new checkout needs a new case)', async () => {
    const { w, ex } = await atRefund();
    expect(ex.retryObligation(obligation(w, 'B_CHARGE')!.id)).toEqual({ ok: false, reason: 'NOT_RETRYABLE' });
  });
});

describe('D18: no refund while another is unconfirmed or while the records disagree', () => {
  it('a refund of the same capture waits while another refund of it is PENDING, then goes within the remainder', async () => {
    const { w, ex } = await atRefund();
    w.server.inject('CAPTURE_REFUND', { type: 'PENDING' });
    await ex.advance(w.caseId);
    const pending = opsOf(w, 'CAPTURE_REFUND')[0]!;
    // A second obligation on the same capture (another, already finished case) with a PREPARED refund.
    insertCase(w.db, w.ids, { id: 'C2', status: 'COMPLETED' });
    const second = immediate(w.db, () => {
      const ob = insertObligation(w.db, { caseId: 'C2', kind: 'A_COMPENSATION_REFUND', amountMinor: 500, currency: 'USD', target: w.aCaptureId });
      const att = insertAttempt(w.db, { obligationId: ob, attemptNo: 1, previousId: null, caseVersion: 1, termsHash: 'a'.repeat(64), expiresAt: null });
      const input = { amount: { currency: 'USD', minor: 500 } };
      return insertOp(w.db, { table: 'payment_operations', parentId: att, kind: 'CAPTURE_REFUND', target: w.aCaptureId, input, built: buildRefundCapture(w.aCaptureId, input), now: w.clock.now() }).id;
    });
    await ex.processDue();
    expect(getOp(w.db, 'payment_operations', second)).toMatchObject({ status: 'PREPARED', last_error_class: 'REFUND_IN_FLIGHT' });
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(1);

    w.server.settle(pending.result_external_id!, 'COMPLETED');
    w.clock.advance(10_000);
    await ex.processDue();
    expect(caseStatus(w)).toBe('COMPLETED');
    expect(getOp(w.db, 'payment_operations', second)!.status).toBe('SUCCEEDED');
    expect(ledgerOfA(w)).toMatchObject({ confirmedMinor: 1500, remainingMinor: 4500, problems: [] });
  });

  it('a refund made outside FlexSlot makes GET capture disagree: nothing is sent and the owner is told', async () => {
    const { w, ex } = await atRefund();
    await w.paypal.refundCapture(w.aCaptureId, { amount: { currency: 'USD', minor: 500 } }, { requestId: randomUUID() });
    const before = posts(w, 'CAPTURE_REFUND').length;
    expect(await ex.advance(w.caseId)).toBe('BOOKING_COMMITTED');
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(before);
    expect(opsOf(w, 'CAPTURE_REFUND')[0]).toMatchObject({ status: 'PREPARED', last_error_class: 'HOLD:LEDGER:CAPTURE_STATUS_PARTIALLY_REFUNDED' });
    expect(refundOb(w).status).toBe('NEEDS_ATTENTION');
    expect(audits(w, 'ATTENTION').map((a) => a.reason)).toContain('LEDGER:CAPTURE_STATUS_PARTIALLY_REFUNDED');
    w.clock.advance(120_000);
    await ex.processDue();
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(before);
    expect(ex.retryObligation(refundOb(w).id)).toEqual({ ok: false, reason: 'ATTEMPT_UNFINISHED' });
  });

  it('a refund total that disagrees with the records is kept as evidence and blocks any further refund', async () => {
    const { w, ex } = await atRefund();
    w.faulty.rewrite('CAPTURE_REFUND', (j) => ({ ...j, seller_payable_breakdown: { total_refunded_amount: { currency_code: 'USD', value: '20.00' } } }));
    expect(await ex.advance(w.caseId)).toBe('COMPLETED'); // the refund itself is confirmed by id and amount
    expect(opsOf(w, 'CAPTURE_REFUND')[0]!.observed_total_refunded_minor).toBe(2000);
    expect(ledgerOfA(w).problems).toEqual(['TOTAL_MISMATCH']);
    expect(audits(w, 'ATTENTION').map((a) => a.reason)).toContain('LEDGER:TOTAL_MISMATCH');
  });
});

describe('D18: the ledger itself', () => {
  it('counts each refund id once, lists only sent-but-unconfirmed refunds, and flags gaps and conflicts', async () => {
    const w = await swapWorld();
    const db = w.db;
    insertCase(db, w.ids, { id: 'L1', status: 'COMPLETED' });
    const mk = (kind: string, status: string, refundId: string | null, amount: number | null, total: number | null = null) => {
      const ob = insertObligation(db, { caseId: 'L1', kind: kind as never, amountMinor: 1000, currency: 'USD', target: 'CAP-L' });
      const att = insertAttempt(db, { obligationId: ob, attemptNo: 1, previousId: null, caseVersion: 1, termsHash: 'a'.repeat(64), expiresAt: null });
      const id = `op-${kind}`;
      insertOperation(db, { id, attemptId: att, kind: 'CAPTURE_REFUND', target: 'CAP-L', status });
      db.prepare('UPDATE payment_operations SET result_external_id = ?, result_amount_minor = ?, observed_total_refunded_minor = ? WHERE id = ?').run(refundId, amount, total, id);
      return id;
    };
    mk('A_COMPENSATION_REFUND', 'SUCCEEDED', 'R1', 1000, 1000);
    mk('B_RECOVERY_REFUND', 'SUCCEEDED', 'R1', 1000, 1000); // the same refund seen twice (e.g. replay + query)
    expect(refundLedger(db, 'CAP-L', 6000)).toMatchObject({ confirmedMinor: 1000, remainingMinor: 5000, refundIds: ['R1'], unconfirmedOpIds: [], problems: [] });

    mk('B_AUTH_VOID', 'PENDING', 'R2', null);
    expect(refundLedger(db, 'CAP-L', 6000).unconfirmedOpIds).toEqual(['op-B_AUTH_VOID']);
    expect(refundLedger(db, 'CAP-L', 6000, 'op-B_AUTH_VOID').unconfirmedOpIds).toEqual([]);

    db.prepare("UPDATE payment_operations SET result_amount_minor = 900 WHERE id = 'op-B_RECOVERY_REFUND'").run();
    expect(refundLedger(db, 'CAP-L', 6000).problems).toContain('REFUND_ID_CONFLICT');
    expect(refundLedger(db, 'CAP-L', 500).problems).toContain('OVER_REFUNDED');
  });

  it('cross-checks GET capture status and amount against the records', () => {
    const ledger = { captureId: 'CAP-1', captureMinor: 6000, confirmedMinor: 1000, remainingMinor: 5000, refundIds: ['R1'], unconfirmedOpIds: [], problems: [] };
    const cap = (status: string, value = '60.00') => ({ id: 'CAP-1', status, amount: { currency_code: 'USD', value } });
    expect(captureStateProblems(ledger, cap('PARTIALLY_REFUNDED'), 'USD')).toEqual([]);
    expect(captureStateProblems(ledger, cap('COMPLETED'), 'USD')).toEqual(['CAPTURE_STATUS_COMPLETED']);
    expect(captureStateProblems(ledger, cap('REFUNDED'), 'USD')).toEqual(['CAPTURE_STATUS_REFUNDED']);
    expect(captureStateProblems(ledger, cap('PARTIALLY_REFUNDED', '59.00'), 'USD')).toEqual(['CAPTURE_AMOUNT']);
    expect(captureStateProblems({ ...ledger, confirmedMinor: 0 }, cap('COMPLETED'), 'USD')).toEqual([]);
  });
});
