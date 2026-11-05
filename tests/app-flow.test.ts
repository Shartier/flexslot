// One swap through the HTTP API of the three screens, mock AI + mock PayPal (AC01 path, AC10, AC14 on screen).
// Mock only: this is not the Sandbox run (that one is recorded in STATUS).

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db/database.ts';
import { MockPayPalServer } from '../src/paypal/mock-server.ts';
import { localToUtcMs } from '../src/time.ts';
import { aPaysMock, Client, decisionOf, harness, intake, loggedIn, texts } from './app-helpers.ts';

const at = (date: string, time: string) => localToUtcMs(date, time, 'Asia/Tokyo');

describe('one swap through the three screens (mock AI, mock PayPal)', () => {
  it('A pays, registers conditions; B requests; owner -> A -> B approve; B pays; the swap completes', async () => {
    const h = harness();
    const w = await loggedIn(h);
    const t = texts(w.baseDate);
    expect(w.baseDate).toBe('2026-11-03');

    // A's booking starts unpaid; A pays it (mock approval).
    let a = await w.a.state();
    expect(a.booking.payment.state).toBe('UNPAID');
    expect(a.header.modes).toMatchObject({ ai: 'MOCK', aiModel: 'mock-rules-v1', payment: 'MOCK' });
    await aPaysMock(w.a);
    a = await w.a.state();
    expect(a.booking.payment.state).toBe('PAID');
    expect(a.booking.time).toBe(`${t.aDay} 14:00–15:00`);

    // A's move conditions through the AI (mock), confirmed unchanged.
    const aConfirm = await intake(w.a, t.a, 'A');
    expect(aConfirm).toMatchObject({ ok: true, version: 1, edited: false, proposal: null });
    a = await w.a.state();
    expect(a.preference).toMatchObject({ version: 1, source: 'AI (mock rules)', windows: [{ date: t.moveDay, start: '10:00', end: '12:00' }], compensation: { text: 'USD 10.00' } });

    // B's request -> the program finds the swap and proposes it.
    const bConfirm = await intake(w.b, t.b, 'B');
    expect(bConfirm.proposal).toMatchObject({ feasible: true });
    let b = await w.b.state();
    expect(b.result).toEqual({ feasible: true, reasons: [] });
    expect(b.cases).toHaveLength(1);
    const cs = b.cases[0];
    expect(cs).toMatchObject({ status: 'AWAITING_APPROVAL', bSlot: `${t.aDay} 14:00–15:00`, bPrice: { text: 'USD 60.00' }, actions: { pay: false } });

    // Owner sees the candidate, the fixed compensation and the 20.50 estimate (SPEC 9).
    const o = await w.owner.state();
    expect(o.cases[0]).toMatchObject({ origin: `${t.aDay} 14:00–15:00`, destination: `${t.moveDay} 10:00–11:00`, aCompensation: { text: 'USD 10.00' } });
    expect(o.cases[0].profit.additionalProfit.text).toBe('USD 20.50');
    expect(o.evaluation).toMatchObject({ feasible: true });

    // D08: A cannot approve before the owner.
    expect((await w.a.post('cases/approve', decisionOf(cs))).json).toEqual({ error: 'OWNER_FIRST' });
    expect((await w.owner.post('cases/approve', decisionOf(cs))).status).toBe(200);
    expect((await w.a.post('cases/approve', decisionOf(cs))).json).toEqual({ ok: true, status: 'A_ACCEPTED' });

    // B approves the terms and starts the payment (E1, E2); mock approval on "PayPal" (E3) -> E4..E8.
    b = await w.b.state();
    expect(b.cases[0].actions.pay).toBe(true);
    const pay = await w.b.post('cases/pay', decisionOf(b.cases[0]));
    expect(pay.json).toEqual({ approval: { kind: 'MOCK' } });
    b = await w.b.state();
    expect(b.cases[0].steps.bPayment.state).toBe('WAITING_BUYER');
    expect((await w.b.post('cases/mock-approve', { caseId: cs.id })).status).toBe(200);
    await h.app.idle();
    await h.ticks(5);

    b = await w.b.state();
    expect(b.cases[0]).toMatchObject({ status: 'COMPLETED', statusLabel: 'Swap completed', steps: { bPayment: { state: 'DONE' }, aRefund: { state: 'DONE' } } });
    a = await w.a.state();
    expect(a.booking.time).toBe(`${t.moveDay} 10:00–11:00`);
    expect(a.cases[0].steps.aRefund).toEqual({ state: 'DONE', text: 'Refunded' });

    // DB and the mock PayPal agree: B captured 60.00, A refunded 10.00, bookings swapped, one compensation.
    const db = h.db;
    const caseRow = db.prepare('SELECT * FROM swap_cases WHERE id = ?').get(cs.id) as { status: string; a_capture_id: string };
    expect(caseRow.status).toBe('COMPLETED');
    expect(h.mock.statusOf(caseRow.a_capture_id)).toBe('PARTIALLY_REFUNDED');
    const bPay = db.prepare("SELECT capture_id, amount_minor FROM payments WHERE kind = 'B_SWAP'").get() as { capture_id: string; amount_minor: number };
    expect(bPay.amount_minor).toBe(6000);
    expect(h.mock.statusOf(bPay.capture_id)).toBe('COMPLETED');
    expect(db.prepare('SELECT start_ms FROM bookings WHERE customer_id = ?').get(`${w.worldId}:customer:a`)).toEqual({ start_ms: at(t.moveDay, '10:00') });
    expect(db.prepare('SELECT start_ms FROM bookings WHERE customer_id = ?').get(`${w.worldId}:customer:b`)).toEqual({ start_ms: at(t.aDay, '14:00') });
    expect(db.prepare('SELECT count(*) AS n FROM compensation_grants').get()).toEqual({ n: 1 });
    expect([h.mock.count('orders'), h.mock.count('authorizations'), h.mock.count('captures'), h.mock.count('refunds')]).toEqual([2, 1, 2, 1]);

    // After completion: nothing more is sent, and no new conditions can be registered in this world.
    const before = h.mock.requests.length;
    await h.ticks(3);
    expect(h.mock.requests.filter((r) => r.method === 'POST').length).toBe(h.mock.requests.slice(0, before).filter((r) => r.method === 'POST').length);
    expect((await w.b.post('intake/draft', { text: t.b, useAi: true })).json).toEqual({ error: 'SWAP_DONE' });
  });

  it('B first, then A: the request is re-checked when A registers and pays; reasons are shown meanwhile', async () => {
    const h = harness();
    const w = await loggedIn(h);
    const t = texts(w.baseDate);
    const r = await intake(w.b, t.b, 'B');
    expect(r.proposal).toMatchObject({ feasible: false, reasons: ['A_PAYMENT_NOT_VERIFIED', 'A_NO_FLEX_PREFERENCE'] });
    let b = await w.b.state();
    expect(b.result.feasible).toBe(false);
    expect(b.result.reasons[0]).toContain('payment');
    const o = await w.owner.state();
    expect(o.evaluation.reasons.map((x: { code: string }) => x.code)).toEqual(['A_PAYMENT_NOT_VERIFIED', 'A_NO_FLEX_PREFERENCE']);
    await intake(w.a, t.a, 'A');
    expect((await w.b.state()).cases).toHaveLength(0);
    await aPaysMock(w.a);
    b = await w.b.state();
    expect(b.cases).toHaveLength(1);
    expect(b.cases[0].status).toBe('AWAITING_APPROVAL');
  });

  it('a 120-minute request does not fit the 60-minute slot: no case, reason shown (AC02 on screen)', async () => {
    const h = harness();
    const w = await loggedIn(h);
    const t = texts(w.baseDate);
    await aPaysMock(w.a);
    await intake(w.a, t.a, 'A');
    const r = await intake(w.b, `I want cut and color on ${t.aDay}, only 14:00-15:00.`, 'B');
    expect(r.proposal).toMatchObject({ feasible: false });
    expect(r.proposal.reasons).toContain('B_SERVICE_LONGER_THAN_REQUEST_WINDOW');
  });

  it('survives a server restart in the middle (AC10): sessions, approvals, history and the payment continue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flexslot-app-'));
    try {
      const file = join(dir, 'db.sqlite');
      const h1 = harness({ db: openDatabase(file) });
      const w = await loggedIn(h1);
      const t = texts(w.baseDate);
      await aPaysMock(w.a);
      await intake(w.a, t.a, 'A');
      await intake(w.b, t.b, 'B');
      const cs = (await w.b.state()).cases[0];
      await w.owner.post('cases/approve', decisionOf(cs));
      await w.a.post('cases/approve', decisionOf(cs));
      await w.b.post('cases/pay', decisionOf(cs));
      const mockState = h1.mock.exportState();
      h1.db.close();

      // New process: same DB file, the mock PayPal restored from its saved state, new executors.
      const mock2 = new MockPayPalServer({ clock: h1.clock });
      mock2.importState(mockState);
      const h2 = harness({ db: openDatabase(file), clock: h1.clock, mock: mock2, owner: 'exec-restarted' });
      // The browser keeps its cookie (a reload): a new tab object on the new app fetches a fresh CSRF token.
      const reopen = (seg: 'owner' | 'a' | 'b', cookie: string | null) => {
        const c = new Client(h2.app, w.worldId, seg);
        c.cookie = cookie;
        return c;
      };
      const owner = reopen('owner', w.owner.cookie);
      const b = reopen('b', w.b.cookie);
      b.csrf = (await b.post('session/csrf')).json.csrfToken;
      await h2.runtime.startup();
      let st = await b.state();
      expect(st.cases[0].status).toBe('PAYMENT_STARTED');
      expect(st.cases[0].approvals).toEqual({ OWNER: 'APPROVED', A: 'APPROVED', B: 'APPROVED' });
      expect((await b.post('cases/mock-approve', { caseId: cs.id })).status).toBe(200);
      await h2.ticks(5);
      st = await b.state();
      expect(st.cases[0].status).toBe('COMPLETED');
      const hist = (await owner.state()).history.map((e: { action: string }) => e.action);
      expect(hist).toEqual(expect.arrayContaining(['WORLD_CREATED', 'CASE_PROPOSED', 'OWNER_APPROVED', 'A_APPROVED', 'PAYMENT_STARTED', 'BOOKING_COMMITTED']));
      h2.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
