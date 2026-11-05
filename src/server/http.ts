// A small HTTP layer on node:http (DESIGN 2, D22): requests become plain objects so the app can be tested without
// sockets (inject), and every response carries the security headers (DESIGN 5).

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Req {
  /** The connection's remote address (for the webhook rate limit only). */
  remote?: string;
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

export interface Res {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
}

export const MAX_BODY_BYTES = 16 * 1024;
/** DESIGN 7.4: webhook bodies up to 64 KB are stored; one byte more is refused before reading on. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export class BodyTooLarge extends Error {}

/** Content-Security-Policy: scripts, styles and API calls only from this origin; nothing may frame the app. */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

export function json(status: number, data: unknown, extra: Record<string, string | string[]> = {}): Res {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }, body: JSON.stringify(data) };
}

export function fail(status: number, error: string, extra: Record<string, unknown> = {}): Res {
  return json(status, { error, ...extra });
}

export function parseCookies(header: string | undefined): Array<[string, string]> {
  if (!header) return [];
  return header
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? ([p, ''] as [string, string]) : ([p.slice(0, i).trim(), p.slice(i + 1).trim()] as [string, string]);
    });
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Adapts an inject-style handler to node:http. */
export function nodeHandler(handle: (req: Req) => Promise<Res>, log: (line: Record<string, unknown>) => void = () => {}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    let out: Res;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      const limit = url.pathname === '/webhooks/paypal' ? MAX_WEBHOOK_BODY_BYTES : MAX_BODY_BYTES;
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req, limit);
      out = await handle({ method: (req.method ?? 'GET').toUpperCase(), path: url.pathname, query: url.searchParams, headers, body, remote: req.socket.remoteAddress ?? 'unknown' });
    } catch (e) {
      out = e instanceof BodyTooLarge ? fail(413, 'BODY_TOO_LARGE') : fail(500, 'INTERNAL');
      if (!(e instanceof BodyTooLarge)) log({ event: 'http.error', error: e instanceof Error ? e.name : 'unknown' });
    }
    res.writeHead(out.status, { ...SECURITY_HEADERS, ...out.headers });
    res.end(req.method === 'HEAD' ? undefined : out.body);
    // Paths can carry world ids, never tokens (invite tokens live in the URL fragment and in POST bodies).
    log({ event: 'http', method: req.method, path: (req.url ?? '').split('?')[0], status: out.status, ms: Date.now() - started });
  };
}
