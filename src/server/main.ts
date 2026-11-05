// FlexSlot server entry point: one process, one SQLite file, the HTTP API and screens, the send queue and recovery
// (DESIGN 2). Listens on 127.0.0.1 only (no public exposure; DESIGN 11). Payment: PayPal Sandbox (if configured in
// .env) and the in-process mock; AI: Gemini on Vertex AI (if configured) and the mock rules. No Live PayPal code.
// Logs never contain secrets, tokens, request ids or customer text.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { systemClock } from '../clock.ts';
import { MissingConfigError } from '../config-error.ts';
import { openDatabase } from '../db/database.ts';
import { MockStructurer } from '../ai/mock.ts';
import { vertexStructurer, type AiStructurer } from '../ai/port.ts';
import { AiService } from '../ai/service.ts';
import { createVertexModels, loadVertexConfig } from '../ai/vertex.ts';
import { Executor } from '../executor/executor.ts';
import { createSandboxPayPal, loadPayPalConfig } from '../paypal/config.ts';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_MERCHANT_ID, MockPayPalServer, type MockState } from '../paypal/mock-server.ts';
import { MOCK_API_BASE, PayPalRestAdapter, type FetchLike } from '../paypal/rest.ts';
import type { PayPalPort } from '../paypal/port.ts';
import type { PaymentMode } from '../app/world.ts';
import { createApp } from './app.ts';
import { nodeHandler } from './http.ts';
import { Runtime } from './runtime.ts';
import { WebhookInbox } from '../app/webhooks.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), ...line }));

const envFile = join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const env = process.env;

const port = Number(env.FLEXSLOT_PORT ?? 8787);
const dataDir = resolve(ROOT, env.FLEXSLOT_DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true });
const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
const clock = systemClock;
const db = openDatabase(join(dataDir, 'flexslot.sqlite'));

// ---- payment: mock (always) and Sandbox (when .env has the credentials) --------------------------------------
const mockStateFile = join(dataDir, 'mock-paypal-state.json');
const mockServer = new MockPayPalServer({ clock });
if (existsSync(mockStateFile)) mockServer.importState(JSON.parse(readFileSync(mockStateFile, 'utf8')) as MockState);
const persistMock = () => {
  const tmp = `${mockStateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(mockServer.exportState()));
  renameSync(tmp, mockStateFile);
};
const mockFetch: FetchLike = async (url, init) => {
  try {
    return await mockServer.fetch(url, init);
  } finally {
    persistMock();
  }
};
const paypalLogger = (e: { event: string; mode: string; route: string; httpStatus?: number; outcome: string; durationMs: number }) => log({ ...e });
const paypal: Partial<Record<PaymentMode, PayPalPort>> = {
  MOCK: new PayPalRestAdapter({ mode: 'MOCK', apiBase: MOCK_API_BASE, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, fetch: mockFetch, clock, logger: paypalLogger }),
};
let sandboxPayee: string | null = null;
let webhookId: string | null = null;
try {
  const cfg = loadPayPalConfig(env);
  paypal.SANDBOX = createSandboxPayPal(cfg, { clock, logger: paypalLogger });
  sandboxPayee = cfg.expectedMerchantId ?? null;
  webhookId = cfg.webhookId ?? null;
} catch (e) {
  if (!(e instanceof MissingConfigError)) throw e; // a non-Sandbox PAYPAL_API_BASE stops the server here
  log({ event: 'config', paypalSandbox: 'not configured', missing: e.missing });
}

// ---- AI: Vertex (when configured) and the mock rules ----------------------------------------------------------
let vertex: AiStructurer | null = null;
try {
  const cfg = loadVertexConfig(env);
  vertex = vertexStructurer(createVertexModels(cfg), cfg.model);
} catch (e) {
  if (!(e instanceof MissingConfigError)) throw e;
  log({ event: 'config', vertex: 'not configured', missing: e.missing });
}
const ai = new AiService({ db, clock, vertex, mock: new MockStructurer() });

const executors: Partial<Record<PaymentMode, Executor>> = {};
for (const mode of Object.keys(paypal) as PaymentMode[]) {
  executors[mode] = new Executor({ db, paypal: paypal[mode]!, clock, returnUrl: `${origins[0]}/paypal/return`, cancelUrl: `${origins[0]}/paypal/cancel` });
}

const app = createApp({
  db,
  clock,
  origins,
  ai,
  executors,
  paypal,
  mockServer,
  sandboxPayee,
  mockPayee: MOCK_MERCHANT_ID,
  staticDir: join(ROOT, 'dist', 'web'),
  log,
});
// DESIGN 7.4: webhooks come only from the Sandbox; without PAYPAL_WEBHOOK_ID they are stored but never used.
const runtimeRef: { current: Runtime | null } = { current: null };
const webhooks = new WebhookInbox({ db, clock, paypal: paypal.SANDBOX ?? null, webhookId, onOrderApproved: (id) => runtimeRef.current?.orderApproved(id), log });
const runtime = new Runtime({ db, clock, executors, paypal, log, webhooks });
runtimeRef.current = runtime;

await runtime.startup();
runtime.start();
const server = createServer(nodeHandler(app.handle, log));
server.listen(port, '127.0.0.1', () => {
  log({
    event: 'listening',
    url: origins[0],
    payment: { sandbox: !!executors.SANDBOX, sandboxPayeeSet: sandboxPayee !== null, mock: true },
    ai: { vertexModel: ai.vertexModel, mockModel: ai.mockModel },
  });
});

const shutdown = () => {
  runtime.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
