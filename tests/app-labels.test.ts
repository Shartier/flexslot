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
      expect(c.events.map((e: { text: string }) => e.text)).toContain('The final check before charging failed, so the payment is cancelled');
      expect(c.events.map((e: { text: string }) => e.text).join(' ')).not.toContain('declined');
    }
    const bc = (await w.b.state()).cases[0];
    expect(bc.steps.authorizationRelease).toMatchObject({ state: 'DONE' });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM payment_operations WHERE op_kind = 'AUTH_CAPTURE'").get()).toEqual({ n: 0 });
  });
});
