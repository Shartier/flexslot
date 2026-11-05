// V8 relay (DESIGN 12.1, STATUS "V8の実施計画"): the only thing a public tunnel may reach. It passes exactly
// `POST /webhooks/paypal` (body up to 64 KB, PayPal's signature headers and the content type) to the local FlexSlot
// server and answers 404 to everything else, so the screens and APIs stay unreachable from outside.
// Logs carry method, path class and status only (no bodies, headers or ids).

import { createServer, type IncomingMessage, type Server } from 'node:http';

export const RELAY_PATH = '/webhooks/paypal';
export const RELAY_MAX_BODY = 64 * 1024;
const PASS_HEADERS = ['content-type', 'paypal-transmission-id', 'paypal-transmission-time', 'paypal-transmission-sig', 'paypal-cert-url', 'paypal-auth-algo'];

class TooLarge extends Error {}

async function read(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > RELAY_MAX_BODY) throw new TooLarge();
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export function createRelay(o: { upstream: string; log?: (line: Record<string, unknown>) => void }): Server {
  const log = o.log ?? (() => {});
  return createServer(async (req, res) => {
    const started = Date.now();
    const path = (req.url ?? '').split('?')[0];
    const send = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(body);
      log({ event: 'relay', method: req.method, path: path === RELAY_PATH ? RELAY_PATH : 'other', status, ms: Date.now() - started });
    };
    // Exactly one method and path; no query string either.
    if (req.method !== 'POST' || req.url !== RELAY_PATH) return send(404, '{"error":"NOT_FOUND"}');
    let body: Buffer;
    try {
      body = await read(req);
    } catch (e) {
      return send(e instanceof TooLarge ? 413 : 400, e instanceof TooLarge ? '{"error":"BODY_TOO_LARGE"}' : '{"error":"BAD_REQUEST"}');
    }
    const headers: Record<string, string> = {};
    for (const h of PASS_HEADERS) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    try {
      const up = await fetch(`${o.upstream}${RELAY_PATH}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
      // Pass the status (200 only after FlexSlot stored it); keep the answer short and generic.
      send(up.status, up.status === 200 ? '{"received":true}' : `{"error":"${up.status}"}`);
    } catch {
      send(502, '{"error":"UPSTREAM"}');
    }
  });
}
