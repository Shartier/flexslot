// AC08 / AC09 on the PayPal Sandbox (Codex second review, "next steps" 2-3): interruptions after money moved, the
// void path (E-V) and the full refund of B (E-R), driven through the real executor against the Sandbox.
// - "Process stops" are real: the process exits at an executor crash point; the next phase is a new process that
//   starts with startup recovery, after the 60 s lease has run out (as after a real restart).
// - Lost answers are injected in front of the Sandbox: the request reaches PayPal and is processed, then the
//   answer is dropped ("RESPONSE_LOST"). A refused refund is injected without sending ("REJECT_422").
// - DB faults that the Sandbox cannot produce (A's booking changed while the process was down) are SQL updates.
// Every injected fault is printed and recorded as such; none of them is a Sandbox failure.
// The worlds live in their own database (data/interrupts or data/interrupts-mock), never in the app's.
//
//   node scripts/verify/interrupts.ts prepare R1 R2 R3 R4   # worlds, A's orders (prints approval URLs), cases
//   node scripts/verify/interrupts.ts start R1               # B's order (prints the URL), authorize, phase 1
//   node scripts/verify/interrupts.ts resume R1              # next phase (new process, after the lease ran out)
//   node scripts/verify/interrupts.ts report R1              # DB and Sandbox queries for the run
//   node scripts/verify/interrupts.ts owner-recover R2       # the owner's "Recover" (R2; the screen does the same)
//   node scripts/verify/interrupts.ts screens R5             # what the three screens show now (same view functions)
// R5 stops at every state in between (capture unknown, before E7, after E7, refund unknown) so that the screens can
// be looked at while the run is stopped, with scripts/verify/view-server.ts (no recovery, no queue, no PayPal).
// Runs must not overlap: finish one run (all phases) before starting the next.
// FLEXSLOT_INTERRUPTS_MOCK=1 runs the same against the in-process mock (no network, approvals by the mock).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../src/clock.ts';
import { openDatabase, type Db } from '../../src/db/database.ts';
import { MockStructurer } from '../../src/ai/mock.ts';
import { AiService } from '../../src/ai/service.ts';
import { approveCase, proposeInTx } from '../../src/app/cases.ts';
import { customerView, ownerView } from '../../src/app/views.ts';
import { confirmDraft, createDraft } from '../../src/app/intake.ts';
import { addDays, createWorld, idsFor } from '../../src/app/world.ts';
import type { ExecutorHooks } from '../../src/executor/engine.ts';
import { Executor } from '../../src/executor/executor.ts';
import { getCase } from '../../src/executor/store.ts';
import { createSandboxPayPal, loadPayPalConfig } from '../../src/paypal/config.ts';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_MERCHANT_ID, MockPayPalServer, type MockState } from '../../src/paypal/mock-server.ts';
import type { PayPalPort } from '../../src/paypal/port.ts';
import { approvalUrl, MOCK_API_BASE, PayPalRestAdapter, type FetchLike } from '../../src/paypal/rest.ts';
import { anon, loadDotEnv, NotReady, ROOT, run } from './_lib.ts';

const MOCK = process.env.FLEXSLOT_INTERRUPTS_MOCK === '1';
const MODE = MOCK ? 'MOCK' : 'SANDBOX';
const DATA = join(ROOT, 'data', MOCK ? 'interrupts-mock' : 'interrupts');
const STATE_DIR = join(ROOT, 'work', 'verify', MOCK ? 'interrupts-mock' : 'interrupts');
const LEASE_WAIT_MS = 61_000;
const clock = systemClock;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = (id: string | null | undefined) => (id ? createHash('sha256').update(id).digest('hex').slice(0, 8) : '-');

type Fault = 'RESPONSE_LOST' | 'REJECT_422';
type RunId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

interface RunState {
  run: RunId;
  worldId: string;
  tokens: Record<string, string>;
  caseId: string | null;
  phase: number;
  crashedAt: number | null;
  log: Array<{ at: string; phase: number; event: string; route?: string; requestId?: string; detail?: string }>;
}

const SCENARIO: Record<RunId, string> = {
  R1: 'B capture answer lost -> stop before E7 -> stop after E7 -> A refund answer lost',
  R2: 'stop right after the capture success is saved (before reconciliation) -> A refund refused (422, injected) -> owner recovery',
  R3: 'stop before E7 -> A booking changed while stopped (SQL) -> E7 impossible -> B full refund (E-R)',
  R4: 'authorized -> A booking changed (SQL) -> pre-capture check fails -> void (E-V)',
  R5: 'stops for the screens: B capture answer lost -> stop -> stop before E7 -> stop after E7 -> A refund answer lost -> stop -> completes',
};

// ---- state, db, PayPal ---------------------------------------------------------------------------------------------

const statePath = (r: RunId) => join(STATE_DIR, `${r}.json`);
function loadState(r: RunId): RunState {
  if (!existsSync(statePath(r))) throw new NotReady(`no state for ${r}; run "prepare ${r}" first`);
  return JSON.parse(readFileSync(statePath(r), 'utf8')) as RunState;
}
function saveState(s: RunState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(s.run), `${JSON.stringify(s, null, 2)}\n`);
}
function note(s: RunState, event: string, extra: Partial<RunState['log'][number]> = {}): void {
  s.log.push({ at: new Date().toISOString(), phase: s.phase, event, ...extra });
  saveState(s);
}

function openDb(): Db {
  mkdirSync(DATA, { recursive: true });
  return openDatabase(join(DATA, 'flexslot.sqlite'));
}

const ROUTES: Array<[string, RegExp, string]> = [
  ['POST', /\/v2\/checkout\/orders$/, 'ORDER_CREATE'],
  ['POST', /\/v2\/checkout\/orders\/[^/]+\/authorize$/, 'ORDER_AUTHORIZE'],
  ['POST', /\/v2\/checkout\/orders\/[^/]+\/capture$/, 'ORDER_CAPTURE'],
  ['POST', /\/v2\/payments\/authorizations\/[^/]+\/capture$/, 'AUTH_CAPTURE'],
  ['POST', /\/v2\/payments\/authorizations\/[^/]+\/void$/, 'AUTH_VOID'],
  ['POST', /\/v2\/payments\/captures\/[^/]+\/refund$/, 'CAPTURE_REFUND'],
];

let mockServer: MockPayPalServer | null = null;
const mockStateFile = join(STATE_DIR, 'mock-paypal-state.json');

/** The PayPal adapter with injected faults in front of it, recording every money POST (route + request id). */
function paypalFor(s: RunState | null, faults: Map<string, Fault[]>): { port: PayPalPort; payee: string } {
  let inner: FetchLike;
  let payee: string;
  if (MOCK) {
    mockServer = new MockPayPalServer({ clock });
    if (existsSync(mockStateFile)) mockServer.importState(JSON.parse(readFileSync(mockStateFile, 'utf8')) as MockState);
    const server = mockServer;
    inner = async (url, init) => {
      try {
        return await server.fetch(url, init);
      } finally {
        mkdirSync(STATE_DIR, { recursive: true });
        writeFileSync(mockStateFile, JSON.stringify(server.exportState()));
      }
    };
    payee = MOCK_MERCHANT_ID;
  } else {
    loadDotEnv();
    const cfg = loadPayPalConfig(process.env);
    if (!cfg.expectedMerchantId) throw new NotReady('PAYPAL_EXPECTED_MERCHANT_ID is not set');
    payee = cfg.expectedMerchantId;
    inner = (url, init) => fetch(url, init);
  }
  const faulty: FetchLike = async (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const route = ROUTES.find(([m, re]) => m === method && re.test(new URL(url).pathname))?.[2];
    if (!route) return inner(url, init);
    const requestId = new Headers(init.headers).get('paypal-request-id');
    const fault = faults.get(route)?.shift();
    if (s) note(s, fault === 'REJECT_422' ? 'POST_NOT_SENT_INJECTED_422' : 'POST', { route, requestId: rid(requestId) });
    if (fault === 'REJECT_422') {
      console.log(`  ! injected: ${route} answered 422 without sending (not a PayPal answer)`);
      return new Response(JSON.stringify({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INJECTED_BY_FLEXSLOT_CHECK' }] }), { status: 422, headers: { 'content-type': 'application/json' } });
    }
    const res = await inner(url, init);
    if (fault === 'RESPONSE_LOST') {
      await res.text();
      if (s) note(s, 'ANSWER_DROPPED_INJECTED', { route, requestId: rid(requestId), detail: `HTTP ${res.status} at PayPal` });
      console.log(`  ! injected: ${route} reached PayPal (HTTP ${res.status}); its answer is dropped`);
      throw new TypeError('fetch failed (injected: answer lost after PayPal processed the request)');
    }
    return res;
  };
  const logger = (e: { event: string; route: string; httpStatus?: number; outcome: string; durationMs: number }) => console.log(`  · ${e.event} ${e.route} ${e.httpStatus ?? '-'} ${e.outcome} ${e.durationMs}ms`);
  const port = MOCK
    ? new PayPalRestAdapter({ mode: 'MOCK', apiBase: MOCK_API_BASE, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, fetch: faulty, clock, logger })
    : createSandboxPayPal(loadPayPalConfig(process.env), { fetch: faulty, clock, logger });
  return { port, payee };
}

function crashHooks(s: RunState, point: string, match: (i: { opKind?: string; status?: string; reconcile?: string | null }) => boolean = () => true): ExecutorHooks {
  return {
    at(p, info) {
      if (p !== point || !match(info)) return;
      s.crashedAt = Date.now();
      const c = s.caseId ? getCase(openDb(), s.caseId) : null;
      note(s, 'PROCESS_STOPPED', { detail: `at ${p}${info.opKind ? ` (${info.opKind}${info.status ? ` ${info.status}` : ''})` : ''}${c ? `, case ${c.status}` : ''}` });
      console.log(`  ! process stops at ${p} (real exit; the next phase is a new process)`);
      process.exit(0);
    },
  };
}

function executor(db: Db, port: PayPalPort, s: RunState, hooks?: ExecutorHooks): Executor {
  return new Executor({ db, paypal: port, clock, owner: `interrupts-${s.run}-p${s.phase}-${process.pid}`, ...(hooks ? { hooks } : {}), returnUrl: 'http://localhost:8787/paypal/return', cancelUrl: 'http://localhost:8787/paypal/cancel' });
}

async function waitApproved(port: PayPalPort, orderId: string, label: string, deadlineMs: number): Promise<void> {
  if (MOCK) {
    mockServer!.approveOrder(orderId);
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(mockStateFile, JSON.stringify(mockServer!.exportState()));
    return;
  }
  const q = await port.getOrder(orderId);
  const url = q.kind === 'FOUND' ? approvalUrl(q.resource, 'SANDBOX') : null;
  console.log(`\nAPPROVAL ${label}: ${url ?? '(link not available)'}\n`);
  while (Date.now() < deadlineMs) {
    const o = await port.getOrder(orderId);
    if (o.kind === 'FOUND' && o.resource.status === 'APPROVED') return;
    await sleep(5_000);
  }
  throw new Error(`${label}: not approved in time`);
}

/** Drives the case until `done` (or the time runs out): the queue and the case, every 2 s. */
async function drive(ex: Executor, caseId: string, db: Db, done: (status: string) => boolean, maxMs = 180_000): Promise<string> {
  const end = Date.now() + maxMs;
  for (;;) {
    await ex.processDue();
    const st = await ex.advance(caseId);
    if (done(st)) return st;
    if (Date.now() > end) return getCase(db, caseId)!.status;
    await sleep(2_000);
  }
}

/**
 * An executor works on every world of its payment mode, so the runs must not overlap: a phase refuses to start while
 * another run's case is still being processed (a case waiting for the owner, like REFUND_FAILED, does not count).
 */
function assertAlone(db: Db, s: RunState): void {
  const busy = db
    .prepare(
      `SELECT count(*) AS n FROM swap_cases c JOIN worlds w ON w.id = c.world_id WHERE c.world_id <> ? AND w.mode_payment = ?
         AND c.status IN ('PAYMENT_STARTED', 'AUTHORIZED', 'CAPTURING', 'PAYMENT_PENDING', 'RECONCILING', 'PAYMENT_UNKNOWN', 'CAPTURED',
                          'BOOKING_COMMITTED', 'REFUND_PENDING', 'VOID_PENDING', 'B_REFUND_PENDING')`,
    )
    .get(s.worldId, MODE) as { n: number };
  if (busy.n > 0) throw new NotReady(`another run is still in progress (${busy.n} case); finish it first`);
}

const bumpABooking = (db: Db, s: RunState) => {
  db.prepare('UPDATE bookings SET version = version + 1 WHERE id = ?').run(idsFor(s.worldId).aBookingId);
  note(s, 'DB_FAULT_INJECTED', { detail: "A's booking changed (version + 1) by SQL" });
  console.log("  ! injected: A's booking changed (SQL update; not a Sandbox event)");
};

// ---- commands ------------------------------------------------------------------------------------------------------

async function prepare(runs: RunId[]): Promise<void> {
  const db = openDb();
  const states: RunState[] = [];
  const ai = new AiService({ db, clock, vertex: null, mock: new MockStructurer() });
  for (const r of runs) {
    const { port, payee } = paypalFor(null, new Map());
    const w = createWorld(db, clock.now(), { aiMode: 'MOCK', paymentMode: MODE, payeeMerchantId: payee });
    const s: RunState = { run: r, worldId: w.ids.worldId, tokens: w.tokens, caseId: null, phase: 0, crashedAt: null, log: [] };
    note(s, 'WORLD_CREATED', { detail: `${SCENARIO[r]} | base ${w.baseDate}` });
    const ex = executor(db, port, s);
    const prep = ex.prepareAPayment(w.ids.aBookingId);
    if (!prep.ok) throw new Error(`A payment: ${prep.reason}`);
    const order = await ex.createAOrder(w.ids.aBookingId);
    if (!order.ok) throw new Error(`A order: ${order.reason}`);
    states.push(s);
    (s as RunState & { aOrder?: string }).aOrder = order.orderId;
    console.log(`${r}: world ${w.ids.worldId} (${SCENARIO[r]})`);
  }
  // A's approvals (all at once), then the capture, the conditions, the proposal and two approvals per run.
  for (const s of states) {
    const { port } = paypalFor(s, new Map());
    await waitApproved(port, (s as RunState & { aOrder?: string }).aOrder!, `A ${s.run}`, Date.now() + 30 * 60_000);
  }
  for (const s of states) {
    const { port } = paypalFor(s, new Map());
    const ex = executor(db, port, s);
    const ids = idsFor(s.worldId);
    const cap = await ex.captureAPayment(ids.aBookingId);
    if (!cap.ok || !cap.paid) throw new Error(`${s.run}: A capture not confirmed`);
    const base = (db.prepare('SELECT base_local_date AS d FROM worlds WHERE id = ?').get(s.worldId) as { d: string }).d;
    const draft = async (role: 'A' | 'B', text: string) => {
      const d = await createDraft({ db, clock, ai }, { worldId: s.worldId, role, partyId: role === 'A' ? ids.customerAId : ids.customerBId, text, useAi: false });
      if (!d.ok) throw new Error(`${s.run}: draft ${d.reason}`);
      return d.draftId;
    };
    const aDraft = await draft('A', `(interrupt check ${s.run}) move window entered by hand`);
    const a = confirmDraft({ db, clock }, { worldId: s.worldId, role: 'A', partyId: ids.customerAId, draftId: aDraft, form: { windows: [{ date: addDays(base, 5), start: '10:00', end: '12:00' }] } });
    if (!a.ok) throw new Error(`${s.run}: A conditions ${a.reason}`);
    const bDraft = await draft('B', `(interrupt check ${s.run}) request entered by hand`);
    let caseId: string | null = null;
    const b = confirmDraft(
      { db, clock },
      { worldId: s.worldId, role: 'B', partyId: ids.customerBId, draftId: bDraft, form: { windows: [{ date: addDays(base, 2), start: '14:00', end: '15:00' }], serviceId: `${s.worldId}:service:cut`, stylistId: null } },
      (versionId) => {
        caseId = proposeInTx(db, clock.now(), s.worldId, versionId).caseId;
      },
    );
    if (!b.ok || !caseId) throw new Error(`${s.run}: no proposal`);
    const c = getCase(db, caseId)!;
    for (const role of ['OWNER', 'A'] as const) {
      const r = approveCase(db, clock.now(), { worldId: s.worldId, caseId, role, partyId: role === 'OWNER' ? ids.ownerPartyId : ids.customerAId, version: c.version, termsHash: c.terms_hash });
      if (!r.ok) throw new Error(`${s.run}: ${role} approval ${r.reason}`);
    }
    s.caseId = caseId;
    note(s, 'CASE_READY', { detail: 'A paid, conditions confirmed, owner and A approved' });
    console.log(`${s.run}: case ready (A_ACCEPTED)`);
  }
}

async function start(r: RunId): Promise<void> {
  const db = openDb();
  const s = loadState(r);
  if (!s.caseId || s.phase !== 0) throw new NotReady(`${r} is not ready to start (phase ${s.phase})`);
  assertAlone(db, s);
  s.phase = 1;
  const faults = new Map<string, Fault[]>();
  if (r === 'R1' || r === 'R5') faults.set('AUTH_CAPTURE', ['RESPONSE_LOST']);
  const { port } = paypalFor(s, faults);
  const hooks =
    r === 'R1' || r === 'R3' ? crashHooks(s, 'before-e7')
    : r === 'R2' ? crashHooks(s, 'after-result-saved', (i) => i.opKind === 'AUTH_CAPTURE' && i.reconcile === 'AWAITING')
    : r === 'R5' ? crashHooks(s, 'after-result-saved', (i) => i.opKind === 'AUTH_CAPTURE' && i.status === 'UNKNOWN')
    : undefined;
  const ex = executor(db, port, s, hooks);
  const c = getCase(db, s.caseId)!;
  const ids = idsFor(s.worldId);
  const st = ex.startPayment({ caseId: c.id, version: c.version, termsHash: c.terms_hash, bPartyId: ids.customerBId });
  if (!st.ok) throw new Error(`E1: ${st.reason}`);
  const o = await ex.createOrder(c.id);
  if (!o.ok) throw new Error(`E2: ${o.reason}`);
  note(s, 'B_ORDER_CREATED');
  await waitApproved(port, o.orderId, `B ${r}`, Date.now() + 14 * 60_000);
  const a = await ex.onBuyerApproved(c.id);
  if (!a.ok) throw new Error(`E4: ${a.reason}`);
  note(s, 'AUTHORIZED', { detail: getCase(db, c.id)!.status });
  if (r === 'R4') bumpABooking(db, s);
  const end = await drive(ex, c.id, db, (x) => ['COMPLETED', 'REJECTED', 'COMPENSATED', 'REFUND_FAILED', 'B_REFUND_FAILED'].includes(x));
  note(s, 'PHASE_END', { detail: end });
  console.log(`${r} phase 1 ended: ${end}`);
}

async function resume(r: RunId): Promise<void> {
  const s = loadState(r);
  if (!s.caseId || !s.crashedAt) throw new NotReady(`${r} has no stopped phase to resume`);
  const wait = s.crashedAt + LEASE_WAIT_MS - Date.now();
  if (wait > 0) {
    console.log(`  waiting ${Math.ceil(wait / 1000)} s until the stopped process's lease has run out`);
    await sleep(wait);
  }
  const db = openDb();
  assertAlone(db, s);
  s.phase += 1;
  s.crashedAt = null;
  const faults = new Map<string, Fault[]>();
  let hooks: ExecutorHooks | undefined;
  if (r === 'R1' && s.phase === 2) hooks = crashHooks(s, 'after-e7');
  if (r === 'R1' && s.phase === 3) faults.set('CAPTURE_REFUND', ['RESPONSE_LOST']);
  if (r === 'R2' && s.phase === 2) faults.set('CAPTURE_REFUND', ['REJECT_422']);
  if (r === 'R3' && s.phase === 2) bumpABooking(db, s);
  if (r === 'R5' && s.phase === 2) hooks = crashHooks(s, 'before-e7');
  if (r === 'R5' && s.phase === 3) hooks = crashHooks(s, 'after-e7');
  if (r === 'R5' && s.phase === 4) {
    faults.set('CAPTURE_REFUND', ['RESPONSE_LOST']);
    hooks = crashHooks(s, 'after-result-saved', (i) => i.opKind === 'CAPTURE_REFUND' && i.status === 'UNKNOWN');
  }
  const { port } = paypalFor(s, faults);
  const ex = executor(db, port, s, hooks);
  note(s, 'RESTARTED', { detail: 'new process, startup recovery' });
  const rep = await ex.recover();
  console.log(`  startup recovery: recovered ${rep.recovered.length}, excluded ${rep.excluded.length}, busy ${rep.busy.length}`);
  const end = await drive(ex, s.caseId, db, (x) => ['COMPLETED', 'REJECTED', 'COMPENSATED', 'REFUND_FAILED', 'B_REFUND_FAILED'].includes(x));
  note(s, 'PHASE_END', { detail: end });
  console.log(`${r} phase ${s.phase} ended: ${end}`);
}

/** The owner's "Recover (same amount)" (POST obligations/retry): a new attempt of the failed refund obligation. */
async function ownerRecover(r: RunId): Promise<void> {
  const s = loadState(r);
  if (!s.caseId) throw new NotReady('no case');
  const db = openDb();
  assertAlone(db, s);
  s.phase += 1;
  const { port } = paypalFor(s, new Map());
  const ex = executor(db, port, s);
  const ob = db.prepare("SELECT id FROM money_obligations WHERE case_id = ? AND status = 'NEEDS_ATTENTION'").get(s.caseId) as { id: string } | undefined;
  if (!ob) throw new NotReady('no obligation needs attention');
  const x = ex.retryObligation(ob.id);
  if (!x.ok) throw new Error(`recover: ${x.reason}`);
  note(s, 'OWNER_RECOVER', { detail: 'new attempt of the failed refund (same amount)' });
  const end = await drive(ex, s.caseId, db, (st) => ['COMPLETED', 'REFUND_FAILED'].includes(st));
  note(s, 'PHASE_END', { detail: end });
  console.log(`${r} owner recovery ended: ${end}`);
}

/** What the three screens show now: the same view functions the screens' API uses (read only). */
function screens(r: RunId): void {
  const s = loadState(r);
  if (!s.caseId) throw new NotReady('no case');
  const db = openDb();
  const ids = idsFor(s.worldId);
  const ai = { vertexModel: null, mockModel: 'mock-rules-v1' };
  const now = clock.now();
  type CaseOut = { status: string; statusLabel: string; steps: Record<string, { text: string } | string | null> };
  const line = (who: string, c: CaseOut | undefined, extra = '') => {
    if (!c) return `${who}: no case`;
    const st = (k: string) => (typeof c.steps[k] === 'string' ? c.steps[k] : (c.steps[k] as { text: string } | null)?.text ?? '-');
    return `${who}: "${c.statusLabel}" (${c.status}) | B payment: ${st('bPayment')} | compensation: ${st('aRefund')} | bookings: ${st('bookings')}${extra}`;
  };
  const b = customerView(db, s.worldId, 'B', ids.customerBId, now, ai) as unknown as { cases: CaseOut[] };
  const a = customerView(db, s.worldId, 'A', ids.customerAId, now, ai) as unknown as { cases: CaseOut[]; booking: { time: string } };
  const o = ownerView(db, s.worldId, now, ai) as unknown as { cases: CaseOut[]; needsAttentionObligations: string[]; stopped: unknown[]; checking: unknown[] };
  const lines = [
    line('B', b.cases[0]),
    line('A', a.cases[0], ` | A's booking: ${a.booking.time}`),
    line('owner', o.cases[0], ` | needs attention: ${o.needsAttentionObligations.join(',') || 'none'} | stopped: ${o.stopped.length} | checking: ${o.checking.length}`),
  ];
  for (const l of lines) console.log(l);
  note(s, 'SCREENS', { detail: lines.join(' || ') });
  db.close();
}

async function report(r: RunId): Promise<void> {
  await run(`INTERRUPT-${r}`, MODE, async (rep) => {
    const s = loadState(r);
    if (!s.caseId) throw new NotReady('no case');
    const db = openDb();
    const { port } = paypalFor(null, new Map());
    const c = getCase(db, s.caseId)!;
    const ids = idsFor(s.worldId);
    rep.note('scenario', SCENARIO[r]);
    rep.note('world', s.worldId);
    rep.note('case_status', c.status);
    for (const e of s.log) rep.say(`${e.at} p${e.phase} ${e.event}${e.route ? ` ${e.route}` : ''}${e.requestId ? ` rid#${e.requestId}` : ''}${e.detail ? ` (${e.detail})` : ''}`);
    const ops = db
      .prepare(
        `SELECT m.kind AS ob, t.attempt_no AS att, o.op_kind, o.op_seq, o.status, o.external_status AS ext, o.reconcile_status AS rec, o.sends, o.paypal_request_id AS rid, o.result_external_id AS res
         FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id JOIN money_obligations m ON m.id = t.obligation_id WHERE m.case_id = ? ORDER BY o.rowid`,
      )
      .all(c.id) as Array<{ ob: string; att: number; op_kind: string; op_seq: number; status: string; ext: string | null; rec: string | null; sends: number; rid: string; res: string | null }>;
    for (const o of ops) rep.say(`op ${o.ob}#${o.att} ${o.op_kind}/${o.op_seq} ${o.status}${o.ext ? `/${o.ext}` : ''}${o.rec ? ` ${o.rec}` : ''} sends=${o.sends} rid#${rid(o.rid)} ${anon('res', o.res ?? undefined)}`);
    const obligations = db.prepare('SELECT kind, status, amount_minor FROM money_obligations WHERE case_id = ? ORDER BY kind').all(c.id) as Array<{ kind: string; status: string; amount_minor: number }>;
    rep.note('obligations', obligations.map((o) => `${o.kind}=${o.status}(${o.amount_minor})`).join(' '));
    const posts = s.log.filter((e) => e.event === 'POST');
    // Every POST of one operation uses one request id; one operation per kind unless a definitive refusal came first.
    const byOp = new Map<string, Set<string>>();
    for (const o of ops) byOp.set(`${o.op_kind}/${o.op_seq}/${o.att}`, new Set([rid(o.rid)]));
    const aOps = db.prepare('SELECT paypal_request_id AS rid FROM a_payment_operations WHERE booking_id = ?').all(ids.aBookingId) as Array<{ rid: string }>;
    const known = new Set([...ops.map((o) => rid(o.rid)), ...aOps.map((o) => rid(o.rid))]);
    const postIds = new Set(posts.map((p) => p.requestId));
    rep.check('every POST sent in this run carries the request id of one of the recorded operations of this world', [...postIds].every((x) => x !== undefined && known.has(x)));
    const resent = ops.filter((o) => o.sends > 1);
    rep.note('operations_sent_more_than_once', resent.map((o) => `${o.op_kind}x${o.sends} (same rid#${rid(o.rid)})`).join(' ') || 'none');
    rep.note('posts_by_route', [...new Set(posts.map((p) => p.route))].map((rt) => `${rt}x${posts.filter((p) => p.route === rt).length}`).join(' '));
    const capOps = ops.filter((o) => o.op_kind === 'AUTH_CAPTURE');
    rep.check('at most one capture operation (no new capture after an unknown or stopped one)', capOps.length <= 1);
    const grants = (db.prepare('SELECT count(*) AS n FROM compensation_grants WHERE booking_id = ?').get(ids.aBookingId) as { n: number }).n;
    const aBooking = db.prepare('SELECT start_ms, version FROM bookings WHERE id = ?').get(ids.aBookingId) as { start_ms: number; version: number };
    const bBooking = db.prepare("SELECT count(*) AS n FROM bookings WHERE id = ? AND status = 'CONFIRMED'").get(`${c.id}:booking:b`) as { n: number };
    rep.note('a_booking_moved', aBooking.start_ms === c.dest_start_ms);
    rep.note('b_booking', bBooking.n);
    rep.note('compensation_grants', grants);

    // Sandbox (or mock) queries: what PayPal holds for this case.
    const bOrderRow = db.prepare("SELECT result_external_id AS id FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id JOIN money_obligations m ON m.id = t.obligation_id WHERE m.case_id = ? AND o.op_kind = 'ORDER_CREATE' AND o.status = 'SUCCEEDED'").get(c.id) as { id: string } | undefined;
    if (!bOrderRow) throw new NotReady(`${r} has not started yet (no B order)`);
    const bOrderId = bOrderRow.id;
    const order = await port.getOrder(bOrderId);
    if (order.kind !== 'FOUND') throw new Error('B order query failed');
    const pu = order.resource.purchase_units?.[0];
    const auths = pu?.payments?.authorizations ?? [];
    const caps = pu?.payments?.captures ?? [];
    rep.note('paypal_b_authorizations', auths.map((x) => x.status).join(',') || '-');
    rep.note('paypal_b_captures', caps.map((x) => x.status).join(',') || '-');
    rep.check('PayPal holds at most one authorization and at most one capture for B', auths.length <= 1 && caps.length <= 1);
    const aCap = await port.getCapture(c.a_capture_id);
    rep.note('paypal_a_capture', aCap.kind === 'FOUND' ? aCap.resource.status : aCap.kind);
    const refundOps = ops.filter((o) => o.op_kind === 'CAPTURE_REFUND' && o.status === 'SUCCEEDED' && o.res);
    for (const o of refundOps) {
      const q = await port.getRefund(o.res!);
      const total = q.kind === 'FOUND' ? q.resource.seller_payable_breakdown?.total_refunded_amount : undefined;
      rep.note(
        `paypal_refund_${o.ob}`,
        q.kind === 'FOUND' ? `${q.resource.status} ${q.resource.amount?.value} ${q.resource.amount?.currency_code}${total ? ` (capture total refunded ${total.value} ${total.currency_code})` : ''}` : q.kind,
      );
    }
    // No double refund, from PayPal's side: the refunds PayPal lists on A's and B's orders are exactly the
    // successful refund operations FlexSlot recorded for this case (an unrecorded or repeated refund would show here).
    const recordedRefunds = new Set(refundOps.map((o) => o.res!));
    const aOrderRow = db.prepare('SELECT order_id AS id FROM payments WHERE capture_id = ?').get(c.a_capture_id) as { id: string | null } | undefined;
    const listed: Array<{ who: 'A' | 'B'; id: string; text: string }> = [];
    for (const who of ['A', 'B'] as const) {
      const orderId = who === 'A' ? aOrderRow?.id : bOrderId;
      if (!orderId) throw new Error(`${who} order id not recorded`);
      const q = who === 'B' ? order : await port.getOrder(orderId);
      if (q.kind !== 'FOUND') throw new Error(`${who} order query failed`);
      for (const rf of q.resource.purchase_units?.[0]?.payments?.refunds ?? []) listed.push({ who, id: rf.id, text: `${who}:${rf.status} ${rf.amount?.value} ${rf.amount?.currency_code} ${anon('res', rf.id)}` });
    }
    rep.note('paypal_refunds_listed_on_orders', listed.map((x) => x.text).join(' ') || 'none');
    // The in-process mock does not list refunds on orders (the Sandbox does), so this check is for the Sandbox only.
    if (MOCK) rep.note('refund_list_check', 'skipped: the mock does not list refunds on orders');
    else rep.check(
      'the refunds PayPal lists on the A and B orders are exactly the recorded successful refund operations (none extra, none twice)',
      listed.length === recordedRefunds.size && new Set(listed.map((x) => x.id)).size === listed.length && listed.every((x) => recordedRefunds.has(x.id)),
    );
    const expect: Record<RunId, () => boolean> = {
      R1: () => c.status === 'COMPLETED' && caps.length === 1 && caps[0]!.status === 'COMPLETED' && grants === 1 && aCap.kind === 'FOUND' && aCap.resource.status === 'PARTIALLY_REFUNDED' && refundOps.length === 1,
      R2: () => c.status === 'COMPLETED' && caps.length === 1 && grants === 1 && aCap.kind === 'FOUND' && aCap.resource.status === 'PARTIALLY_REFUNDED' && refundOps.length === 1,
      R3: () => c.status === 'COMPENSATED' && caps.length === 1 && caps[0]!.status === 'REFUNDED' && grants === 0 && bBooking.n === 0 && aCap.kind === 'FOUND' && aCap.resource.status === 'COMPLETED',
      R4: () => c.status === 'REJECTED' && caps.length === 0 && auths.length === 1 && auths[0]!.status === 'VOIDED' && grants === 0 && bBooking.n === 0,
      R5: () => c.status === 'COMPLETED' && caps.length === 1 && caps[0]!.status === 'COMPLETED' && grants === 1 && aCap.kind === 'FOUND' && aCap.resource.status === 'PARTIALLY_REFUNDED' && refundOps.length === 1,
    };
    rep.check(`end state as expected for ${r} (${SCENARIO[r]})`, expect[r]());
    db.close();
  });
}

const [cmd, ...args] = process.argv.slice(2);
const runs = args.filter((a): a is RunId => ['R1', 'R2', 'R3', 'R4', 'R5'].includes(a));
try {
  if (cmd === 'prepare' && runs.length) await prepare(runs);
  else if (cmd === 'start' && runs.length === 1) await start(runs[0]!);
  else if (cmd === 'resume' && runs.length === 1) await resume(runs[0]!);
  else if (cmd === 'report' && runs.length === 1) await report(runs[0]!);
  else if (cmd === 'owner-recover' && runs.length === 1) await ownerRecover(runs[0]!);
  else if (cmd === 'screens' && runs.length === 1) screens(runs[0]!);
  else throw new NotReady('usage: node scripts/verify/interrupts.ts prepare|start|resume|report|screens R1..R5');
  process.exit(process.exitCode ?? 0);
} catch (e) {
  console.log(`error: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  process.exit(e instanceof NotReady ? 3 : 1);
}
