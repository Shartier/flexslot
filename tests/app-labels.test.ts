// Case status labels on the screens for the two ways a case ends as REJECTED (mock AI, mock PayPal only):
// a party declined, or the executor released the authorization (E-V) without anyone declining. Found during the
// Sandbox interruption check R4, where the E-V screen read "Not completed (declined)" although nobody declined.

import { describe, expect, it } from 'vitest';
import { idsFor } from '../src/app/world.ts';
import { aPaysMock, decisionOf, harness, intake, loggedIn, texts } from './app-helpers.ts';

async function proposed() {
  const h = harness();
  const w = await loggedIn(h);
  const t = texts(w.baseDate);
  await aPaysMock(w.a);
  await intake(w.a, t.a, 'A');
  await intake(w.b, t.b, 'B');
  const cs = (await w.b.state()).cases[0];
  return { h, w, cs };
}

describe('REJECTED labels', () => {
  it('a party declined: "Not completed (declined)" on all three screens', async () => {
    const { w, cs } = await proposed();
    expect((await w.b.post('cases/reject', decisionOf(cs))).json).toEqual({ ok: true, status: 'REJECTED' });
    for (const s of [w.b, w.a, w.owner]) expect((await s.state()).cases[0]).toMatchObject({ status: 'REJECTED', statusLabel: 'Not completed (declined)' });
  });

  it('E-V (pre-capture check failed, authorization released): no "declined", the timeline says why', async () => {
    const { h, w, cs } = await proposed();
    expect((await w.owner.post('cases/approve', decisionOf(cs))).status).toBe(200);
    expect((await w.a.post('cases/approve', decisionOf(cs))).status).toBe(200);
    const b = (await w.b.state()).cases[0];
    expect((await w.b.post('cases/pay', decisionOf(b))).json).toEqual({ approval: { kind: 'MOCK' } });
    // The same fault as R4: A's booking changes after the terms were frozen (labelled fault, not a real path).
    h.db.prepare('UPDATE bookings SET version = version + 1 WHERE id = ?').run(idsFor(w.worldId).aBookingId);
    expect((await w.b.post('cases/mock-approve', { caseId: cs.id })).status).toBe(200);
    await h.app.idle();
    await h.ticks(5);

    for (const s of [w.b, w.a, w.owner]) {
      const c = (await s.state()).cases[0];
      expect(c).toMatchObject({ status: 'REJECTED', statusLabel: 'Not completed · authorization released' });
      expect(c.statusLabel).not.toContain('declined');
      expect(c.events.map((e: { text: string }) => e.text)).toContain('The final check failed. FlexSlot will not capture this payment; see the authorization release status');
      expect(c.events.map((e: { text: string }) => e.text).join(' ')).not.toContain('declined');
    }
    const bc = (await w.b.state()).cases[0];
    expect(bc.steps.authorizationRelease).toMatchObject({ state: 'DONE' });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM payment_operations WHERE op_kind = 'AUTH_CAPTURE'").get()).toEqual({ n: 0 });
  });

  // IR2-01 (Codex): the failed final check is recorded before the release is even requested, so no screen may say
  // the payment is cancelled or the authorization released until the release is confirmed.
  async function toFailedCheck(fault: { type: 'HTTP_ERROR'; status: number } | { type: 'RESPONSE_LOST' }) {
    const { h, w, cs } = await proposed();
    expect((await w.owner.post('cases/approve', decisionOf(cs))).status).toBe(200);
    expect((await w.a.post('cases/approve', decisionOf(cs))).status).toBe(200);
    expect((await w.b.post('cases/pay', decisionOf((await w.b.state()).cases[0]))).status).toBe(200);
    h.db.prepare('UPDATE bookings SET version = version + 1 WHERE id = ?').run(idsFor(w.worldId).aBookingId);
    h.mock.inject('AUTH_VOID', fault);
    expect((await w.b.post('cases/mock-approve', { caseId: cs.id })).status).toBe(200);
    await h.app.idle();
    return { h, w };
  }
  const noReleaseClaim = (c: { statusLabel: string; events: Array<{ text: string }>; steps: { authorizationRelease: { state: string; text: string } | null } }) => {
    const all = [c.statusLabel, ...c.events.map((e) => e.text), c.steps.authorizationRelease?.text ?? ''].join(' | ');
    expect(all).not.toMatch(/released|cancelled|canceled|取り消しました|取り消し済み/i);
    expect(c.steps.authorizationRelease?.state).not.toBe('DONE');
  };

  it('release refused (422): the timeline and steps never say released or cancelled', async () => {
    const { h, w } = await toFailedCheck({ type: 'HTTP_ERROR', status: 422 });
    await h.ticks(3);
    for (const s of [w.b, w.a, w.owner]) {
      const c = (await s.state()).cases[0];
      expect(c.status).toBe('VOID_PENDING');
      expect(c.steps.authorizationRelease).toMatchObject({ state: 'ATTENTION' });
      noReleaseClaim(c);
      const ja = (await s.get('state?lang=ja')).json.cases[0];
      noReleaseClaim(ja);
    }
  });

  it('release answer lost: while the result is unknown nothing says released; once confirmed it does', async () => {
    const { h, w } = await toFailedCheck({ type: 'RESPONSE_LOST' });
    for (const s of [w.b, w.a, w.owner]) {
      const c = (await s.state()).cases[0];
      expect(c.status).toBe('VOID_PENDING');
      expect(c.steps.authorizationRelease).toMatchObject({ state: 'WORKING', text: 'Checking the result with PayPal' });
      noReleaseClaim(c);
    }
    await h.ticks(5);
    const c = (await w.b.state()).cases[0];
    expect(c).toMatchObject({ status: 'REJECTED', statusLabel: 'Not completed · authorization released', steps: { authorizationRelease: { state: 'DONE', text: 'Authorization released' } } });
  });
});
