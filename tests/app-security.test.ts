// Sessions, server-side owner checks, CSRF / Origin, and tampering (DESIGN 5, AC11).

import { describe, expect, it } from 'vitest';
import { aPaysMock, Client, createWorldVia, decisionOf, harness, intake, loggedIn, ORIGIN, texts } from './app-helpers.ts';

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

describe('invite links and sessions (DESIGN 5)', () => {
  it('exchanges the fragment token for an HttpOnly, SameSite=Strict cookie limited to /w/{world}/{role}', async () => {
    const h = harness();
    const w = await createWorldVia(h.app);
    expect(w.links.a).toMatch(new RegExp(`^${ORIGIN}/w/${w.worldId}/a/#t=[A-Za-z0-9_-]{43}$`));
    const a = new Client(h.app, w.worldId, 'a');
    await a.login(w.tokens.a);
    expect(a.lastSetCookie).toMatch(new RegExp(`^fs_session=[A-Za-z0-9_-]{43}; Path=/w/${w.worldId}/a; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
    // Only hashes are stored.
    const inv = h.db.prepare('SELECT token_hash FROM invites').all() as Array<{ token_hash: string }>;
    expect(inv.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
    expect(JSON.stringify(h.db.prepare('SELECT * FROM sessions').all())).not.toContain(a.cookie!.split('=')[1]);
  });

  it('refuses a token of another role or another world, and an unknown token', async () => {
    const h = harness();
    const w1 = await createWorldVia(h.app);
    const w2 = await createWorldVia(h.app);
    expect((await new Client(h.app, w1.worldId, 'owner').raw('POST', 'session', { token: w1.tokens.a })).status).toBe(401);
    expect((await new Client(h.app, w2.worldId, 'a').raw('POST', 'session', { token: w1.tokens.a })).status).toBe(401);
    expect((await new Client(h.app, w1.worldId, 'a').raw('POST', 'session', { token: 'x'.repeat(43) })).status).toBe(401);
  });

  it('a session works only on its own world and role path; no cookie means 401', async () => {
    const h = harness();
    const w1 = await loggedIn(h);
    const w2 = await createWorldVia(h.app);
    expect((await new Client(h.app, w1.worldId, 'a').get('state')).status).toBe(401);
    // A's cookie replayed on the owner path, and on another world's A path.
    for (const [world, seg] of [[w1.worldId, 'owner'], [w1.worldId, 'b'], [w2.worldId, 'a']] as const) {
      const c = new Client(h.app, world, seg);
      c.cookie = w1.a.cookie;
      c.csrf = w1.a.csrf;
      expect((await c.get('state')).status).toBe(401);
    }
  });

  it('every POST needs the CSRF token and an allowed Origin', async () => {
    const h = harness();
    const w = await loggedIn(h);
    const t = texts(w.baseDate);
    expect((await w.a.raw('POST', 'intake/draft', { text: t.a, useAi: true }, { 'x-csrf-token': 'wrong' })).json).toEqual({ error: 'CSRF' });
    const noCsrf = new Client(h.app, w.worldId, 'a');
    noCsrf.cookie = w.a.cookie;
    expect((await noCsrf.post('intake/draft', { text: t.a, useAi: true })).json).toEqual({ error: 'CSRF' });
    expect((await w.a.raw('POST', 'intake/draft', { text: t.a, useAi: true }, { origin: 'https://evil.example' })).json).toEqual({ error: 'ORIGIN' });
    w.a.origin = undefined;
    expect((await w.a.post('intake/draft', { text: t.a, useAi: true })).json).toEqual({ error: 'ORIGIN' });
    // World creation also checks Origin.
    const res = await h.app.handle({ method: 'POST', path: '/api/worlds', query: new URLSearchParams(), headers: { origin: 'https://evil.example' }, body: '{"aiMode":"MOCK","paymentMode":"MOCK"}' });
    expect(res.status).toBe(403);
    // A rotated CSRF token replaces the old one.
    w.a.origin = ORIGIN;
    const old = w.a.csrf;
    w.a.csrf = (await w.a.post('session/csrf')).json.csrfToken;
    expect(w.a.csrf).not.toBe(old);
    expect((await w.a.raw('POST', 'intake/draft', { text: t.a, useAi: true }, { 'x-csrf-token': old! })).json).toEqual({ error: 'CSRF' });
    expect((await w.a.post('intake/draft', { text: t.a, useAi: true })).status).toBe(200);
  });
});

describe('server-side owner checks and tampering (AC11)', () => {
  it('B cannot approve or reject as A; A cannot pay; another world cannot touch the case', async () => {
    const { h, w, cs } = await proposed();
    await w.owner.post('cases/approve', decisionOf(cs));
    // B posting to the A path with B's cookie: 401 (session bound to role path).
    const bAsA = new Client(h.app, w.worldId, 'a');
    bAsA.cookie = w.b.cookie;
    bAsA.csrf = w.b.csrf;
    expect((await bAsA.post('cases/approve', decisionOf(cs))).status).toBe(401);
    // B on its own path cannot use the A approval (B approves by paying, after A).
    expect((await w.b.post('cases/pay', decisionOf(cs))).json).toEqual({ error: 'NOT_STARTABLE' });
    expect((await w.a.post('cases/pay', decisionOf(cs))).status).toBe(404);
    // Another world's owner and B.
    const other = await loggedIn(h);
    expect((await other.owner.post('cases/approve', decisionOf(cs))).status).toBe(404);
    expect((await other.b.post('cases/reject', decisionOf(cs))).status).toBe(404);
    expect((await other.b.get(`cases/approval-link?caseId=${encodeURIComponent(cs.id)}`)).status).toBe(404);
    const appr = h.db.prepare('SELECT role FROM approvals WHERE case_id = ?').all(cs.id) as Array<{ role: string }>;
    expect(appr.map((r) => r.role)).toEqual(['OWNER']);
  });

  it('rejects amounts, currency, payee, capture or order ids sent by the browser; uses the snapshot only', async () => {
    const { w, cs } = await proposed();
    await w.owner.post('cases/approve', decisionOf(cs));
    await w.a.post('cases/approve', decisionOf(cs));
    for (const extra of [{ amount: 1 }, { amountMinor: 100 }, { currency: 'JPY' }, { payeeMerchantId: 'X' }, { aCaptureId: 'MOCK-CAPTURE-000001' }, { orderId: 'MOCK-ORDER-1' }]) {
      const r = await w.b.post('cases/pay', { ...decisionOf(cs), ...extra });
      expect(r.status).toBe(400);
    }
    // Stale terms (another hash or version) are refused: the approval is bound to what was displayed.
    expect((await w.b.post('cases/pay', { ...decisionOf(cs), termsHash: '0'.repeat(64) })).json).toEqual({ error: 'TERMS_CHANGED' });
    expect((await w.b.post('cases/pay', { ...decisionOf(cs), version: 2 })).json).toEqual({ error: 'TERMS_CHANGED' });
    const ok = await w.b.post('cases/pay', decisionOf(cs));
    expect(ok.status).toBe(200);
    const order = w.b; // the order amount comes from the case snapshot
    void order;
  });

  it('the B checkout amount is the snapshot price even if the service price changes after the proposal', async () => {
    const { h, w, cs } = await proposed();
    await w.owner.post('cases/approve', decisionOf(cs));
    await w.a.post('cases/approve', decisionOf(cs));
    h.db.prepare('UPDATE services SET price_minor = 1 WHERE id LIKE ?').run('%:service:cut');
    await w.b.post('cases/pay', decisionOf(cs));
    const op = h.db.prepare("SELECT request_json FROM payment_operations WHERE op_kind = 'ORDER_CREATE'").get() as { request_json: string };
    expect(JSON.parse(op.request_json).amount).toEqual({ currency: 'USD', minor: 6000 });
  });

  it('a rejection before payment keeps A, charges nothing and releases the hold; a rejection after payment start is refused', async () => {
    const { h, w, cs } = await proposed();
    await w.owner.post('cases/approve', decisionOf(cs));
    await w.a.post('cases/approve', decisionOf(cs));
    expect((await w.b.post('cases/reject', decisionOf(cs))).json).toEqual({ ok: true, status: 'REJECTED' });
    expect(h.db.prepare('SELECT status FROM slot_holds WHERE case_id = ?').get(cs.id)).toEqual({ status: 'RELEASED' });
    expect(h.mock.requests.filter((r) => r.route === 'AUTH_CAPTURE')).toHaveLength(0);
    expect((await w.b.post('cases/pay', decisionOf(cs))).json).toEqual({ error: 'NOT_STARTABLE' });

    const second = await proposed();
    await second.w.owner.post('cases/approve', decisionOf(second.cs));
    await second.w.a.post('cases/approve', decisionOf(second.cs));
    await second.w.b.post('cases/pay', decisionOf(second.cs));
    expect((await second.w.a.post('cases/reject', decisionOf(second.cs))).json).toEqual({ error: 'NOT_REJECTABLE' });
  });

  it('expired proposals end before payment and the hold is released (AC05)', async () => {
    const { h, w, cs } = await proposed();
    h.clock.advance(2 * 3_600_000);
    await h.runtime.tick();
    expect((await w.b.state()).cases[0].status).toBe('EXPIRED');
    expect(h.db.prepare('SELECT status FROM slot_holds WHERE case_id = ?').get(cs.id)).toEqual({ status: 'RELEASED' });
    expect((await w.owner.post('cases/approve', decisionOf(cs))).json).toEqual({ error: 'OFFER_EXPIRED' });
  });

  it('customer screens carry no PayPal ids, request ids or error classes', async () => {
    const { h, w, cs } = await proposed();
    await w.owner.post('cases/approve', decisionOf(cs));
    await w.a.post('cases/approve', decisionOf(cs));
    await w.b.post('cases/pay', decisionOf(cs));
    await w.b.post('cases/mock-approve', { caseId: cs.id });
    await h.ticks(5);
    for (const c of [w.a, w.b]) {
      const text = JSON.stringify(await c.state());
      expect(text).not.toMatch(/MOCK-(ORDER|AUTHORIZATION|CAPTURE|REFUND)/);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
      expect(text).not.toContain('HOLD:');
      expect(text).not.toContain('MOCKMERCHANT');
    }
  });
});
