// Send queue (DESIGN 7, 7.1): same-id resends on network errors, 5xx and 429 with 2 s doubling, at most 6
// resends; the limit does not turn the operation into a failure. NOT_SENT and auth errors. Mock only.

import { describe, expect, it } from 'vitest';
import { getOp } from '../src/executor/ops.ts';
import { audits, caseStatus, crashAt, expectCompletedSwap, obligation, opsOf, posts, swapWorld, toAuthorized, SimulatedCrash } from './executor-helpers.ts';

async function atRefund(o: Parameters<typeof swapWorld>[0] = {}) {
  const w = await swapWorld(o);
  const ex = w.exec({ hooks: crashAt('after-e7') });
  await toAuthorized(w, ex);
  await expect(ex.advance(w.caseId)).rejects.toThrow(SimulatedCrash);
  return { w, ex: w.exec({ owner: 'exec-q' }) };
}

describe('send queue: resend with backoff (DESIGN 7)', () => {
  it('resends with the same id after 2, 4, 8, 16, 32 and 64 s, and not before', async () => {
    const { w, ex } = await atRefund();
    w.server.inject('CAPTURE_REFUND', { type: 'HTTP_ERROR', status: 503 }, 6);
    await ex.advance(w.caseId);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      const op = opsOf(w, 'CAPTURE_REFUND')[0]!;
      expect(op).toMatchObject({ status: 'UNKNOWN', last_error_class: 'HTTP_5XX', sends: i + 1 });
      const delay = op.next_send_at! - w.clock.now();
      delays.push(delay);
      w.clock.advance(delay - 1);
      await ex.processDue();
      expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(i + 1); // not due yet
      w.clock.advance(1);
      await ex.processDue();
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000]);
    const sends = posts(w, 'CAPTURE_REFUND');
    expect(sends).toHaveLength(7);
    expect(new Set(sends.map((s) => s.requestId)).size).toBe(1);
    expectCompletedSwap(w, expect);
  });

  it('after the limit the operation stays unknown (not failed), stops resending and is shown to the owner', async () => {
    const { w, ex } = await atRefund();
    w.server.inject('CAPTURE_REFUND', { type: 'HTTP_ERROR', status: 503 }, 7);
    await ex.advance(w.caseId);
    for (let i = 0; i < 8; i++) {
      w.clock.advance(70_000);
      await ex.processDue();
    }
    const op = opsOf(w, 'CAPTURE_REFUND')[0]!;
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(7);
    expect(op).toMatchObject({ status: 'UNKNOWN', sends: 7, last_error_class: 'HOLD:RETRY_LIMIT' });
    expect(obligation(w, 'A_COMPENSATION_REFUND')?.status).toBe('NEEDS_ATTENTION');
    expect(audits(w, 'ATTENTION').map((a) => a.reason)).toContain('RETRY_LIMIT');
    expect(caseStatus(w)).toBe('REFUND_PENDING');
    expect(w.server.count('refunds')).toBe(0);
    // A restart retries recovery once more, but still never exceeds the limit.
    await w.exec({ owner: 'exec-r' }).recover();
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(7);
  });

  it('429 and a processed timeout are retried with the same id and produce one refund', async () => {
    const { w, ex } = await atRefund();
    w.server.inject('CAPTURE_REFUND', { type: 'HTTP_ERROR', status: 429 });
    w.server.inject('CAPTURE_REFUND', { type: 'TIMEOUT', processed: true });
    await ex.advance(w.caseId);
    expect(opsOf(w, 'CAPTURE_REFUND')[0]!.last_error_class).toBe('HTTP_429');
    w.clock.advance(2_000);
    await ex.processDue();
    expect(opsOf(w, 'CAPTURE_REFUND')[0]!.last_error_class).toBe('TIMEOUT');
    w.clock.advance(4_000);
    await ex.processDue();
    expect(posts(w, 'CAPTURE_REFUND')).toHaveLength(3);
    expect(new Set(posts(w, 'CAPTURE_REFUND').map((s) => s.requestId)).size).toBe(1);
    expectCompletedSwap(w, expect);
  });
});

describe('send queue: NOT_SENT and auth errors (STATUS I09, I12)', () => {
  it('NOT_SENT means only "this send did not happen": an earlier unknown send stays unknown', async () => {
    const { w, ex } = await atRefund();
    w.server.inject('CAPTURE_REFUND', { type: 'HTTP_ERROR', status: 503 });
    await ex.advance(w.caseId);
    expect(opsOf(w, 'CAPTURE_REFUND')[0]).toMatchObject({ status: 'UNKNOWN', prior_unknown: 1, sends: 1 });

    w.server.revokeTokens();
    w.server.inject('TOKEN', { type: 'HTTP_ERROR', status: 500 });
    w.clock.advance(2_000);
    await ex.processDue();
    expect(opsOf(w, 'CAPTURE_REFUND')[0]).toMatchObject({ status: 'UNKNOWN', prior_unknown: 1, sends: 1, last_error_class: 'NOT_SENT:HTTP_5XX' });

    w.clock.advance(2_000);
    await ex.processDue();
    expectCompletedSwap(w, expect);
    expect(new Set(posts(w, 'CAPTURE_REFUND').map((s) => s.requestId)).size).toBe(1);
  });

  it('a persistent 401 keeps the operation open, then the same id is resent', async () => {
    const { w, ex } = await atRefund();
    w.server.inject('CAPTURE_REFUND', { type: 'UNAUTHORIZED' }, 2); // the adapter refreshes the token once
    await ex.advance(w.caseId);
    const op = opsOf(w, 'CAPTURE_REFUND')[0]!;
    expect(op).toMatchObject({ status: 'UNKNOWN', last_error_class: 'AUTH_ERROR', prior_unknown: 0 });
    w.clock.advance(10_000);
    await ex.processDue();
    expectCompletedSwap(w, expect);
    expect(getOp(w.db, 'payment_operations', op.id)!.paypal_request_id).toBe(op.paypal_request_id);
  });
});
