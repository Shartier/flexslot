// V3: B's authorization (intent=AUTHORIZE). Two orders are made: b1 is later captured (V4) and refunded (V7),
// b2 is voided (V5).
//   start  — creates both orders and prints two approval URLs (Sandbox buyer account).
//   finish — authorizes both and checks the representation: authorization id, status, expiry, amount.

import { randomUUID } from 'node:crypto';
import { mismatches } from '../../src/paypal/match.ts';
import { approvalUrl } from '../../src/paypal/rest.ts';
import { anon, CANCEL_URL, NotReady, readState, RETURN_URL, run, sandboxFromEnv, saveState, str } from './_lib.ts';

const AMOUNT = { currency: 'USD', minor: 6000 };
const KEYS = ['b1', 'b2'] as const;
const phase = process.argv[2];

await run(`V3 ${phase ?? '(no phase)'}`, 'SANDBOX', async (r) => {
  if (phase !== 'start' && phase !== 'finish') throw new NotReady('usage: node scripts/verify/v3-b-authorize.ts start|finish');
  const { paypal, config } = sandboxFromEnv();

  if (phase === 'start') {
    const runId = randomUUID().slice(0, 8);
    saveState('v3', { runId });
    for (const key of KEYS) {
      const requestId = randomUUID();
      const customId = `verify:v3:${runId}:${key}`;
      saveState(`v3_${key}`, { customId, createRequestId: requestId, orderId: undefined, authorizeRequestId: undefined, authorizationId: undefined });
      const res = await paypal.createOrder(
        {
          intent: 'AUTHORIZE',
          amount: AMOUNT,
          customId,
          invoiceId: `FS-VERIFY-V3-${runId}-${key}`,
          description: `FlexSlot verification V3 (B authorization ${key})`,
          brandName: 'FlexSlot Sandbox',
          returnUrl: RETURN_URL,
          cancelUrl: CANCEL_URL,
        },
        { requestId },
      );
      r.check(`${key}: order created`, res.kind === 'SUCCEEDED');
      if (res.kind !== 'SUCCEEDED') {
        r.note(`${key}_outcome`, res.kind === 'UNKNOWN' ? `UNKNOWN:${res.reason}` : res.kind);
        continue;
      }
      saveState(`v3_${key}`, { orderId: res.resource.id });
      r.note(`${key}_order`, anon('order', res.resource.id));
      r.note(`${key}_order_status`, res.externalStatus);
      const url = approvalUrl(res.resource, 'SANDBOX');
      if (!r.check(`${key}: approval link on www.sandbox.paypal.com`, url !== null)) continue;
      r.say(`${key} approval URL (Sandbox PERSONAL account):`);
      r.say(url!);
    }
    r.say('Approve both, then run: node scripts/verify/v3-b-authorize.ts finish');
    return;
  }

  const state = readState();
  for (const key of KEYS) {
    const s = state[`v3_${key}`] ?? {};
    const orderId = str(s.orderId);
    if (!orderId) throw new NotReady('run "start" first');
    const before = await paypal.getOrder(orderId);
    if (before.kind !== 'FOUND') throw new Error(`${key}: order query failed: ${before.kind}`);
    r.note(`${key}_order`, anon('order', orderId));
    r.note(`${key}_order_status_before`, before.resource.status);
    if (before.resource.status !== 'APPROVED' && before.resource.status !== 'COMPLETED') {
      throw new NotReady(`${key}: order is ${before.resource.status}; approve it in the browser first`);
    }
    // Re-run after a successful authorization: verify by query only (a same-id replay of order authorize
    // returns the order's current state, e.g. CAPTURED / VOIDED after V4 / V5; see STATUS).
    let pu;
    const known = str(s.authorizationId);
    if (known) {
      r.note(`${key}_authorize_step`, 'authorized in an earlier run; checking by query only');
      pu = before.resource.purchase_units?.[0];
      r.check(`${key}: order lists the authorization`, !!pu?.payments?.authorizations?.some((x) => x.id === known));
    } else {
      const authorizeRequestId = str(s.authorizeRequestId) ?? randomUUID();
      saveState(`v3_${key}`, { authorizeRequestId });
      const res = await paypal.authorizeOrder(orderId, { requestId: authorizeRequestId });
      r.note(`${key}_authorize_outcome`, res.kind === 'UNKNOWN' ? `UNKNOWN:${res.reason}` : res.kind);
      r.check(`${key}: authorized (authorization CREATED)`, res.kind === 'SUCCEEDED');
      if (res.kind !== 'SUCCEEDED') continue;
      const a = res.resource.authorization;
      saveState(`v3_${key}`, { authorizationId: a.id });
      r.note(`${key}_authorization`, anon('auth', a.id));
      r.check(`${key}: representation has authorization id, status and expiration_time`, !!a.id && !!a.status && !!a.expiration_time);
      r.check(`${key}: authorization amount and custom_id match`, mismatches(a, { amount: AMOUNT, customId: str(s.customId)! }).length === 0);
      r.note(`${key}_authorization_has_payee`, a.payee?.merchant_id !== undefined);
      pu = res.resource.order.purchase_units?.[0];
    }
    if (config.expectedMerchantId) {
      r.check(`${key}: order payee matches`, pu?.payee?.merchant_id === config.expectedMerchantId);
    }
  }
});
