// Regression tests for the connection-check steps (Codex review IP1-01, IP1-02), run against the mock PayPal.

import { describe, expect, it } from 'vitest';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, MOCK_MERCHANT_ID, MockPayPalServer } from '../src/paypal/mock-server.ts';
import type { PayPalPort } from '../src/paypal/port.ts';
import { buildCaptureAuthorization } from '../src/paypal/requests.ts';
import { MOCK_API_BASE, PayPalRestAdapter, type FetchLike } from '../src/paypal/rest.ts';
import { MemoryRunStore, NotReady, OpBindingError, Runs, type ReportLike } from '../scripts/verify/core.ts';
import { v2Finish, v2Start, v3Finish, v3Start, v4, v5, v6, v7, type StepContext } from '../scripts/verify/steps.ts';
import { mockSetup } from './paypal-helpers.ts';

class FakeReport implements ReportLike {
  readonly checks: Array<{ name: string; ok: boolean }> = [];
  readonly notes: Record<string, string | number | boolean> = {};
  check(name: string, ok: boolean): boolean {
    this.checks.push({ name, ok });
    return ok;
  }
  note(key: string, value: string | number | boolean): void {
    this.notes[key] = value;
  }
  say(): void {}
  get failed(): string[] {
    return this.checks.filter((c) => !c.ok).map((c) => c.name);
  }
}

type Step = (ctx: StepContext) => Promise<void>;

function harness(opts: { paypal?: PayPalPort; server?: MockPayPalServer } = {}) {
  const m = mockSetup();
  const server = opts.server ?? m.server;
  const paypal = opts.paypal ?? m.paypal;
  const store = new MemoryRunStore();
  const runs = new Runs(store);
  const exec = async (step: Step, payee: string | null = MOCK_MERCHANT_ID) => {
    const expectedMerchantId = payee ?? undefined; // null = not set (undefined would select the default)
    const r = new FakeReport();
    await step({ paypal, expectedMerchantId, runs, r, returnUrl: 'http://localhost:8799/r', cancelUrl: 'http://localhost:8799/c', pollIntervalMs: 1 });
    return r;
  };
  const data = () => runs.current().data;
  /** V2 start, V3 start, buyer approvals, then V2 finish ... V7. Returns each step's report. */
  const fullRun = async () => {
    const reports: Record<string, FakeReport> = {};
    reports.v2Start = await exec(v2Start);
    server.approveOrder(data()['v2.orderId']!);
    reports.v3Start = await exec(v3Start);
    server.approveOrder(data()['v3.b1.orderId']!);
    server.approveOrder(data()['v3.b2.orderId']!);
    for (const [name, step] of Object.entries({ v2Finish, v3Finish, v4, v5, v6, v7 })) reports[name] = await exec(step);
    return reports;
  };
  return { server, paypal, store, runs, exec, data, fullRun };
}

const requestIdsOf = (runs: Runs) => Object.values(runs.current().ops).map((o) => o.requestId);

describe('verification runs (IP1-01)', () => {
  it('two consecutive runs both pass and share no request id; the second over-refund is still rejected', async () => {
    const h = harness();
    const first = await h.fullRun();
    for (const [name, r] of Object.entries(first)) expect(r.failed, name).toEqual([]);
    const firstRun = h.runs.current().runId;
    const firstIds = requestIdsOf(h.runs);

    const second = await h.fullRun();
    for (const [name, r] of Object.entries(second)) expect(r.failed, name).toEqual([]);
    expect(h.runs.current().runId).not.toBe(firstRun);
    const secondIds = requestIdsOf(h.runs);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    // Each run captured its own A order and its own B authorization.
    expect(h.server.count('captures')).toBe(4);
    expect(h.server.statusOf(h.data()['v3.b1.authorizationId']!)).toBe('CAPTURED');
    expect(second.v6!.checks.find((c) => c.name.startsWith('refund above the remaining amount'))?.ok).toBe(true);
  });

  it('a resume within the run reuses the same request id and creates nothing new', async () => {
    const h = harness();
    await h.fullRun();
    const before = h.runs.current().ops['v4.capture']!.requestId;
    const captures = h.server.count('captures');
    const again = await h.exec(v4);
    expect(again.failed).toEqual([]);
    expect(h.runs.current().ops['v4.capture']!.requestId).toBe(before);
    expect(h.server.count('captures')).toBe(captures);
  });

  it('an operation bound to another target is refused before anything is sent', async () => {
    const h = harness();
    await h.fullRun();
    const file = h.store.load();
    const run = file.runs[file.currentRunId!]!;
    run.data['v3.b1.authorizationId'] = run.data['v3.b2.authorizationId']!; // simulate a stale or edited state file
    h.store.save(file);
    const sent = h.server.requests.length;
    await expect(h.exec(v4)).rejects.toThrow(OpBindingError);
    expect(h.server.requests.length).toBe(sent);
  });

  it('Runs: phases, set-once values, bindings and results', () => {
    const runs = new Runs(new MemoryRunStore());
    const a = runs.startPhase('v2');
    expect(runs.startPhase('v3').runId).toBe(a.runId); // V3 joins the run V2 opened
    const b = runs.startPhase('v2'); // V2 again opens a new run
    expect(b.runId).not.toBe(a.runId);
    runs.set(b.runId, { x: '1' });
    runs.set(b.runId, { x: '1' });
    expect(() => runs.set(b.runId, { x: '2' })).toThrow();

    const money = { amount: { currency: 'USD', minor: 6000 } };
    const built = buildCaptureAuthorization('MOCK-AUTH-000001', money);
    const op = runs.bind(b.runId, 'k', built, 'MOCK-AUTH-000001');
    expect(runs.bind(b.runId, 'k', built, 'MOCK-AUTH-000001')).toEqual(op);
    expect(() => runs.bind(b.runId, 'k', buildCaptureAuthorization('MOCK-AUTH-000002', money), 'MOCK-AUTH-000002')).toThrow(OpBindingError);
    expect(() => runs.bind(b.runId, 'k', buildCaptureAuthorization('MOCK-AUTH-000001', { amount: { currency: 'USD', minor: 5000 } }), 'MOCK-AUTH-000001')).toThrow(OpBindingError);
    runs.recordResult(b.runId, 'k', 'MOCK-CAPTURE-000001');
    expect(() => runs.recordResult(b.runId, 'k', 'MOCK-CAPTURE-000002')).toThrow();
  });
});

describe('expected payee (IP1-02)', () => {
  it('unset: V2/V3 start, V3 finish and V4 stop as NOT_READY before sending', async () => {
    const h = harness();
    await expect(h.exec(v2Start, null)).rejects.toThrow(NotReady);
    await expect(h.exec(v3Start, null)).rejects.toThrow(NotReady);
    expect(h.server.requests).toEqual([]);

    await h.exec(v2Start);
    await h.exec(v3Start);
    h.server.approveOrder(h.data()['v3.b1.orderId']!);
    h.server.approveOrder(h.data()['v3.b2.orderId']!);
    const sent = h.server.requests.length;
    await expect(h.exec(v3Finish, null)).rejects.toThrow(NotReady);
    await expect(h.exec(v4, null)).rejects.toThrow(NotReady);
    expect(h.server.requests.length).toBe(sent);
  });

  it('mismatch: the payee checks fail', async () => {
    const h = harness();
    await h.exec(v3Start);
    h.server.approveOrder(h.data()['v3.b1.orderId']!);
    h.server.approveOrder(h.data()['v3.b2.orderId']!);
    expect((await h.exec(v3Finish, 'OTHERMERCHANT1')).failed).toEqual(['v3.b1: order payee matches', 'v3.b2: order payee matches']);
    expect((await h.exec(v4, 'OTHERMERCHANT1')).failed).toEqual(['GET capture: amount, currency, payee match']);
  });

  it('missing in PayPal responses: the payee checks fail instead of passing unchecked', async () => {
    const server = new MockPayPalServer();
    const stripPayee: FetchLike = async (url, init) => {
      const res = await server.fetch(url, init);
      const text = await res.text();
      if (!text) return new Response(null, { status: res.status });
      const body = JSON.parse(text, (k, v: unknown) => (k === 'payee' ? undefined : v)) as unknown;
      return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } });
    };
    const paypal = new PayPalRestAdapter({ mode: 'MOCK', apiBase: MOCK_API_BASE, clientId: MOCK_CLIENT_ID, clientSecret: MOCK_CLIENT_SECRET, fetch: stripPayee });
    const h = harness({ paypal, server });
    await h.exec(v3Start);
    h.server.approveOrder(h.data()['v3.b1.orderId']!);
    h.server.approveOrder(h.data()['v3.b2.orderId']!);
    expect((await h.exec(v3Finish)).failed).toEqual(['v3.b1: order payee matches', 'v3.b2: order payee matches']);
    expect((await h.exec(v4)).failed).toEqual(['GET capture: amount, currency, payee match']);
  });
});
