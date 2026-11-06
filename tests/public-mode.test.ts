// Public mode for the real-phone check (src/server/public-mode.ts): the tunnel origin's parsing, invite links and
// cookies under that origin, and the guard (no webhook endpoint, capped world creation). Mock only, no network.

import { describe, expect, it } from 'vitest';
import type { Req } from '../src/server/http.ts';
import { parsePublicOrigin, publicGuard } from '../src/server/public-mode.ts';
import { Client, harness, ORIGIN } from './app-helpers.ts';

const PUB = 'https://quiet-river-test.trycloudflare.com';

const req = (method: string, path: string, origin: string | undefined, body: unknown = {}): Req => ({
  method,
  path,
  query: new URLSearchParams(),
  headers: { ...(origin ? { origin } : {}), 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const newWorld = (origin: string | undefined) => req('POST', '/api/worlds', origin, { aiMode: 'MOCK', paymentMode: 'MOCK' });

describe('parsePublicOrigin', () => {
  it('accepts an https origin only', () => {
    expect(parsePublicOrigin(undefined)).toBeNull();
    expect(parsePublicOrigin('')).toBeNull();
    expect(parsePublicOrigin(PUB)).toBe(PUB);
    expect(parsePublicOrigin(`${PUB}/`)).toBe(PUB);
    for (const bad of ['http://quiet-river-test.trycloudflare.com', `${PUB}/w/x`, `${PUB}:8443`, `${PUB}?a=1`, `${PUB}#x`, 'https://user:pw@example.com', 'not a url']) {
      expect(() => parsePublicOrigin(bad), bad).toThrow(/FLEXSLOT_PUBLIC_ORIGIN/);
    }
  });
});

describe('the app under a public origin, behind the guard', () => {
  it('invite links use the public origin; the cookie is Secure; foreign origins are still refused', async () => {
    const h = harness({ origins: [PUB, ORIGIN] });
    const handle = publicGuard(h.app.handle);
    const created = await handle(newWorld(PUB));
    expect(created.status).toBe(201);
    const w = JSON.parse(String(created.body)) as { worldId: string; links: Record<string, string> };
    for (const link of Object.values(w.links)) expect(link.startsWith(`${PUB}/w/${w.worldId}/`)).toBe(true);

    const a = new Client(h.app, w.worldId, 'a');
    a.origin = PUB;
    await a.login(new URL(w.links.a!).hash.replace('#t=', ''));
    expect(a.lastSetCookie).toMatch(/; HttpOnly; SameSite=Strict; .*; Secure$/);
    expect((await a.post('session/csrf')).status).toBe(200);
    a.origin = 'https://evil.example';
    expect((await a.post('session/csrf')).status).toBe(403);
    a.origin = ORIGIN;
    expect((await a.post('session/csrf')).status).toBe(200);

    expect((await handle(newWorld('https://evil.example'))).status).toBe(403);
  });

  it('closes the webhook endpoint and caps new worlds (refused attempts do not count)', async () => {
    const h = harness({ origins: [PUB, ORIGIN] });
    expect((await h.app.handle(req('POST', '/webhooks/paypal', undefined, { id: 'x' }))).status).toBe(200);
    const handle = publicGuard(h.app.handle, 2);
    expect((await handle(req('POST', '/webhooks/paypal', undefined, { id: 'x' }))).status).toBe(404);
    expect((await handle(req('GET', '/webhooks/paypal', undefined))).status).toBe(404);
    expect((await handle(newWorld('https://evil.example'))).status).toBe(403);
    expect((await handle(newWorld(PUB))).status).toBe(201);
    expect((await handle(newWorld(ORIGIN))).status).toBe(201);
    const third = await handle(newWorld(PUB));
    expect(third.status).toBe(429);
    expect(JSON.parse(String(third.body))).toEqual({ error: 'WORLD_LIMIT' });
    expect((await handle(req('GET', '/api/config', undefined))).status).toBe(200);
  });
});
