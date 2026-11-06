// View-only screen server for the interruption checks (R5): shows the three screens of an existing database while a
// run is stopped, without moving it on. Unlike src/server/main.ts it has no runtime (no startup recovery, no queue,
// no webhook loop), no executors and no PayPal adapter, and it refuses every POST except the invite exchange and the
// CSRF refresh of a screen. So looking at a paused run cannot send, query or change anything at PayPal, and changes
// nothing in the run's tables (only sessions and the session audit line are written).
//
//   FLEXSLOT_DATA_DIR=data/interrupts FLEXSLOT_PORT=8788 node scripts/verify/view-server.ts
//
// Listens on 127.0.0.1 only. Verification tool; not part of the app.

import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { systemClock } from '../../src/clock.ts';
import { openDatabase } from '../../src/db/database.ts';
import { MockStructurer } from '../../src/ai/mock.ts';
import { AiService } from '../../src/ai/service.ts';
import { MOCK_MERCHANT_ID } from '../../src/paypal/mock-server.ts';
import { createApp } from '../../src/server/app.ts';
import { nodeHandler, type Req, type Res } from '../../src/server/http.ts';
import { ROOT } from './_lib.ts';

const port = Number(process.env.FLEXSLOT_PORT ?? 8788);
const dataDir = resolve(ROOT, process.env.FLEXSLOT_DATA_DIR ?? 'data/interrupts');
const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), viewOnly: true, ...line }));

const db = openDatabase(join(dataDir, 'flexslot.sqlite'));
const ai = new AiService({ db, clock: systemClock, vertex: null, mock: new MockStructurer() });
const app = createApp({
  db, clock: systemClock, origins, ai, executors: {}, paypal: {}, mockServer: null, sandboxPayee: null, mockPayee: MOCK_MERCHANT_ID, staticDir: join(ROOT, 'dist', 'web'), log,
});

/** Only the screens' sign-in (invite exchange) and CSRF refresh may POST; everything else that writes is refused. */
const POST_ALLOWED = /^\/w\/[^/]+\/(owner|a|b)\/api\/session(\/csrf)?$/;
async function handle(req: Req): Promise<Res> {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !(req.method === 'POST' && POST_ALLOWED.test(req.path))) {
    log({ event: 'refused', method: req.method, path: req.path.replace(/^\/w\/[^/]+/, '/w/{world}') });
    return { status: 409, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'VIEW_ONLY' }) };
  }
  return app.handle(req);
}

createServer(nodeHandler(handle, log)).listen(port, '127.0.0.1', () => log({ event: 'listening', url: origins[0], dataDir: dataDir.replace(ROOT, '.') }));
