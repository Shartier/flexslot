// V4: capture B's authorization (b1) with an explicit amount, resend with the same PayPal-Request-Id,
// and see whether the authorization / order queries reveal the capture (STATUS U03).

import { randomUUID } from 'node:crypto';
import { mismatches } from '../../src/paypal/match.ts';
import { buildCaptureAuthorization } from '../../src/paypal/requests.ts';
import { anon, NotReady, readState, run, sandboxFromEnv, saveState, str } from './_lib.ts';

const AMOUNT = { currency: 'USD', minor: 6000 };

await run('V4', 'SANDBOX', async (r) => {
  const { paypal, config } = sandboxFromEnv();
  const state = readState();
  const b1 = state.v3_b1 ?? {};
  const authorizationId = str(b1.authorizationId);
  const orderId = str(b1.orderId);
  if (!authorizationId || !orderId) throw new NotReady('V3 finish has not stored the b1 authorization');
  const runId = str(state.v3?.runId) ?? 'x';

  const input = { amount: AMOUNT, invoiceId: `FS-VERIFY-V4-${runId}` };
  const requestHash = buildCaptureAuthorization(authorizationId, input).hash;
  const requestId = str(state.v4?.requestId) ?? randomUUID();
  saveState('v4', { requestId, requestHash });

  const first = await paypal.captureAuthorization(authorizationId, input, { requestId, expectedRequestHash: requestHash });
  r.note('first_outcome', first.kind === 'UNKNOWN' ? `UNKNOWN:${first.reason}` : first.kind);
  r.check('capture COMPLETED', first.kind === 'SUCCEEDED');
  if (first.kind !== 'SUCCEEDED') return;
  const captureId = first.resource.id;
  saveState('v4', { captureId });
  r.note('capture', anon('capture', captureId));
  r.note('capture_response_has_payee', first.resource.payee?.merchant_id !== undefined);
  r.check('response: amount and custom_id match', mismatches(first.resource, { amount: AMOUNT, customId: str(b1.customId)! }).length === 0);

  const again = await paypal.captureAuthorization(authorizationId, input, { requestId, expectedRequestHash: requestHash, priorUnknownSend: false });
  r.note('resend_outcome', again.kind === 'UNKNOWN' ? `UNKNOWN:${again.reason}` : again.kind);
  r.note('resend_http_status', 'httpStatus' in again && again.httpStatus !== undefined ? again.httpStatus : '-');
  r.check('resend with the same request id returns the same capture id', again.kind === 'SUCCEEDED' && again.resource.id === captureId);

  const auth = await paypal.getAuthorization(authorizationId);
  if (r.check('GET authorization found', auth.kind === 'FOUND') && auth.kind === 'FOUND') {
    r.note('authorization_status', auth.resource.status);
    r.check('GET authorization: CAPTURED', auth.resource.status === 'CAPTURED');
    const linksCapture = (auth.resource.links ?? []).some((l) => l.href.includes(captureId));
    r.note('U03_authorization_links_to_capture', linksCapture);
  }
  const order = await paypal.getOrder(orderId);
  if (r.check('GET order found', order.kind === 'FOUND') && order.kind === 'FOUND') {
    const listed = order.resource.purchase_units?.[0]?.payments?.captures?.some((c) => c.id === captureId) ?? false;
    r.note('U03_order_lists_capture', listed);
  }
  const cap = await paypal.getCapture(captureId);
  if (r.check('GET capture found', cap.kind === 'FOUND') && cap.kind === 'FOUND') {
    r.note('capture_status', cap.resource.status);
    r.check('GET capture: COMPLETED', cap.resource.status === 'COMPLETED');
    const m = mismatches(cap.resource, { amount: AMOUNT, ...(config.expectedMerchantId ? { payeeMerchantId: config.expectedMerchantId } : {}) });
    r.check('GET capture: amount, currency, payee match', m.length === 0);
    if (m.length) r.note('capture_mismatch', m.join(','));
    r.note('capture_links_up_to_authorization', (cap.resource.links ?? []).some((l) => l.rel === 'up' && l.href.includes(authorizationId)));
  }
});
