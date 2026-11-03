// V7: full refund of B's capture (V4), the recovery path E-R. The amount is explicit (never omitted).

import { randomUUID } from 'node:crypto';
import { amountEquals } from '../../src/paypal/money.ts';
import { buildRefundCapture } from '../../src/paypal/requests.ts';
import { anon, NotReady, poll, readState, run, sandboxFromEnv, saveState, str } from './_lib.ts';

const FULL = { currency: 'USD', minor: 6000 };

await run('V7', 'SANDBOX', async (r) => {
  const { paypal } = sandboxFromEnv();
  const state = readState();
  const captureId = str(state.v4?.captureId);
  if (!captureId) throw new NotReady('V4 has not stored the B capture');
  const runId = str(state.v3?.runId) ?? 'x';
  const input = { amount: FULL, invoiceId: `FS-VERIFY-V7-${runId}`, noteToPayer: 'FlexSlot swap could not be completed (Sandbox verification)' };
  const requestHash = buildRefundCapture(captureId, input).hash;
  const requestId = str(state.v7?.requestId) ?? randomUUID();
  saveState('v7', { requestId, requestHash });

  r.note('capture', anon('capture', captureId));
  const res = await paypal.refundCapture(captureId, input, { requestId, expectedRequestHash: requestHash });
  r.note('refund_outcome', res.kind === 'UNKNOWN' ? `UNKNOWN:${res.reason}` : res.kind);
  r.check('full refund accepted (COMPLETED or PENDING)', res.kind === 'SUCCEEDED' || res.kind === 'PENDING');
  if (res.kind !== 'SUCCEEDED' && res.kind !== 'PENDING') {
    if (res.kind === 'NOT_ACCEPTED') r.note('issues', res.error.issues.join(','));
    return;
  }
  const refundId = res.resource.id;
  saveState('v7', { refundId });
  r.note('refund', anon('refund', refundId));
  r.check('response: refund amount 60.00 USD', amountEquals(res.resource.amount, FULL));

  const q = await poll(() => paypal.getRefund(refundId), (v) => v.kind === 'FOUND' && v.resource.status !== 'PENDING');
  if (r.check('GET refund found', q.kind === 'FOUND') && q.kind === 'FOUND') {
    r.note('refund_status_query', q.resource.status);
    r.check('GET refund: COMPLETED', q.resource.status === 'COMPLETED');
  }
  const c = await paypal.getCapture(captureId);
  if (r.check('GET capture found', c.kind === 'FOUND') && c.kind === 'FOUND') {
    r.note('capture_status_after_refund', c.resource.status);
    r.check('GET capture: REFUNDED', c.resource.status === 'REFUNDED');
  }
});
