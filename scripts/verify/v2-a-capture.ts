// V2: A's original payment (intent=CAPTURE).
//   start  — creates the order and prints the approval URL (log in there with the Sandbox buyer account).
//   finish — after approval: captures, then checks amount, currency and payee by querying capture and order.

import { randomUUID } from 'node:crypto';
import { mismatches } from '../../src/paypal/match.ts';
import { approvalUrl } from '../../src/paypal/rest.ts';
import { anon, CANCEL_URL, NotReady, readState, RETURN_URL, run, sandboxFromEnv, saveState, str } from './_lib.ts';

const AMOUNT = { currency: 'USD', minor: 6000 };
const phase = process.argv[2];

await run(`V2 ${phase ?? '(no phase)'}`, 'SANDBOX', async (r) => {
  if (phase !== 'start' && phase !== 'finish') throw new NotReady('usage: node scripts/verify/v2-a-capture.ts start|finish');
  const { paypal, config } = sandboxFromEnv();

  if (phase === 'start') {
    const runId = randomUUID().slice(0, 8);
    const requestId = randomUUID();
    const customId = `verify:v2:${runId}`;
    saveState('v2', { runId, customId, createRequestId: requestId, orderId: undefined, captureId: undefined, captureRequestId: undefined });
    const res = await paypal.createOrder(
      {
        intent: 'CAPTURE',
        amount: AMOUNT,
        customId,
        invoiceId: `FS-VERIFY-V2-${runId}`,
        description: 'FlexSlot verification V2 (A original payment)',
        brandName: 'FlexSlot Sandbox',
        returnUrl: RETURN_URL,
        cancelUrl: CANCEL_URL,
      },
      { requestId },
    );
    r.check('order created', res.kind === 'SUCCEEDED');
    if (res.kind !== 'SUCCEEDED') {
      r.note('outcome', res.kind === 'UNKNOWN' ? `UNKNOWN:${res.reason}` : res.kind);
      if (res.kind === 'NOT_ACCEPTED') r.note('issues', res.error.issues.join(','));
      return;
    }
    saveState('v2', { orderId: res.resource.id });
    r.note('order', anon('order', res.resource.id));
    r.note('order_status', res.externalStatus);
    const url = approvalUrl(res.resource, 'SANDBOX');
    if (!r.check('approval link on www.sandbox.paypal.com', url !== null)) return;
    r.say('Open this URL, log in with the Sandbox PERSONAL (buyer) account and approve:');
    r.say(url!);
    r.say('After approval the browser goes to localhost and shows a connection error; that is expected.');
    r.say('Then run: node scripts/verify/v2-a-capture.ts finish');
    return;
  }

  const s = readState().v2 ?? {};
  const orderId = str(s.orderId);
  if (!orderId) throw new NotReady('run "start" first');
  const expectedPayee = config.expectedMerchantId;
  if (!expectedPayee) throw new NotReady('PAYPAL_EXPECTED_MERCHANT_ID is not set');

  const before = await paypal.getOrder(orderId);
  if (before.kind !== 'FOUND') throw new Error(`order query failed: ${before.kind}`);
  r.note('order', anon('order', orderId));
  r.note('order_status_before', before.resource.status);
  if (before.resource.status !== 'APPROVED' && before.resource.status !== 'COMPLETED') {
    throw new NotReady(`order is ${before.resource.status}; approve it in the browser first`);
  }

  const captureRequestId = str(s.captureRequestId) ?? randomUUID();
  saveState('v2', { captureRequestId });
  const cap = await paypal.captureOrder(orderId, { requestId: captureRequestId });
  r.note('capture_outcome', cap.kind === 'UNKNOWN' ? `UNKNOWN:${cap.reason}` : cap.kind);
  r.check('order captured (capture COMPLETED)', cap.kind === 'SUCCEEDED');
  if (cap.kind !== 'SUCCEEDED') return;
  const capture = cap.resource.capture;
  saveState('v2', { captureId: capture.id });
  r.note('capture', anon('capture', capture.id));
  r.note('capture_response_has_payee', capture.payee?.merchant_id !== undefined);
  r.check('capture response: amount and custom_id match', mismatches(capture, { amount: AMOUNT, customId: str(s.customId)! }).length === 0);

  const q = await paypal.getCapture(capture.id);
  r.check('GET capture found', q.kind === 'FOUND');
  if (q.kind === 'FOUND') {
    r.note('capture_status', q.resource.status);
    r.check('GET capture: COMPLETED', q.resource.status === 'COMPLETED');
    const m = mismatches(q.resource, { amount: AMOUNT, customId: str(s.customId)!, payeeMerchantId: expectedPayee });
    r.check('GET capture: amount, currency, custom_id, payee match', m.length === 0);
    if (m.length) r.note('capture_mismatch', m.join(','));
  }

  const o = await paypal.getOrder(orderId);
  r.check('GET order found', o.kind === 'FOUND');
  if (o.kind === 'FOUND') {
    const pu = o.resource.purchase_units?.[0];
    r.note('order_status_after', o.resource.status);
    r.check('GET order: COMPLETED', o.resource.status === 'COMPLETED');
    r.check('GET order: purchase unit amount and payee match', !!pu && mismatches(pu, { amount: AMOUNT, payeeMerchantId: expectedPayee }).length === 0);
    r.check('GET order: lists the capture', !!pu?.payments?.captures?.some((c) => c.id === capture.id));
  }
});
