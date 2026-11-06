// Temporary public access for a real-phone check (STATUS: real phone, plan 1). The server still listens on 127.0.0.1;
// a temporary HTTPS tunnel (approved by the owner each time) forwards to it. With FLEXSLOT_PUBLIC_ORIGIN set, main.ts
// runs in mock-only mode: it does not read .env and configures no PayPal Sandbox and no Vertex AI, so nothing anyone
// does through the public URL reaches a real API or costs money. The guard below also closes the webhook endpoint
// (no webhook id in this mode, nothing to verify) and caps how many demo worlds can be created.

import { fail, type Req, type Res } from './http.ts';

/** The tunnel's origin, e.g. https://name.trycloudflare.com: https, a host, nothing else (no path, query or port). */
export function parsePublicOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error('FLEXSLOT_PUBLIC_ORIGIN must be an https origin such as https://name.trycloudflare.com');
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new Error('FLEXSLOT_PUBLIC_ORIGIN must be an https origin such as https://name.trycloudflare.com');
  }
  return u.origin;
}

export const PUBLIC_MAX_WORLDS = 10;

/** Wraps the app's handler for the public mode: no webhook endpoint, at most PUBLIC_MAX_WORLDS new demo worlds. */
export function publicGuard(handle: (req: Req) => Promise<Res>, maxWorlds = PUBLIC_MAX_WORLDS): (req: Req) => Promise<Res> {
  let created = 0;
  return async (req) => {
    if (req.path === '/webhooks/paypal' || req.path.startsWith('/webhooks/')) return fail(404, 'NOT_FOUND');
    if (req.path === '/api/worlds' && req.method === 'POST') {
      if (created >= maxWorlds) return fail(429, 'WORLD_LIMIT');
      const res = await handle(req);
      if (res.status === 201) created += 1;
      return res;
    }
    return handle(req);
  };
}
