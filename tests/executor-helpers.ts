// Test harness for the executor: the mock PayPal server behind a fetch wrapper that can hold or rewrite
// answers, a seeded swap world (SPEC 4 sample, A already paid with a mock capture), and crash hooks.
// Mock only: nothing here reaches the network.

import { randomUUID } from 'node:crypto';
import { ManualClock } from '../src/clock.ts';
import { openDatabase, type Db } from '../src/db/database.ts';
import type { CrashPoint, ExecutorHooks, HookInfo } from '../src/executor/engine.ts';
import { Executor } from '../src/executor/executor.ts';
import type { OpRow } from '../src/executor/ops.ts';
import { buildCaseTerms, termsHash, type CaseRow, type FixedTerms } from '../src/executor/terms.ts';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_MERCHANT_ID, MockPayPalServer, type MockRoute, type ReplayModes } from '../src/paypal/mock-server.ts';
import { MOCK_API_BASE, PayPalRestAdapter, type FetchLike } from '../src/paypal/rest.ts';
import { SAMPLE_NOW_MS, seedSampleWorld, type SampleWorldIds } from '../src/sample.ts';
import { at } from './helpers.ts';

export class SimulatedCrash extends Error {
  constructor(point: string) {
    super(`simulated crash at ${point}`);
    this.name = 'SimulatedCrash';
  }
}

const ROUTES: Array<[string, RegExp, MockRoute]> = [
  ['POST', /\/v1\/oauth2\/token$/, 'TOKEN'],
  ['POST', /\/v2\/checkout\/orders$/, 'ORDER_CREATE'],
  ['GET', /\/v2\/checkout\/orders\/[^/]+$/, 'ORDER_GET'],
  ['POST', /\/v2\/checkout\/orders\/[^/]+\/authorize$/, 'ORDER_AUTHORIZE'],
  ['POST', /\/v2\/checkout\/orders\/[^/]+\/capture$/, 'ORDER_CAPTURE'],
  ['GET', /\/v2\/payments\/authorizations\/[^/]+$/, 'AUTH_GET'],
  ['POST', /\/v2\/payments\/authorizations\/[^/]+\/capture$/, 'AUTH_CAPTURE'],
  ['POST', /\/v2\/payments\/authorizations\/[^/]+\/void$/, 'AUTH_VOID'],
  ['GET', /\/v2\/payments\/captures\/[^/]+$/, 'CAPTURE_GET'],
  ['POST', /\/v2\/payments\/captures\/[^/]+\/refund$/, 'CAPTURE_REFUND'],
  ['GET', /\/v2\/payments\/refunds\/[^/]+$/, 'REFUND_GET'],
];

function routeOf(url: string, method: string): MockRoute | null {
  const path = new URL(url).pathname;
  for (const [m, re, r] of ROUTES) if (m === method && re.test(path)) return r;
  return null;
}

interface Gate {
  route: MockRoute;
  /** REQUEST: the server sees the request only on release. RESPONSE: processed now, answer delivered on release. */
  mode: 'REQUEST' | 'RESPONSE';
  arrived: Promise<void>;
  release: () => void;
  _arrive: () => void;
  _wait: Promise<void>;
}

/** fetch in front of the mock server: holds or rewrites answers per route, and remembers the last JSON body. */
export class FaultyFetch {
  readonly #inner: FetchLike;
  readonly #gates: Gate[] = [];
  readonly #rewrites = new Map<MockRoute, (json: Record<string, unknown>) => Record<string, unknown>>();
  readonly last = new Map<MockRoute, Record<string, unknown>>();

  constructor(inner: FetchLike) {
    this.#inner = inner;
  }

  /** Holds the next request to `route`. */
  hold(route: MockRoute, mode: Gate['mode']): Gate {
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((r) => (arrive = r));
    const wait = new Promise<void>((r) => (release = r));
    const g: Gate = { route, mode, arrived, release, _arrive: arrive, _wait: wait };
    this.#gates.push(g);
    return g;
  }

  /** Rewrites every 2xx JSON answer of `route` until cleared. */
  rewrite(route: MockRoute, fn: (json: Record<string, unknown>) => Record<string, unknown>): void {
    this.#rewrites.set(route, fn);
  }

  clearRewrite(route: MockRoute): void {
    this.#rewrites.delete(route);
  }

  readonly fetch: FetchLike = async (url, init) => {
    const route = routeOf(url, (init.method ?? 'GET').toUpperCase());
    const i = route ? this.#gates.findIndex((g) => g.route === route) : -1;
    const gate = i >= 0 ? this.#gates.splice(i, 1)[0] : undefined;
    if (gate?.mode === 'REQUEST') {
      gate._arrive();
      await gate._wait;
    }
    let res = await this.#inner(url, init);
    if (gate?.mode === 'RESPONSE') {
      gate._arrive();
      await gate._wait;
    }
    if (route && res.status >= 200 && res.status < 300) {
      const text = await res.text();
      let json: Record<string, unknown> | undefined;
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
      } catch {
        json = undefined;
      }
      const fn = this.#rewrites.get(route);
      if (json && fn) json = fn(structuredClone(json));
      if (json) this.last.set(route, json);
      res = new Response(json ? JSON.stringify(json) : text || null, { status: res.status, headers: res.headers });
    }
    return res;
  };
}

export interface SwapWorld {
  db: Db;
  clock: ManualClock;
  server: MockPayPalServer;
  faulty: FaultyFetch;
  paypal: PayPalRestAdapter;
  ids: SampleWorldIds;
  caseId: string;
  version: number;
  termsHash: string;
  aOrderId: string;
  aCaptureId: string;
  exec(o?: { owner?: string; hooks?: ExecutorHooks }): Executor;
  start(ex: Executor): void;
}

/**
 * SPEC 4 sample in mock mode: A (2026-11-07 14:00-15:00, 60.00 paid with a real mock capture) moves to
 * 2026-11-10 10:00-11:00, B takes 14:00-15:00 for 60.00, A gets 10.00. Case C1 is A_ACCEPTED (owner and A
 * approved), with an ACTIVE hold on the destination. Server request log starts empty.
 */
export async function swapWorld(o: { replay?: ReplayModes; timeoutMs?: number; compMinor?: number } = {}): Promise<SwapWorld> {
  const clock = new ManualClock(SAMPLE_NOW_MS);
  const server = new MockPayPalServer({ clock, ...(o.replay ? { replay: o.replay } : {}) });
  const faulty = new FaultyFetch(server.fetch);
  const paypal = new PayPalRestAdapter({
    mode: 'MOCK', apiBase: MOCK_API_BASE, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, fetch: faulty.fetch, clock, timeoutMs: o.timeoutMs ?? 50,
  });
  const db = openDatabase(':memory:');
  const ids = seedSampleWorld(db, 'w1', SAMPLE_NOW_MS);
  db.prepare('UPDATE shops SET expected_payee_merchant_id = ? WHERE id = ?').run(MOCK_MERCHANT_ID, ids.shopId);

  // A's original payment: a real capture on the mock server (outside the executor; see a-payment tests for I08).
  const created = await paypal.createOrder(
    { intent: 'CAPTURE', amount: { currency: 'USD', minor: 6000 }, customId: `booking:${ids.aBookingId}:a`, returnUrl: 'http://localhost/r', cancelUrl: 'http://localhost/c' },
    { requestId: randomUUID() },
  );
  if (created.kind !== 'SUCCEEDED') throw new Error('setup: order');
  server.approveOrder(created.resource.id);
  const cap = await paypal.captureOrder(created.resource.id, { requestId: randomUUID() });
  if (cap.kind !== 'SUCCEEDED') throw new Error('setup: capture');
  const aOrderId = created.resource.id;
  const aCaptureId = cap.resource.capture.id;
  db.prepare('UPDATE payments SET order_id = ?, capture_id = ?, payee_merchant_id = ? WHERE id = ?').run(aOrderId, aCaptureId, MOCK_MERCHANT_ID, ids.aPaymentId);

  const caseId = 'C1';
  const row: Omit<CaseRow, 'world_id' | 'status' | 'terms_json' | 'terms_hash'> = {
    id: caseId,
    version: 1,
    a_booking_id: ids.aBookingId,
    a_booking_version: 1,
    b_request_id: ids.bRequestId,
    stylist_id: ids.stylistId,
    origin_start_ms: at('2026-11-07', '14:00'),
    origin_end_ms: at('2026-11-07', '15:00'),
    b_start_ms: at('2026-11-07', '14:00'),
    b_end_ms: at('2026-11-07', '15:00'),
    dest_start_ms: at('2026-11-10', '10:00'),
    dest_end_ms: at('2026-11-10', '11:00'),
    b_price_minor: 6000,
    a_comp_minor: o.compMinor ?? 1000,
    currency: 'USD',
    a_capture_id: aCaptureId,
    offer_expires_at: SAMPLE_NOW_MS + 3 * 3_600_000,
  };
  const terms = buildCaseTerms(row, sampleFixedTerms(ids));
  const hash = termsHash(terms);
  db.prepare(
    `INSERT INTO swap_cases (id, world_id, version, status, terms_json, terms_hash, a_booking_id, a_booking_version, b_request_id, stylist_id,
       origin_start_ms, origin_end_ms, b_start_ms, b_end_ms, dest_start_ms, dest_end_ms, b_price_minor, a_comp_minor, currency, a_capture_id, offer_expires_at)
     VALUES (?, ?, ?, 'A_ACCEPTED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    caseId, ids.worldId, row.version, JSON.stringify(terms), hash, row.a_booking_id, row.a_booking_version, row.b_request_id, row.stylist_id,
    row.origin_start_ms, row.origin_end_ms, row.b_start_ms, row.b_end_ms, row.dest_start_ms, row.dest_end_ms, row.b_price_minor, row.a_comp_minor,
    row.currency, row.a_capture_id, row.offer_expires_at,
  );
  const approve = db.prepare("INSERT INTO approvals (case_id, role, party_id, terms_hash, decision, decided_at) VALUES (?, ?, ?, ?, 'APPROVED', ?)");
  approve.run(caseId, 'OWNER', 'owner', hash, SAMPLE_NOW_MS);
  approve.run(caseId, 'A', ids.customerAId, hash, SAMPLE_NOW_MS);
  db.prepare("INSERT INTO slot_holds (id, case_id, stylist_id, start_ms, end_ms, status, expires_at) VALUES ('H1', ?, ?, ?, ?, 'ACTIVE', ?)").run(
    caseId, ids.stylistId, row.dest_start_ms, row.dest_end_ms, SAMPLE_NOW_MS + 30 * 60_000,
  );
  server.requests.splice(0);

  return {
    db, clock, server, faulty, paypal, ids, caseId, version: 1, termsHash: hash, aOrderId, aCaptureId,
    exec: (x = {}) => new Executor({ db, paypal, clock, owner: x.owner ?? 'exec-1', ...(x.hooks ? { hooks: x.hooks } : {}) }),
    start(ex) {
      const r = ex.startPayment({ caseId, version: 1, termsHash: hash, bPartyId: ids.customerBId });
      if (!r.ok) throw new Error(`startPayment refused: ${r.reason}`);
    },
  };
}

/** IE1-02: the parties, services and versions the sample case is approved with. */
export function sampleFixedTerms(ids: SampleWorldIds): FixedTerms {
  return {
    payeeMerchantId: MOCK_MERCHANT_ID,
    aCustomerId: ids.customerAId,
    bCustomerId: ids.customerBId,
    aServiceId: ids.cutServiceId,
    bServiceId: ids.cutServiceId,
    bServiceDurationMin: 60,
    bRequestVersion: 1,
    aPreferenceVersion: 1,
  };
}

/** E1 -> E2 -> buyer approval -> E4 (AUTHORIZED). */
export async function toAuthorized(w: SwapWorld, ex: Executor): Promise<string> {
  w.start(ex);
  const o = await ex.createOrder(w.caseId);
  if (!o.ok) throw new Error(`createOrder: ${o.reason}`);
  w.server.approveOrder(o.orderId);
  const r = await ex.onBuyerApproved(w.caseId);
  if (!r.ok) throw new Error(`onBuyerApproved: ${r.reason}`);
  return o.orderId;
}

/** Hooks that throw SimulatedCrash at the first matching crash point (then never again). */
export function crashAt(point: CrashPoint, match: (i: HookInfo) => boolean = () => true): ExecutorHooks & { fired: boolean } {
  const h = {
    fired: false,
    at(p: CrashPoint, info: HookInfo) {
      if (!h.fired && p === point && match(info)) {
        h.fired = true;
        throw new SimulatedCrash(p);
      }
    },
  };
  return h;
}

/** After a crash: let the dead process's lease run out, then start a new executor. */
export function restart(w: SwapWorld, owner = 'exec-2'): Executor {
  w.clock.advance(61_000);
  return w.exec({ owner });
}

export const posts = (w: SwapWorld, route: MockRoute) => w.server.requests.filter((r) => r.route === route && r.method === 'POST');
export const gets = (w: SwapWorld, route: MockRoute) => w.server.requests.filter((r) => r.route === route && r.method === 'GET');

export const caseStatus = (w: SwapWorld) => (w.db.prepare('SELECT status FROM swap_cases WHERE id = ?').get(w.caseId) as { status: string }).status;
export const holdStatus = (w: SwapWorld) => (w.db.prepare("SELECT status FROM slot_holds WHERE id = 'H1'").get() as { status: string }).status;

export function obligation(w: SwapWorld, kind: string): { id: string; status: string; settled_by_operation_id: string | null; amount_minor: number } | undefined {
  return w.db.prepare('SELECT * FROM money_obligations WHERE case_id = ? AND kind = ?').get(w.caseId, kind) as never;
}

export function opsOf(w: SwapWorld, kind?: string): OpRow[] {
  return (
    kind
      ? w.db.prepare('SELECT * FROM payment_operations WHERE op_kind = ? ORDER BY rowid').all(kind)
      : w.db.prepare('SELECT * FROM payment_operations ORDER BY rowid').all()
  ) as unknown as OpRow[];
}

export const chargeAttempt = (w: SwapWorld) =>
  w.db
    .prepare("SELECT t.* FROM payment_attempts t JOIN money_obligations o ON o.id = t.obligation_id WHERE o.case_id = ? AND o.kind = 'B_CHARGE'")
    .get(w.caseId) as { id: string; status: string; expires_at: number };

export const audits = (w: SwapWorld, action: string) =>
  w.db.prepare('SELECT detail_json FROM audit_log WHERE action = ? ORDER BY id').all(action).map((r) => JSON.parse((r as { detail_json: string }).detail_json) as Record<string, unknown>);

/** E7's processed marker: case status, compensation grant and A's refund obligation. */
export function e7Marker(w: SwapWorld): { grant: boolean; refundObligation: boolean; bBooking: boolean } {
  return {
    grant: !!w.db.prepare('SELECT 1 FROM compensation_grants WHERE case_id = ?').get(w.caseId),
    refundObligation: !!obligation(w, 'A_COMPENSATION_REFUND'),
    bBooking: !!w.db.prepare('SELECT 1 FROM bookings WHERE id = ?').get(`${w.caseId}:booking:b`),
  };
}

/** Everything a finished swap must show, in the DB and at the mock server. */
export function expectCompletedSwap(
  w: SwapWorld,
  expect: (v: unknown) => { toBe(x: unknown): void; toEqual(x: unknown): void },
  o: { refundsAtPayPal?: number } = {},
): void {
  expect(caseStatus(w)).toBe('COMPLETED');
  expect(holdStatus(w)).toBe('CONVERTED');
  const a = w.db.prepare('SELECT start_ms, end_ms, version FROM bookings WHERE id = ?').get(w.ids.aBookingId);
  expect(a).toEqual({ start_ms: at('2026-11-10', '10:00'), end_ms: at('2026-11-10', '11:00'), version: 2 });
  const b = w.db.prepare('SELECT start_ms, end_ms, customer_id, status FROM bookings WHERE id = ?').get(`${w.caseId}:booking:b`);
  expect(b).toEqual({ start_ms: at('2026-11-07', '14:00'), end_ms: at('2026-11-07', '15:00'), customer_id: w.ids.customerBId, status: 'CONFIRMED' });
  expect(obligation(w, 'B_CHARGE')?.status).toBe('SETTLED');
  expect(obligation(w, 'A_COMPENSATION_REFUND')?.status).toBe('SETTLED');
  expect(w.db.prepare('SELECT count(*) AS n FROM compensation_grants WHERE booking_id = ?').get(w.ids.aBookingId)).toEqual({ n: 1 });
  expect(w.server.statusOf(w.aCaptureId)).toBe('PARTIALLY_REFUNDED');
  // One order/authorization/capture for B and one refund for A at PayPal (A's own order and capture came first;
  // a FAILED refund also stays on record there).
  expect([w.server.count('orders'), w.server.count('authorizations'), w.server.count('captures'), w.server.count('refunds')]).toEqual([2, 1, 2, o.refundsAtPayPal ?? 1]);
}
