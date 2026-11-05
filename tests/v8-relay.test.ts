// The V8 relay lets exactly POST /webhooks/paypal through to FlexSlot and nothing else (STATUS "V8の実施計画").
// Local sockets only (127.0.0.1, ephemeral ports); no tunnel and no PayPal.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRelay } from '../scripts/verify/relay.ts';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function listen(s: Server): Promise<string> {
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function setup() {
  const seen: Array<{ method: string; url: string; headers: Record<string, unknown>; body: string }> = [];
  const upstream = await listen(
    createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"received":true,"internal":"x"}');
    }),
  );
  const relay = await listen(createRelay({ upstream }));
  return { relay, seen };
}

describe('V8 relay', () => {
  it('passes POST /webhooks/paypal with the PayPal headers and body only', async () => {
    const { relay, seen } = await setup();
    const res = await fetch(`${relay}/webhooks/paypal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 's', cookie: 'fs_session=x', 'x-csrf-token': 'y', origin: 'https://evil.example' },
      body: '{"id":"WH-1"}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"received":true}');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/webhooks/paypal', body: '{"id":"WH-1"}' });
    expect(seen[0]!.headers).toMatchObject({ 'paypal-transmission-id': 't1', 'paypal-transmission-sig': 's' });
    for (const h of ['cookie', 'x-csrf-token', 'origin']) expect(seen[0]!.headers[h]).toBeUndefined();
  });

  it('answers 404 to every other method and path, and never contacts FlexSlot for them', async () => {
    const { relay, seen } = await setup();
    const tries: Array<[string, string]> = [
      ['GET', '/'],
      ['GET', '/webhooks/paypal'],
      ['GET', '/api/config'],
      ['POST', '/api/worlds'],
      ['GET', '/w/w1/owner/'],
      ['POST', '/w/w1/a/api/session'],
      ['POST', '/webhooks/paypal?x=1'],
      ['POST', '/webhooks/paypal/'],
      ['POST', '/WEBHOOKS/PAYPAL'],
      ['PUT', '/webhooks/paypal'],
      ['GET', '/assets/index.js'],
    ];
    for (const [method, path] of tries) {
      const res = await fetch(`${relay}${path}`, { method, ...(method === 'GET' ? {} : { body: '{}' }) });
      expect([method, path, res.status]).toEqual([method, path, 404]);
    }
    expect(seen).toHaveLength(0);
  });

  it('refuses bodies over 64 KB without forwarding them', async () => {
    const { relay, seen } = await setup();
    const res = await fetch(`${relay}/webhooks/paypal`, { method: 'POST', body: 'x'.repeat(64 * 1024 + 1) });
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it('reports 502 when FlexSlot is not running (so PayPal retries)', async () => {
    const relay = await listen(createRelay({ upstream: 'http://127.0.0.1:9' }));
    const res = await fetch(`${relay}/webhooks/paypal`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(502);
  });
});
