// AC01 / AC04 evidence for one swap made through the screens: the app's database (data/flexslot.sqlite, read only)
// and fresh Sandbox queries (GET only, nothing is sent) must agree on every order, authorization, capture and refund
// of the world. Prints check results and anonymized ids only (no raw ids, tokens or customer text).
// Usage: node scripts/verify/app-reconcile.ts <worldId>

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fromPayPalValue } from '../../src/paypal/money.ts';
import type { Amount } from '../../src/paypal/schemas.ts';
import { anon, NotReady, ROOT, run, sandboxFromEnv } from './_lib.ts';

const worldId = process.argv[2];

await run('APP-SANDBOX-RECONCILE', 'SANDBOX', async (r) => {
  if (!worldId || !/^[A-Za-z0-9_-]{1,40}$/.test(worldId)) throw new NotReady('usage: node scripts/verify/app-reconcile.ts <worldId>');
  const db = new DatabaseSync(join(ROOT, 'data', 'flexslot.sqlite'), { readOnly: true });
  const { paypal, config } = sandboxFromEnv();
  const payee = config.expectedMerchantId;
  if (!payee) throw new NotReady('PAYPAL_EXPECTED_MERCHANT_ID is not set');
  const minor = (a: Amount | undefined) => (a ? fromPayPalValue(a.value, a.currency_code) : null);
  const one = <T>(sql: string, ...args: Array<string | number>) => db.prepare(sql).get(...args) as T | undefined;

  const world = one<{ mode_payment: string; mode_ai: string }>('SELECT mode_payment, mode_ai FROM worlds WHERE id = ?', worldId);
  if (!world) throw new NotReady('unknown world');
  r.check('world is a Sandbox world', world.mode_payment === 'SANDBOX');
  r.note('ai_mode', world.mode_ai);
  const c = one<{ id: string; status: string; a_booking_id: string; a_capture_id: string; b_price_minor: number; a_comp_minor: number; currency: string; origin_start_ms: number; dest_start_ms: number; b_start_ms: number; dest_end_ms: number; b_end_ms: number }>(
    "SELECT * FROM swap_cases WHERE world_id = ? AND status = 'COMPLETED' ORDER BY rowid DESC LIMIT 1", worldId,
  );
  if (!c) throw new NotReady('no completed case in this world');
  r.check('case COMPLETED in the DB', c.status === 'COMPLETED');

  // ---- DB side ----------------------------------------------------------------------------------------------
  const op = (kind: string, obligation: string) =>
    one<{ result_external_id: string; status: string; reconcile_status: string | null; sends: number; paypal_request_id: string }>(
      `SELECT o.* FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id JOIN money_obligations m ON m.id = t.obligation_id
       WHERE m.case_id = ? AND m.kind = ? AND o.op_kind = ? AND o.status = 'SUCCEEDED'`, c.id, obligation, kind,
    );
  const bOrder = op('ORDER_CREATE', 'B_CHARGE');
  const bAuth = op('ORDER_AUTHORIZE', 'B_CHARGE');
  const bCap = op('AUTH_CAPTURE', 'B_CHARGE');
  const aRefund = op('CAPTURE_REFUND', 'A_COMPENSATION_REFUND');
  const aOrderOp = one<{ result_external_id: string }>("SELECT result_external_id FROM a_payment_operations WHERE booking_id = ? AND op_kind = 'ORDER_CREATE' AND status = 'SUCCEEDED'", c.a_booking_id);
  const aCapOp = one<{ result_external_id: string; reconcile_status: string }>("SELECT * FROM a_payment_operations WHERE booking_id = ? AND op_kind = 'ORDER_CAPTURE' AND status = 'SUCCEEDED'", c.a_booking_id);
  const aPay = one<{ order_id: string; capture_id: string; amount_minor: number; currency: string; payee_merchant_id: string }>("SELECT * FROM payments WHERE booking_id = ? AND kind = 'A_ORIGINAL'", c.a_booking_id);
  const bPay = one<{ order_id: string; capture_id: string; amount_minor: number; currency: string; payee_merchant_id: string; booking_id: string }>(
    "SELECT * FROM payments WHERE booking_id = ? AND kind = 'B_SWAP'", `${c.id}:booking:b`,
  );
  if (!bOrder || !bAuth || !bCap || !aRefund || !aOrderOp || !aCapOp || !aPay || !bPay) throw new NotReady('missing records in the DB');
  r.check('DB: every PayPal operation was sent once (no resend)', [bOrder, bAuth, bCap, aRefund].every((o) => o.sends === 1));
  r.check('DB: B authorization and capture reconciled (MATCHED), A capture reconciled', bAuth.reconcile_status === 'MATCHED' && bCap.reconcile_status === 'MATCHED' && aCapOp.reconcile_status === 'MATCHED');
  r.check('DB: payments rows point at the operations (A order/capture, B order/capture)', aPay.order_id === aOrderOp.result_external_id && aPay.capture_id === aCapOp.result_external_id && bPay.order_id === bOrder.result_external_id && bPay.capture_id === bCap.result_external_id);
  r.check('DB: the case refunds A\'s own capture', c.a_capture_id === aPay.capture_id);
  const obligations = db.prepare('SELECT kind, status, amount_minor FROM money_obligations WHERE case_id = ? ORDER BY kind').all(c.id) as Array<{ kind: string; status: string; amount_minor: number }>;
  r.check('DB: obligations B_CHARGE 60.00 and A_COMPENSATION_REFUND 10.00 SETTLED, nothing else', JSON.stringify(obligations) === JSON.stringify([
    { kind: 'A_COMPENSATION_REFUND', status: 'SETTLED', amount_minor: c.a_comp_minor },
    { kind: 'B_CHARGE', status: 'SETTLED', amount_minor: c.b_price_minor },
  ]));
  const aBooking = one<{ start_ms: number; end_ms: number; version: number }>('SELECT start_ms, end_ms, version FROM bookings WHERE id = ?', c.a_booking_id)!;
  const bBooking = one<{ start_ms: number; end_ms: number; status: string }>('SELECT start_ms, end_ms, status FROM bookings WHERE id = ?', bPay.booking_id)!;
  r.check('DB: A moved to the destination, B booked in the original slot', aBooking.start_ms === c.dest_start_ms && aBooking.end_ms === c.dest_end_ms && aBooking.version === 2 && bBooking.start_ms === c.b_start_ms && bBooking.end_ms === c.b_end_ms && bBooking.status === 'CONFIRMED');
  r.check('DB: one compensation grant for A\'s booking', (one<{ n: number }>('SELECT count(*) AS n FROM compensation_grants WHERE booking_id = ?', c.a_booking_id)!).n === 1);

  // ---- Sandbox side (GET only) ---------------------------------------------------------------------------------
  r.note('a_order', anon('order', aPay.order_id));
  r.note('a_capture', anon('capture', aPay.capture_id));
  r.note('b_order', anon('order', bPay.order_id));
  r.note('b_authorization', anon('authorization', bAuth.result_external_id));
  r.note('b_capture', anon('capture', bPay.capture_id));
  r.note('a_refund', anon('refund', aRefund.result_external_id));

  const aOrder = await paypal.getOrder(aPay.order_id);
  if (aOrder.kind !== 'FOUND') throw new Error(`A order query: ${aOrder.kind}`);
  const aPu = aOrder.resource.purchase_units?.[0];
  r.check('Sandbox: A order COMPLETED, 60.00 USD to the shop, custom_id of A\'s booking', aOrder.resource.status === 'COMPLETED' && minor(aPu?.amount) === aPay.amount_minor && aPu?.amount?.currency_code === aPay.currency && aPu?.payee?.merchant_id === payee && aPu?.custom_id === `booking:${c.a_booking_id}:a`);
  r.check('Sandbox: A order lists exactly A\'s capture', (aPu?.payments?.captures ?? []).map((x) => x.id).join() === aPay.capture_id);

  const aCap = await paypal.getCapture(aPay.capture_id);
  if (aCap.kind !== 'FOUND') throw new Error(`A capture query: ${aCap.kind}`);
  r.check('Sandbox: A capture PARTIALLY_REFUNDED, 60.00 USD, payee matches', aCap.resource.status === 'PARTIALLY_REFUNDED' && minor(aCap.resource.amount) === aPay.amount_minor && aCap.resource.payee?.merchant_id === payee);

  const ref = await paypal.getRefund(aRefund.result_external_id);
  if (ref.kind !== 'FOUND') throw new Error(`refund query: ${ref.kind}`);
  const upCapture = ref.resource.links?.find((l) => l.rel === 'up')?.href.split('/').pop();
  r.check('Sandbox: refund COMPLETED, 10.00 USD, of A\'s capture', ref.resource.status === 'COMPLETED' && minor(ref.resource.amount) === c.a_comp_minor && ref.resource.amount?.currency_code === c.currency && upCapture === aPay.capture_id);

  const bOrderQ = await paypal.getOrder(bPay.order_id);
  if (bOrderQ.kind !== 'FOUND') throw new Error(`B order query: ${bOrderQ.kind}`);
  const bPu = bOrderQ.resource.purchase_units?.[0];
  const auths = bPu?.payments?.authorizations ?? [];
  const caps = bPu?.payments?.captures ?? [];
  r.note('b_order_status', bOrderQ.resource.status);
  r.check('Sandbox: B order 60.00 USD to the shop, custom_id of this case', minor(bPu?.amount) === bPay.amount_minor && bPu?.payee?.merchant_id === payee && (bPu?.custom_id ?? '').startsWith(`case:${c.id}:v1:att:`));
  r.check('Sandbox: B order has exactly one authorization (CAPTURED) and one capture, both ours', auths.length === 1 && auths[0]!.id === bAuth.result_external_id && auths[0]!.status === 'CAPTURED' && caps.length === 1 && caps[0]!.id === bPay.capture_id);

  const bAuthQ = await paypal.getAuthorization(bAuth.result_external_id);
  if (bAuthQ.kind !== 'FOUND') throw new Error(`B authorization query: ${bAuthQ.kind}`);
  r.check('Sandbox: B authorization CAPTURED, 60.00 USD', bAuthQ.resource.status === 'CAPTURED' && minor(bAuthQ.resource.amount) === c.b_price_minor);

  const bCapQ = await paypal.getCapture(bPay.capture_id);
  if (bCapQ.kind !== 'FOUND') throw new Error(`B capture query: ${bCapQ.kind}`);
  r.check('Sandbox: B capture COMPLETED (not refunded), 60.00 USD, payee matches, custom_id of this case', bCapQ.resource.status === 'COMPLETED' && minor(bCapQ.resource.amount) === bPay.amount_minor && bCapQ.resource.payee?.merchant_id === payee && bCapQ.resource.custom_id === bPu?.custom_id);
  db.close();
});
