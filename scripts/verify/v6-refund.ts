// V6: partial refund of 10.00 on A's original capture (V2), resend with the same request id, queries of the
// refund and the capture (STATUS U04), and a refund above the remaining amount, which must be rejected.

import { randomUUID } from 'node:crypto';
import { amountEquals } from '../../src/paypal/money.ts';
import { buildRefundCapture } from '../../src/paypal/requests.ts';
import { anon, NotReady, poll, readState, run, sandboxFromEnv, saveState, str } from './_lib.ts';

const REFUND = { currency: 'USD', minor: 1000 };
const OVER = { currency: 'USD', minor: 5001 }; // remaining after the 10.00 refund is 50.00

await run('V6', 'SANDBOX', async (r) => {
  const { paypal } = sandboxFromEnv();
  const state = readState();
  const captureId = str(state.v2?.captureId);
  if (!captureId) throw new NotReady('V2 finish has not stored the A capture');
  const runId = str(state.v2?.runId) ?? 'x';
  const input = { amount: REFUND, invoiceId: `FS-VERIFY-V6-${runId}`, noteToPayer: 'FlexSlot compensation (Sandbox verification)' };
  const requestHash = buildRefundCapture(captureId, input).hash;
  const requestId = str(state.v6?.requestId) ?? randomUUID();
  saveState('v6', { requestId, requestHash });

  r.note('capture', anon('capture', captureId));
  const first = await paypal.refundCapture(captureId, input, { requestId, expectedRequestHash: requestHash });
  r.note('refund_outcome', first.kind === 'UNKNOWN' ? `UNKNOWN:${first.reason}` : first.kind);
  r.check('refund accepted (COMPLETED or PENDING)', first.kind === 'SUCCEEDED' || first.kind === 'PENDING');
  if (first.kind !== 'SUCCEEDED' && first.kind !== 'PENDING') {
    if (first.kind === 'NOT_ACCEPTED') r.note('issues', first.error.issues.join(','));
    return;
  }
  const refundId = first.resource.id;
  saveState('v6', { refundId });
  r.note('refund', anon('refund', refundId));
  r.note('refund_status', first.externalStatus);
  r.check('response: refund amount 10.00 USD', amountEquals(first.resource.amount, REFUND));
  const total = first.resource.seller_payable_breakdown?.total_refunded_amount;
  r.note('U04_refund_shows_total_refunded', total ? `${total.value} ${total.currency_code}` : 'absent');

  const again = await paypal.refundCapture(captureId, input, { requestId, expectedRequestHash: requestHash });
  r.note('resend_outcome', again.kind === 'UNKNOWN' ? `UNKNOWN:${again.reason}` : again.kind);
  r.check('resend with the same request id returns the same refund id', (again.kind === 'SUCCEEDED' || again.kind === 'PENDING') && again.resource.id === refundId);

  const q = await poll(() => paypal.getRefund(refundId), (v) => v.kind === 'FOUND' && v.resource.status !== 'PENDING');
  if (r.check('GET refund found', q.kind === 'FOUND') && q.kind === 'FOUND') {
    r.note('refund_status_query', q.resource.status);
    r.check('GET refund: COMPLETED', q.resource.status === 'COMPLETED');
  }
  const c = await paypal.getCapture(captureId);
  if (r.check('GET capture found', c.kind === 'FOUND') && c.kind === 'FOUND') {
    r.note('U04_capture_status_after_refund', c.resource.status);
    r.check('GET capture: PARTIALLY_REFUNDED', c.resource.status === 'PARTIALLY_REFUNDED');
    // Field names only (no values), to see whether the capture itself exposes a refunded total.
    r.note('U04_capture_fields', Object.keys(c.resource).sort().join(','));
    r.note('U04_capture_breakdown_fields', Object.keys(c.resource.seller_receivable_breakdown ?? {}).sort().join(',') || '-');
  }

  const over = await paypal.refundCapture(captureId, { amount: OVER }, { requestId: randomUUID() });
  r.note('over_refund_outcome', over.kind === 'UNKNOWN' ? `UNKNOWN:${over.reason}` : over.kind);
  if (over.kind === 'NOT_ACCEPTED' || over.kind === 'UNKNOWN') {
    r.note('over_refund_http_status', over.httpStatus ?? '-');
    r.note('over_refund_issues', over.error?.issues.join(',') || '-');
  }
  r.check('refund above the remaining amount is rejected (NOT_ACCEPTED)', over.kind === 'NOT_ACCEPTED');
});
