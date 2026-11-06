// Japanese screens (?lang=ja): one swap with the Japanese example texts (read by the mock rules), and every text the
// server sends to the three screens is Japanese, with Japanese dates and amounts. English stays the default.
// Mock AI and mock PayPal only.

import { describe, expect, it } from 'vitest';
import { exampleTexts } from '../src/app/world.ts';
import { mockParse } from '../src/ai/mock.ts';
import { aPaysMock, decisionOf, harness, intake, loggedIn } from './app-helpers.ts';

const JA = /[぀-ヿ一-鿿]/;
const ja = async (c: { get: (s: string) => Promise<{ json: any }> }) => (await c.get('state?lang=ja')).json;

/** Every text a customer or the owner reads in a case must be Japanese (codes, names of models and amounts aside). */
function expectJapaneseCase(c: any) {
  expect(c.statusLabel).toMatch(JA);
  for (const s of [c.steps.bPayment, c.steps.aRefund, c.steps.authorizationRelease, c.steps.bRefund].filter(Boolean)) expect(s.text).toMatch(JA);
  expect(c.steps.bookings).toMatch(JA);
  for (const e of c.events) expect(e.text).toMatch(JA);
  for (const t of [c.origin, c.destination, c.bSlot, c.offerExpiresAt]) expect(t).toMatch(/^\d{1,2}月\d{1,2}日\([日月火水木金土]\) \d{2}:\d{2}/);
  expect(c.bPrice.text).toBe('60.00ドル');
  expect(c.aCompensation.text).toBe('10.00ドル');
}

describe('Japanese example texts', () => {
  it('the mock rules read them into the same windows as the English examples', () => {
    const base = '2026-11-07';
    const ctx = { today: base, timeZone: 'Asia/Tokyo', businessOpen: '10:00', businessClose: '18:00', services: [], stylists: [] } as never;
    const en = exampleTexts(base, 'en');
    const jp = exampleTexts(base, 'ja');
    expect(jp.a).toMatch(JA);
    expect(mockParse('A_PREFERENCE', jp.a, ctx)).toEqual(mockParse('A_PREFERENCE', en.a, ctx));
    expect(mockParse('B_REQUEST', jp.b, ctx).windows).toEqual(mockParse('B_REQUEST', en.b, ctx).windows);
    expect(mockParse('B_REQUEST', jp.b, ctx).questions).toEqual([]);
  });
});

describe('the three screens in Japanese', () => {
  it('one swap with Japanese input: all labels, steps, events, dates and amounts in Japanese', async () => {
    const h = harness();
    const w = await loggedIn(h);
    const a0 = await ja(w.a);
    expect(a0.header.shop).toMatchObject({ name: 'フレックスサロン', stylists: ['ミカ'], hours: '10:00〜18:00' });
    expect(a0.header.shop.services.map((s: any) => s.name)).toEqual(['カット', 'カット＋カラー']);
    expect(a0.header.shop.compensation.text).toBe('10.00ドル');
    expect(a0.booking).toMatchObject({ service: 'カット', stylist: 'ミカ', payment: { state: 'UNPAID', text: '未払い' } });
    expect(a0.booking.time).toMatch(/^\d{1,2}月\d{1,2}日\(.\) 14:00〜15:00$/);

    await aPaysMock(w.a);
    expect((await ja(w.a)).booking.payment).toEqual({ state: 'PAID', text: '支払い済み' });
    await intake(w.a, a0.header.examples.a, 'A');
    const a1 = await ja(w.a);
    expect(a1.preference).toMatchObject({ source: 'AI（模擬ルール）', compensation: { text: '10.00ドル' } });
    expect(a1.refundNote).toMatch(JA);

    const b0 = await ja(w.b);
    const bConfirm = await intake(w.b, b0.header.examples.b, 'B');
    expect(bConfirm.proposal).toMatchObject({ feasible: true });
    const b1 = await ja(w.b);
    expect(b1.request).toMatchObject({ service: 'カット', source: 'AI（模擬ルール）' });
    expect(b1.cases).toHaveLength(1);
    const cs = b1.cases[0];
    expect(cs.statusLabel).toBe('承認待ち');
    expectJapaneseCase(cs);

    const o1 = await ja(w.owner);
    expect(o1.cases[0].profit.additionalProfit.text).toBe('20.50ドル');
    for (const l of o1.cases[0].profit.lines) expect(l.name).toMatch(JA);
    expect(o1.cases[0].profit.note).toMatch(JA);
    expect(o1.bookings[0]).toMatchObject({ customer: 'お客さまA', service: 'カット' });
    expect(o1.bookings[0].payment).toMatch(/^支払い済み・COMPLETED・確認済み$/);
    expect(o1.evaluation.feasible).toBe(true);
    for (const e of o1.history) expect(['お店', 'お客さまA', 'お客さまB', 'システム', '自動処理']).toContain(e.actor);

    expect((await w.owner.post('cases/approve', decisionOf(cs))).status).toBe(200);
    expect((await w.a.post('cases/approve', decisionOf(cs))).status).toBe(200);
    expect((await w.b.post('cases/pay', decisionOf((await ja(w.b)).cases[0]))).json).toEqual({ approval: { kind: 'MOCK' } });
    expect((await ja(w.b)).cases[0].steps.bPayment).toEqual({ state: 'WAITING_BUYER', text: 'PayPalでの承認待ち' });
    expect((await w.b.post('cases/mock-approve', { caseId: cs.id })).status).toBe(200);
    await h.app.idle();
    await h.ticks(5);

    for (const s of [w.b, w.a, w.owner]) {
      const c = (await ja(s)).cases[0];
      expect(c).toMatchObject({ status: 'COMPLETED', statusLabel: '振替が完了しました' });
      expect(c.steps).toMatchObject({ bPayment: { state: 'DONE', text: '支払い済み' }, aRefund: { state: 'DONE', text: '返金済み' }, bookingsChanged: true });
      expectJapaneseCase(c);
      expect(c.events.map((e: any) => e.text)).toContain('予約を変更しました');
    }
    // English is still the default for the same world.
    expect((await w.b.state()).cases[0]).toMatchObject({ statusLabel: 'Swap completed', steps: { bPayment: { text: 'Paid' }, bookingsChanged: true } });
  });

  it('reasons why a request cannot be offered are Japanese', async () => {
    const h = harness();
    const w = await loggedIn(h);
    const b0 = await ja(w.b);
    // The same Japanese request, but A has neither paid nor registered conditions: no swap possible.
    const r = await intake(w.b, b0.header.examples.b, 'B');
    expect(r.proposal).toMatchObject({ feasible: false });
    const b1 = await ja(w.b);
    expect(b1.result.feasible).toBe(false);
    expect(b1.result.reasons.length).toBeGreaterThan(0);
    for (const reason of b1.result.reasons) expect(reason).toMatch(JA);
    const o = await ja(w.owner);
    for (const reason of o.evaluation.reasons) expect(reason.text).toMatch(JA);
  });
});
