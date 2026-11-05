// The app with the fixed executor (impl-executor-1-fix1): the proposal stores the frozen terms (D22, IE1-02), and
// the owner screen tells "stopped, owner action needed" apart from "still checking" from the current state (I21).
// Mock PayPal only.

import { describe, expect, it } from 'vitest';
import { getCase } from '../src/executor/store.ts';
import { readTerms } from '../src/executor/terms.ts';
import { aPaysMock, decisionOf, harness, intake, loggedIn, texts } from './app-helpers.ts';

async function proposed() {
  const h = harness();
  const w = await loggedIn(h);
  const t = texts(w.baseDate);
  await aPaysMock(w.a);
  await intake(w.a, t.a, 'A');
  await intake(w.b, t.b, 'B');
  const cs = (await w.owner.state()).cases[0];
  return { h, w, t, cs };
}

describe('the app with the fixed executor', () => {
  it('a proposal freezes parties, services, duration and both condition versions in its terms (D22)', async () => {
    const { h, w, cs } = await proposed();
    const terms = readTerms(getCase(h.db, cs.id)!);
    expect(terms).toMatchObject({
      aCustomerId: `${w.worldId}:customer:a`,
      bCustomerId: `${w.worldId}:customer:b`,
      aServiceId: `${w.worldId}:service:cut`,
      bServiceId: `${w.worldId}:service:cut`,
      bServiceDurationMin: 60,
      bRequestVersion: 1,
      aPreferenceVersion: 1,
      payeeMerchantId: 'MOCKMERCHANT01',
    });
  });

  it('E1 refuses terms whose request changed after the approvals (re-approval needed)', async () => {
    const { h, w, cs } = await proposed();
    await w.owner.post('cases/approve', decisionOf(cs));
    await w.a.post('cases/approve', decisionOf(cs));
    // A change the app itself does not allow while a case is open (intake is locked), made directly in the DB.
    h.db.prepare("UPDATE b_requests SET structured_json = json_set(structured_json, '$.serviceId', ?) WHERE customer_id = ?").run(`${w.worldId}:service:cut-color`, `${w.worldId}:customer:b`);
    expect((await w.b.post('cases/pay', decisionOf(cs))).json).toEqual({ error: 'B_REQUEST_CHANGED' });
    expect(h.mock.count('orders')).toBe(1); // only A's original order
  });

  it('a slot that has started cannot be paid for, even through a stale screen (D23)', async () => {
    const { h, w, t, cs } = await proposed();
    await w.owner.post('cases/approve', decisionOf(cs));
    await w.a.post('cases/approve', decisionOf(cs));
    h.clock.set(Date.parse(`${t.aDay}T05:00:00Z`)); // 14:00 JST, the start of the slot (the 2 h offer has also lapsed)
    await w.b.login(w.tokens.b); // the 24 h session lapsed too; the invite link still works
    const r = await w.b.post('cases/pay', decisionOf(cs));
    expect(r.status).toBe(409);
    expect(['OFFER_EXPIRED', 'SLOT_TIME_PASSED']).toContain(r.json.error);
    expect(h.mock.count('orders')).toBe(1); // only A's original order
  });

  it('owner screen: a mismatch being re-checked is "checking"; a hold is "stopped"; past notices are history only (I21)', async () => {
    const { h, w, cs } = await proposed();
    await w.owner.post('cases/approve', decisionOf(cs));
    await w.a.post('cases/approve', decisionOf(cs));
    await w.b.post('cases/pay', decisionOf(cs));
    // GET capture shows another payee for a while: the capture stays "awaiting reconciliation" and is re-checked.
    h.mock.inject('CAPTURE_GET', { type: 'HTTP_ERROR', status: 500 }, 1);
    await w.b.post('cases/mock-approve', { caseId: cs.id });
    await h.app.idle();
    let o = await w.owner.state();
    expect(o.stopped).toEqual([]);
    expect(o.checking).toEqual([]); // a failed query is not a mismatch
    // Force a current hold on the capture operation (as a hash mismatch or retry limit would).
    h.db.prepare("UPDATE payment_operations SET last_error_class = 'HOLD:RETRY_LIMIT' WHERE op_kind = 'AUTH_CAPTURE'").run();
    o = await w.owner.state();
    expect(o.stopped).toEqual([{ obligation: 'B_CHARGE', operation: 'AUTH_CAPTURE', status: 'SUCCEEDED', reason: 'RETRY_LIMIT' }]);
    h.db.prepare("UPDATE payment_operations SET last_error_class = 'MISMATCH:payee' WHERE op_kind = 'AUTH_CAPTURE'").run();
    o = await w.owner.state();
    expect(o.stopped).toEqual([]);
    expect(o.checking).toEqual([{ obligation: 'B_CHARGE', operation: 'AUTH_CAPTURE', status: 'SUCCEEDED', reason: 'MISMATCH:payee' }]);
    // Once the records match the swap goes on and nothing is shown as current any more.
    h.db.prepare('UPDATE payment_operations SET last_error_class = NULL, next_send_at = NULL WHERE op_kind = ?').run('AUTH_CAPTURE');
    await h.ticks(5);
    o = await w.owner.state();
    expect(o.cases[0].status).toBe('COMPLETED');
    expect([o.stopped, o.checking, o.needsAttentionObligations]).toEqual([[], [], []]);
  });
});
