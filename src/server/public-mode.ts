// Public mock demo (temporary phone tunnel or persistent single-instance hosting). With FLEXSLOT_PUBLIC_ORIGIN set, main.ts
// runs in mock-only mode: it does not read .env and configures no PayPal Sandbox and no Vertex AI, so nothing anyone
// does through the public URL reaches PayPal or Vertex APIs. Hosting still incurs its own charges. The guard closes the webhook endpoint
// (no webhook id in this mode, nothing to verify) and limits new demo worlds per time window.

import { fail, type Req, type Res } from './http.ts';
import type { Db } from '../db/database.ts';

/** Refuse a mistaken data mount before exposing any connected-mode records through a public server. */
export function assertPublicData(db: Db): void {
  const row = db.prepare("SELECT count(*) AS n FROM worlds WHERE mode_ai <> 'MOCK' OR mode_payment <> 'MOCK'").get() as { n: number };
  if (row.n !== 0) throw new Error('Public mode requires a dedicated mock-only database');
}

/** The public origin, e.g. https://demo.example.com: https, a host, nothing else (no path, query or port). */
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
export const PUBLIC_WINDOW_MS = 10 * 60_000;

/** Global creation budget; existing worlds remain usable. main.ts counts persisted worlds across process restarts. */
export function publicGuard(handle: (req: Req) => Promise<Res>, maxWorlds = PUBLIC_MAX_WORLDS,
  options: { now?: () => number; recentCount?: (since: number) => number } = {},
): (req: Req) => Promise<Res> {
  const now = options.now ?? Date.now;
  let created: number[] = [];
  let creating = 0;
  return async (req) => {
    if (req.path === '/webhooks/paypal' || req.path.startsWith('/webhooks/')) return fail(404, 'NOT_FOUND');
    if (req.path === '/api/worlds' && req.method === 'POST') {
      const since = now() - PUBLIC_WINDOW_MS;
      created = created.filter((at) => at > since);
      if ((options.recentCount?.(since) ?? created.length) + creating >= maxWorlds) {
        const res = fail(429, 'WORLD_LIMIT');
        res.headers['retry-after'] = String(PUBLIC_WINDOW_MS / 1000);
        return res;
      }
      creating += 1; // reserve before awaiting; parallel requests cannot overshoot the budget
      try {
        const res = await handle(req);
        if (res.status === 201 && !options.recentCount) created.push(now());
        return res;
      } finally {
        creating -= 1;
      }
    }
    return handle(req);
  };
}
