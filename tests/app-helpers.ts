// Test harness for the HTTP app (DESIGN 14.5): the app's inject handler, the in-process mock PayPal, a fake
// "Sandbox" adapter (the SANDBOX-mode REST adapter on a second mock server with non-MOCK ids, no network),
// the mock AI, and a browser-like client that keeps its cookie and CSRF token. Nothing here reaches the network.

import { MockStructurer } from '../src/ai/mock.ts';
import { vertexStructurer, type AiStructurer } from '../src/ai/port.ts';
import { AiService, type AiLimits } from '../src/ai/service.ts';
import type { GenerateContentLike } from '../src/ai/vertex.ts';
import { ManualClock } from '../src/clock.ts';
import { openDatabase, type Db } from '../src/db/database.ts';
import type { ExecutorHooks } from '../src/executor/engine.ts';
import { Executor } from '../src/executor/executor.ts';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_MERCHANT_ID, MockPayPalServer } from '../src/paypal/mock-server.ts';
import type { PayPalPort } from '../src/paypal/port.ts';
import { MOCK_API_BASE, PayPalRestAdapter, SANDBOX_API_BASE } from '../src/paypal/rest.ts';
import { createApp, type App } from '../src/server/app.ts';
import type { Req, Res } from '../src/server/http.ts';
import { Runtime } from '../src/server/runtime.ts';
import { WebhookInbox } from '../src/app/webhooks.ts';
import type { PaymentMode } from '../src/app/world.ts';
import { SAMPLE_NOW_MS } from '../src/sample.ts';

export const ORIGIN = 'http://localhost:8787';
export const FAKE_SANDBOX_PAYEE = 'MOCKMERCHANT01';

export interface Harness {
  app: App;
  db: Db;
  clock: ManualClock;
  mock: MockPayPalServer;
  /** Second mock server behind a SANDBOX-mode adapter (ids "SBX-"), standing in for the Sandbox in tests. */
  fakeSandbox: MockPayPalServer;
  executors: Partial<Record<PaymentMode, Executor>>;
  paypal: Partial<Record<PaymentMode, PayPalPort>>;
  runtime: Runtime;
  /** DESIGN 7.4 inbox, verifying with the fake Sandbox (webhook id "WH-TEST" unless given). */
  inbox: WebhookInbox;
  ai: AiService;
  /** Runs queue ticks (advancing the clock a little each time) until nothing changes or `n` ticks. */
  ticks(n?: number): Promise<void>;
}

export function harness(
  o: { db?: Db; clock?: ManualClock; vertex?: GenerateContentLike | null; limits?: AiLimits; mock?: MockPayPalServer; fakeSandbox?: MockPayPalServer; owner?: string; webhookId?: string | null; webhookRate?: number; hooks?: ExecutorHooks } = {},
): Harness {
  const clock = o.clock ?? new ManualClock(SAMPLE_NOW_MS);
  const db = o.db ?? openDatabase(':memory:');
  const mock = o.mock ?? new MockPayPalServer({ clock });
  const fakeSandbox = o.fakeSandbox ?? new MockPayPalServer({ clock, testIdPrefix: 'SBX-' });
  const paypal: Partial<Record<PaymentMode, PayPalPort>> = {
    MOCK: new PayPalRestAdapter({ mode: 'MOCK', apiBase: MOCK_API_BASE, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, fetch: mock.fetch, clock, timeoutMs: 50 }),
    SANDBOX: new PayPalRestAdapter({ mode: 'SANDBOX', apiBase: SANDBOX_API_BASE, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, fetch: fakeSandbox.fetch, clock, timeoutMs: 50 }),
  };
  const owner = o.owner ?? 'exec-app';
  const executors: Partial<Record<PaymentMode, Executor>> = {
    MOCK: new Executor({ db, paypal: paypal.MOCK!, clock, owner: `${owner}-mock`, ...(o.hooks ? { hooks: o.hooks } : {}), returnUrl: `${ORIGIN}/paypal/return`, cancelUrl: `${ORIGIN}/paypal/cancel` }),
    SANDBOX: new Executor({ db, paypal: paypal.SANDBOX!, clock, owner: `${owner}-sbx`, ...(o.hooks ? { hooks: o.hooks } : {}), returnUrl: `${ORIGIN}/paypal/return`, cancelUrl: `${ORIGIN}/paypal/cancel` }),
  };
  const vertex: AiStructurer | null = o.vertex ? vertexStructurer(o.vertex, 'gemini-test', 50) : null;
  const ai = new AiService({ db, clock, vertex, mock: new MockStructurer(), ...(o.limits ? { limits: o.limits } : {}) });
  const app = createApp({
    db, clock, origins: [ORIGIN], ai, executors, paypal, mockServer: mock, sandboxPayee: FAKE_SANDBOX_PAYEE, mockPayee: MOCK_MERCHANT_ID, staticDir: null,
    ...(o.webhookRate ? { webhookRatePerMinute: o.webhookRate } : {}),
  });
  const ref: { runtime: Runtime | null } = { runtime: null };
  const inbox = new WebhookInbox({ db, clock, paypal: paypal.SANDBOX!, webhookId: o.webhookId === undefined ? 'WH-TEST' : o.webhookId, onOrderApproved: (id) => ref.runtime?.orderApproved(id) });
  const runtime = new Runtime({ db, clock, executors, paypal, webhooks: inbox });
  ref.runtime = runtime;
  return {
    app, db, clock, mock, fakeSandbox, executors, paypal, runtime, ai, inbox,
    async ticks(n = 30) {
      for (let i = 0; i < n; i++) {
        await app.idle();
        await runtime.webhookTick();
        await runtime.tick();
        clock.advance(11_000);
      }
      await app.idle();
    },
  };
}

/** A browser tab for one role: cookie jar of one cookie, the CSRF token, and the Origin header. */
export class Client {
  cookie: string | null = null;
  csrf: string | null = null;
  readonly #app: App;
  readonly base: string;
  origin: string | undefined = ORIGIN;
  lastSetCookie: string | null = null;

  constructor(app: App, worldId: string, roleSeg: 'owner' | 'a' | 'b') {
    this.#app = app;
    this.base = `/w/${worldId}/${roleSeg}`;
  }

  async raw(method: string, sub: string, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Res & { json: any }> {
    const [path, qs] = `${this.base}/api/${sub}`.split('?');
    const req: Req = {
      method,
      path: path!,
      query: new URLSearchParams(qs ?? ''),
      headers: {
        ...(this.origin ? { origin: this.origin } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf && method === 'POST' ? { 'x-csrf-token': this.csrf } : {}),
        ...headers,
      },
      body: body === undefined ? '' : JSON.stringify(body),
    };
    const res = await this.#app.handle(req);
    const setCookie = res.headers['set-cookie'];
    if (typeof setCookie === 'string') {
      this.lastSetCookie = setCookie;
      this.cookie = setCookie.split(';')[0]!;
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(String(res.body));
    } catch {
      parsed = null;
    }
    return { ...res, json: parsed };
  }

  async login(token: string): Promise<void> {
    const r = await this.raw('POST', 'session', { token });
    if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.json)}`);
    this.csrf = r.json.csrfToken;
  }

  get = (sub: string) => this.raw('GET', sub);
  post = (sub: string, body: unknown = {}) => this.raw('POST', sub, body);
  state = async () => (await this.get('state')).json;
}

export async function createWorldVia(app: App, o: { aiMode?: 'VERTEX' | 'MOCK'; paymentMode?: 'SANDBOX' | 'MOCK' } = {}) {
  const res = await app.handle({
    method: 'POST',
    path: '/api/worlds',
    query: new URLSearchParams(),
    headers: { origin: ORIGIN },
    body: JSON.stringify({ aiMode: o.aiMode ?? 'MOCK', paymentMode: o.paymentMode ?? 'MOCK' }),
  });
  if (res.status !== 201) throw new Error(`world: ${res.status} ${String(res.body)}`);
  const w = JSON.parse(String(res.body)) as { worldId: string; baseDate: string; links: Record<'owner' | 'a' | 'b', string> };
  const token = (link: string) => new URL(link).hash.replace('#t=', '');
  return { worldId: w.worldId, baseDate: w.baseDate, links: w.links, tokens: { owner: token(w.links.owner), a: token(w.links.a), b: token(w.links.b) } };
}

export async function loggedIn(h: Harness, o: { aiMode?: 'VERTEX' | 'MOCK'; paymentMode?: 'SANDBOX' | 'MOCK' } = {}) {
  const w = await createWorldVia(h.app, o);
  const owner = new Client(h.app, w.worldId, 'owner');
  const a = new Client(h.app, w.worldId, 'a');
  const b = new Client(h.app, w.worldId, 'b');
  await owner.login(w.tokens.owner);
  await a.login(w.tokens.a);
  await b.login(w.tokens.b);
  return { ...w, owner, a, b };
}

/** SPEC 4 texts relative to the world's base date (SAMPLE_NOW = 2026-11-03 -> A on 11-05, A moves on 11-08). */
export const texts = (baseDate: string) => {
  const day = (n: number) => {
    const t = new Date(`${baseDate}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + n);
    return t.toISOString().slice(0, 10);
  };
  return {
    aDay: day(2),
    moveDay: day(5),
    a: `I can move to ${day(5)} if my cut is done between 10:00 and 12:00.`,
    b: `I need a cut on ${day(2)}, and only 14:00-15:00 works for me.`,
  };
};

/** A pays its booking in mock mode (A screen: pay -> mock approval). */
export async function aPaysMock(a: Client): Promise<void> {
  const s = await a.post('payment/start');
  if (s.status !== 200) throw new Error(`payment/start ${s.status} ${JSON.stringify(s.json)}`);
  const r = await a.post('payment/mock-approve');
  if (r.status !== 200 || !r.json.paid) throw new Error(`mock-approve ${r.status} ${JSON.stringify(r.json)}`);
}

/** Free text -> AI draft -> confirm the proposal unchanged. */
export async function intake(c: Client, text: string, role: 'A' | 'B') {
  const d = await c.post('intake/draft', { text, useAi: true });
  if (d.status !== 200) throw new Error(`draft ${d.status} ${JSON.stringify(d.json)}`);
  const st = await c.state();
  const p = st.draft.proposal;
  const body = role === 'A' ? { draftId: st.draft.id, windows: p.windows } : { draftId: st.draft.id, windows: p.windows, serviceId: p.serviceId, stylistId: p.stylistId };
  const r = await c.post('intake/confirm', body);
  if (r.status !== 200) throw new Error(`confirm ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

export const decisionOf = (cs: { id: string; version: number; termsHash: string }) => ({ caseId: cs.id, version: cs.version, termsHash: cs.termsHash });
