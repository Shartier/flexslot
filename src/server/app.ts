// HTTP API and pages for the three screens (DESIGN 5, 6.1, 10; AC01, AC10-AC12).
// - Invite link: the token is in the URL fragment; the page POSTs it here and gets a session cookie (HttpOnly,
//   SameSite=Strict, Path=/w/{world}/{role}); the page then removes the fragment with history.replaceState.
// - Every API call checks the session's world, role and party against the resource (owner checks on the server;
//   the cookie path only keeps the three tabs apart and is not the authorization boundary).
// - Every POST needs the session's CSRF token (X-CSRF-Token) and an allowed Origin.
// - Bodies are strict: unknown fields (amount, currency, payee, order or capture ids) are rejected, and values for
//   money and PayPal always come from the database snapshot (AC11).
// - The world's payment mode picks the executor; a mock action in a Sandbox world (or the reverse) is refused (AC12).

import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { z } from 'zod';
import type { Clock } from '../clock.ts';
import { immediate, type Db } from '../db/database.ts';
import type { AiService } from '../ai/service.ts';
import type { Executor } from '../executor/executor.ts';
import { getCase } from '../executor/store.ts';
import type { PayPalPort } from '../paypal/port.ts';
import type { MockPayPalServer } from '../paypal/mock-server.ts';
import { approvalUrl } from '../paypal/rest.ts';
import { approveCase, isCaseParty, OFFER_TTL_MS, proposeInTx, reevaluateInTx, rejectCase } from '../app/cases.ts';
import { answerDraft, confirmDraft, createDraft, type IntakeRole } from '../app/intake.ts';
import { customerView, ownerView } from '../app/views.ts';
import { parseLang } from '../app/views-ja.ts';
import { createWorld, getWorld, idsFor, newToken, sha256, type PaymentMode, type Role } from '../app/world.ts';
import { receiveWebhook } from '../app/webhooks.ts';
import { fail, json, parseCookies, type Req, type Res } from './http.ts';

export const COOKIE = 'fs_session';
export const SESSION_TTL_MS = 24 * 3_600_000;

export interface AppDeps {
  db: Db;
  clock: Clock;
  /** Origins allowed on POST; the first one is used in invite links. */
  origins: string[];
  ai: AiService;
  executors: Partial<Record<PaymentMode, Executor>>;
  paypal: Partial<Record<PaymentMode, PayPalPort>>;
  mockServer: MockPayPalServer | null;
  /** Shop's PayPal merchant id for Sandbox worlds (PAYPAL_EXPECTED_MERCHANT_ID); Sandbox worlds need it (IP1-02). */
  sandboxPayee: string | null;
  mockPayee: string;
  staticDir: string | null;
  offerTtlMs?: number;
  log?: (line: Record<string, unknown>) => void;
  /** DESIGN 7.4: deliveries accepted per remote address per minute (default 120). */
  webhookRatePerMinute?: number;
}

interface Session {
  token_hash: string;
  world_id: string;
  role: Role;
  party_id: string;
  expires_at: number;
  csrf_hash: string;
}

const ROLE_SEG: Record<string, Role> = { owner: 'OWNER', a: 'A', b: 'B' };
const WORLD_ID = /^[A-Za-z0-9_-]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const S = {
  session: z.strictObject({ token: z.string().min(20).max(100) }),
  empty: z.strictObject({}),
  world: z.strictObject({ aiMode: z.enum(['VERTEX', 'MOCK']), paymentMode: z.enum(['SANDBOX', 'MOCK']) }),
  decision: z.strictObject({ caseId: z.string().min(1).max(120), version: z.number().int().positive(), termsHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  caseRef: z.strictObject({ caseId: z.string().min(1).max(120) }),
  draft: z.strictObject({ text: z.string().min(1).max(2000), useAi: z.boolean() }),
  answer: z.strictObject({ draftId: z.string().uuid(), answers: z.array(z.string().max(500)).min(1).max(5) }),
  windows: z.array(z.strictObject({ date: z.string().regex(DATE), start: z.string().regex(TIME), end: z.string().regex(TIME) })).min(1).max(5),
  retry: z.strictObject({ obligationId: z.string().min(1).max(120) }),
};
const confirmA = z.strictObject({ draftId: z.string().uuid(), windows: S.windows });
const confirmB = z.strictObject({ draftId: z.string().uuid(), windows: S.windows, serviceId: z.string().min(1).max(120), stylistId: z.string().max(120).nullable().optional() });

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>FlexSlot</title><p>The screens are not built yet. Run <code>npm run build</code>, then reload.</p>`;

export interface App {
  handle(req: Req): Promise<Res>;
  /** Resolves when the background work started by requests (advancing a case) has finished. Tests use it. */
  idle(): Promise<void>;
}

export function createApp(d: AppDeps): App {
  const pending = new Set<Promise<unknown>>();
  const webhookHits = new Map<string, { windowStart: number; count: number }>();
  const log = d.log ?? (() => {});
  const ttl = d.offerTtlMs ?? OFFER_TTL_MS;

  /** Background work after a request (the queue tick would do it too, just later). */
  const kick = (fn: () => Promise<unknown>) => {
    const p = fn()
      .catch((e: unknown) => log({ event: 'background.error', error: e instanceof Error ? e.name : 'unknown' }))
      .finally(() => pending.delete(p));
    pending.add(p);
  };

  const parse = <T>(schema: z.ZodType<T>, body: string): { ok: true; value: T } | { ok: false; res: Res } => {
    let raw: unknown;
    try {
      raw = body === '' ? {} : JSON.parse(body);
    } catch {
      return { ok: false, res: fail(400, 'BAD_JSON') };
    }
    const r = schema.safeParse(raw);
    return r.success ? { ok: true, value: r.data } : { ok: false, res: fail(400, 'BAD_REQUEST', { issues: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`) }) };
  };

  const originOk = (req: Req) => req.headers.origin !== undefined && d.origins.includes(req.headers.origin);

  const sessionOf = (req: Req, worldId: string, role: Role): Session | null => {
    const now = d.clock.now();
    for (const [name, value] of parseCookies(req.headers.cookie)) {
      if (name !== COOKIE || !value) continue;
      const s = d.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(value)) as Session | undefined;
      if (s && s.world_id === worldId && s.role === role && s.expires_at > now) return s;
    }
    return null;
  };

  const csrfOk = (req: Req, s: Session) => {
    const t = req.headers['x-csrf-token'];
    if (!t) return false;
    const a = Buffer.from(sha256(t), 'hex');
    const b = Buffer.from(s.csrf_hash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const cookieFor = (worldId: string, roleSeg: string, token: string, maxAgeSec: number) => {
    const secure = d.origins[0]!.startsWith('https:') ? '; Secure' : '';
    return `${COOKIE}=${token}; Path=/w/${worldId}/${roleSeg}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`;
  };

  const executorFor = (worldId: string): { ex: Executor; port: PayPalPort; mode: PaymentMode } | null => {
    const w = getWorld(d.db, worldId);
    const ex = w && d.executors[w.mode_payment];
    const port = w && d.paypal[w.mode_payment];
    return w && ex && port ? { ex, port, mode: w.mode_payment } : null;
  };

  const approvalLink = async (mode: PaymentMode, port: PayPalPort, orderId: string) => {
    if (mode === 'MOCK') return { kind: 'MOCK' as const };
    const q = await port.getOrder(orderId);
    const url = q.kind === 'FOUND' ? approvalUrl(q.resource, mode) : null;
    return url ? { kind: 'PAYPAL' as const, url } : { kind: 'UNAVAILABLE' as const };
  };

  const bOrderId = (caseId: string): string | null => {
    const r = d.db
      .prepare(
        `SELECT o.result_external_id AS id FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id JOIN money_obligations m ON m.id = t.obligation_id
         WHERE m.case_id = ? AND m.kind = 'B_CHARGE' AND o.op_kind = 'ORDER_CREATE' AND o.status = 'SUCCEEDED' ORDER BY t.attempt_no DESC LIMIT 1`,
      )
      .get(caseId) as { id: string } | undefined;
    return r?.id ?? null;
  };

  const aOrderId = (bookingId: string): string | null => {
    const r = d.db
      .prepare("SELECT result_external_id AS id FROM a_payment_operations WHERE booking_id = ? AND op_kind = 'ORDER_CREATE' AND status = 'SUCCEEDED' ORDER BY op_seq DESC LIMIT 1")
      .get(bookingId) as { id: string } | undefined;
    return r?.id ?? null;
  };

  const reevaluate = (worldId: string) => immediate(d.db, () => reevaluateInTx(d.db, d.clock.now(), worldId, ttl));

  const refusal = (reason: string): Res =>
    reason === 'CASE_NOT_FOUND' || reason === 'NOT_YOUR_CASE' || reason === 'DRAFT_NOT_FOUND' ? fail(404, 'NOT_FOUND') : fail(409, reason);

  const aiInfo = () => ({ vertexModel: d.ai.vertexModel, mockModel: d.ai.mockModel });

  // ---- pages and static files ------------------------------------------------------------------------------------

  const indexHtml = (): Res => {
    const file = d.staticDir ? join(d.staticDir, 'index.html') : null;
    const body = file && existsSync(file) ? readFileSync(file) : NOT_BUILT;
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body };
  };

  const asset = (path: string): Res => {
    if (!d.staticDir) return fail(404, 'NOT_FOUND');
    const rel = normalize(path).replace(/^[/\\]+/, '');
    if (rel.includes('..')) return fail(404, 'NOT_FOUND');
    const file = join(d.staticDir, rel);
    if (!file.startsWith(d.staticDir) || !existsSync(file)) return fail(404, 'NOT_FOUND');
    return { status: 200, headers: { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' }, body: readFileSync(file) };
  };

  // ---- role APIs -------------------------------------------------------------------------------------------------

  async function roleApi(req: Req, worldId: string, roleSeg: string, role: Role, sub: string): Promise<Res> {
    const now = d.clock.now();
    if (req.method === 'POST' && !originOk(req)) return fail(403, 'ORIGIN');

    if (sub === 'session' && req.method === 'POST') {
      const p = parse(S.session, req.body);
      if (!p.ok) return p.res;
      const inv = d.db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(sha256(p.value.token)) as
        | { world_id: string; role: Role; party_id: string; expires_at: number }
        | undefined;
      if (!inv || inv.world_id !== worldId || inv.role !== role || inv.expires_at <= now) return fail(401, 'INVITE_INVALID');
      const token = newToken();
      const csrf = newToken();
      const expires = Math.min(now + SESSION_TTL_MS, inv.expires_at);
      d.db.prepare('INSERT INTO sessions (token_hash, world_id, role, party_id, expires_at, csrf_hash) VALUES (?, ?, ?, ?, ?, ?)').run(
        sha256(token), worldId, role, inv.party_id, expires, sha256(csrf),
      );
      d.db.prepare("INSERT INTO audit_log (world_id, actor, action, detail_json, created_at) VALUES (?, ?, 'SESSION_STARTED', '{}', ?)").run(worldId, role, now);
      return json(200, { csrfToken: csrf, role, worldId }, { 'set-cookie': cookieFor(worldId, roleSeg, token, Math.floor((expires - now) / 1000)) });
    }

    const s = sessionOf(req, worldId, role);
    if (!s) return fail(401, 'NO_SESSION');
    if (req.method === 'POST' && sub !== 'session/csrf' && !csrfOk(req, s)) return fail(403, 'CSRF');

    if (sub === 'session/csrf' && req.method === 'POST') {
      // A new tab or a reload: a fresh CSRF token for this session (SameSite=Strict + Origin keep other sites out).
      const csrf = newToken();
      d.db.prepare('UPDATE sessions SET csrf_hash = ? WHERE token_hash = ?').run(sha256(csrf), s.token_hash);
      return json(200, { csrfToken: csrf, role, worldId });
    }

    if (sub === 'state' && req.method === 'GET') {
      const lang = parseLang(req.query.get('lang'));
      return json(200, role === 'OWNER' ? ownerView(d.db, worldId, now, aiInfo(), lang) : customerView(d.db, worldId, role, s.party_id, now, aiInfo(), lang));
    }

    if (req.method !== 'POST' && !(req.method === 'GET' && sub === 'cases/approval-link')) return fail(405, 'METHOD');
    const ids = idsFor(worldId);

    // -- approvals (owner, A; B's approval is the payment start) --
    if (sub === 'cases/approve' || sub === 'cases/reject') {
      const p = parse(S.decision, req.body);
      if (!p.ok) return p.res;
      const decision = { worldId, role, partyId: s.party_id, ...p.value };
      const r = sub === 'cases/approve' ? approveCase(d.db, now, decision) : rejectCase(d.db, now, decision);
      return r.ok ? json(200, r) : refusal(r.reason);
    }

    // -- intake (A conditions, B request) --
    if ((role === 'A' || role === 'B') && sub.startsWith('intake/')) {
      const intake = { db: d.db, clock: d.clock, ai: d.ai };
      const r = role as IntakeRole;
      if (sub === 'intake/draft') {
        const p = parse(S.draft, req.body);
        if (!p.ok) return p.res;
        const out = await createDraft(intake, { worldId, role: r, partyId: s.party_id, text: p.value.text, useAi: p.value.useAi });
        return out.ok ? json(200, out) : refusal(out.reason);
      }
      if (sub === 'intake/answer') {
        const p = parse(S.answer, req.body);
        if (!p.ok) return p.res;
        const out = await answerDraft(intake, { worldId, role: r, partyId: s.party_id, draftId: p.value.draftId, answers: p.value.answers });
        return out.ok ? json(200, out) : refusal(out.reason);
      }
      if (sub === 'intake/confirm') {
        const p = r === 'A' ? parse(confirmA, req.body) : parse(confirmB, req.body);
        if (!p.ok) return p.res;
        const v = p.value as { draftId: string; windows: Array<{ date: string; start: string; end: string }>; serviceId?: string; stylistId?: string | null };
        let proposal: unknown = null;
        const out = confirmDraft(
          { db: d.db, clock: d.clock },
          { worldId, role: r, partyId: s.party_id, draftId: v.draftId, form: { windows: v.windows, serviceId: v.serviceId ?? null, stylistId: v.stylistId ?? null } },
          (versionId) => {
            proposal = r === 'B' ? proposeInTx(d.db, now, worldId, versionId, ttl) : reevaluateInTx(d.db, now, worldId, ttl);
          },
        );
        return out.ok ? json(200, { ...out, proposal }) : out.reason === 'FORM_INVALID' ? fail(422, 'FORM_INVALID', { issues: out.issues ?? [] }) : refusal(out.reason);
      }
      return fail(404, 'NOT_FOUND');
    }

    // -- A's original payment (DESIGN 6.1 step 1) --
    if (role === 'A' && sub.startsWith('payment/')) {
      const x = executorFor(worldId);
      if (!x) return fail(503, 'PAYMENT_MODE_UNAVAILABLE');
      if (!parse(S.empty, req.body).ok) return fail(400, 'BAD_REQUEST');
      if (sub === 'payment/start') {
        const prep = x.ex.prepareAPayment(ids.aBookingId);
        if (!prep.ok) return refusal(prep.reason);
        const o = await x.ex.createAOrder(ids.aBookingId);
        if (!o.ok) return fail(409, o.reason);
        return json(200, { approval: await approvalLink(x.mode, x.port, o.orderId) });
      }
      if (sub === 'payment/mock-approve') {
        if (x.mode !== 'MOCK' || !d.mockServer) return fail(409, 'MODE_MISMATCH');
        const orderId = aOrderId(ids.aBookingId);
        if (!orderId) return fail(409, 'ORDER_NOT_CREATED');
        try {
          d.mockServer.approveOrder(orderId);
        } catch {
          return fail(409, 'ORDER_NOT_APPROVABLE');
        }
      }
      if (sub === 'payment/approved' || sub === 'payment/mock-approve') {
        const r = await x.ex.captureAPayment(ids.aBookingId);
        if (!r.ok) return refusal(r.reason);
        if (r.paid) reevaluate(worldId);
        return json(200, r);
      }
      return fail(404, 'NOT_FOUND');
    }

    // -- B's payment (E1-E4) --
    if (role === 'B' && (sub === 'cases/pay' || sub === 'cases/approved' || sub === 'cases/mock-approve' || sub === 'cases/approval-link')) {
      const x = executorFor(worldId);
      if (!x) return fail(503, 'PAYMENT_MODE_UNAVAILABLE');
      let caseId: string;
      let decision: { version: number; termsHash: string } | null = null;
      if (sub === 'cases/approval-link') {
        caseId = req.query.get('caseId') ?? '';
      } else if (sub === 'cases/pay') {
        const p = parse(S.decision, req.body);
        if (!p.ok) return p.res;
        caseId = p.value.caseId;
        decision = p.value;
      } else {
        const p = parse(S.caseRef, req.body);
        if (!p.ok) return p.res;
        caseId = p.value.caseId;
      }
      const c = getCase(d.db, caseId);
      if (!c || c.world_id !== worldId || !isCaseParty(d.db, c, 'B', s.party_id)) return fail(404, 'NOT_FOUND');

      if (sub === 'cases/pay') {
        const st = x.ex.startPayment({ caseId, version: decision!.version, termsHash: decision!.termsHash, bPartyId: s.party_id });
        if (!st.ok && st.reason !== 'ALREADY_STARTED') return fail(409, st.reason);
      }
      if (sub === 'cases/pay' || sub === 'cases/approval-link') {
        const o = sub === 'cases/pay' ? await x.ex.createOrder(caseId) : { ok: true as const, orderId: bOrderId(caseId) };
        if (!o.ok || !o.orderId) return fail(409, o.ok ? 'ORDER_NOT_CREATED' : o.reason);
        const fresh = getCase(d.db, caseId)!;
        if (fresh.status !== 'PAYMENT_STARTED') return fail(409, 'NOT_AWAITING_PAYMENT');
        return json(200, { approval: await approvalLink(x.mode, x.port, o.orderId) });
      }
      if (sub === 'cases/mock-approve') {
        if (x.mode !== 'MOCK' || !d.mockServer) return fail(409, 'MODE_MISMATCH');
        const orderId = bOrderId(caseId);
        if (!orderId) return fail(409, 'ORDER_NOT_CREATED');
        try {
          d.mockServer.approveOrder(orderId);
        } catch {
          return fail(409, 'ORDER_NOT_APPROVABLE');
        }
      }
      // E3: the browser's signal only starts E4; the executor checks the attempt and authorizes on the server.
      const r = await x.ex.onBuyerApproved(caseId);
      if (!r.ok) return fail(409, r.reason);
      kick(() => x.ex.advance(caseId));
      return json(200, r);
    }

    // -- owner: recover an existing obligation after a confirmed failure --
    if (role === 'OWNER' && sub === 'obligations/retry') {
      const p = parse(S.retry, req.body);
      if (!p.ok) return p.res;
      const ob = d.db.prepare('SELECT m.id FROM money_obligations m JOIN swap_cases c ON c.id = m.case_id WHERE m.id = ? AND c.world_id = ?').get(p.value.obligationId, worldId);
      if (!ob) return fail(404, 'NOT_FOUND');
      const x = executorFor(worldId);
      if (!x) return fail(503, 'PAYMENT_MODE_UNAVAILABLE');
      const r = x.ex.retryObligation(p.value.obligationId);
      return r.ok ? json(200, r) : fail(409, r.reason);
    }

    return fail(404, 'NOT_FOUND');
  }

  // ---- top level -------------------------------------------------------------------------------------------------

  async function handle(incoming: Req): Promise<Res> {
    // HEAD is answered like GET (node:http drops the body).
    const req = incoming.method === 'HEAD' ? { ...incoming, method: 'GET' } : incoming;
    const path = req.path;
    if (req.method === 'GET' && (path === '/' || path === '/paypal/return' || path === '/paypal/cancel')) return indexHtml();
    if (req.method === 'GET' && path.startsWith('/assets/')) return asset(path);

    // DESIGN 7.4: PayPal's server calls this; no session, CSRF or Origin. Stored first, verified later (WebhookInbox).
    if (path === '/webhooks/paypal' && req.method === 'POST') {
      const now = d.clock.now();
      const who = req.remote ?? 'unknown';
      const hit = webhookHits.get(who);
      const fresh = !hit || now - hit.windowStart >= 60_000;
      const count = fresh ? 1 : hit.count + 1;
      webhookHits.set(who, fresh ? { windowStart: now, count } : { windowStart: hit.windowStart, count });
      if (count > (d.webhookRatePerMinute ?? 120)) return fail(429, 'RATE_LIMITED');
      try {
        const r = receiveWebhook(d.db, now, req.headers, req.body);
        return r.ok ? json(200, { received: true }) : fail(r.status, r.reason);
      } catch (e) {
        // Not stored: never answer 200, so PayPal delivers it again.
        log({ event: 'webhook.store_error', error: e instanceof Error ? e.name : 'unknown' });
        return fail(500, 'NOT_STORED');
      }
    }

    if (path === '/api/config' && req.method === 'GET') {
      return json(200, {
        ai: { vertex: d.ai.vertexModel !== null, vertexModel: d.ai.vertexModel, mockModel: d.ai.mockModel },
        payment: { sandbox: !!d.executors.SANDBOX && !!d.sandboxPayee, mock: !!d.executors.MOCK },
      });
    }

    if (path === '/api/worlds' && req.method === 'POST') {
      if (!originOk(req)) return fail(403, 'ORIGIN');
      const p = parse(S.world, req.body);
      if (!p.ok) return p.res;
      const { aiMode, paymentMode } = p.value;
      if (aiMode === 'VERTEX' && d.ai.vertexModel === null) return fail(409, 'AI_MODE_UNAVAILABLE');
      if (!d.executors[paymentMode]) return fail(409, 'PAYMENT_MODE_UNAVAILABLE');
      const payee = paymentMode === 'SANDBOX' ? d.sandboxPayee : d.mockPayee;
      if (!payee) return fail(409, 'PAYEE_NOT_SET');
      const w = createWorld(d.db, d.clock.now(), { aiMode, paymentMode, payeeMerchantId: payee });
      const base = d.origins[0]!;
      const link = (seg: string, role: Role) => `${base}/w/${w.ids.worldId}/${seg}/#t=${w.tokens[role]}`;
      return json(201, { worldId: w.ids.worldId, baseDate: w.baseDate, links: { owner: link('owner', 'OWNER'), a: link('a', 'A'), b: link('b', 'B') } });
    }

    const m = /^\/w\/([^/]+)\/(owner|a|b)(?:\/(.*))?$/.exec(path);
    if (m) {
      const [, worldId, roleSeg, rest = ''] = m;
      if (!WORLD_ID.test(worldId!)) return fail(404, 'NOT_FOUND');
      const role = ROLE_SEG[roleSeg!]!;
      if (rest.startsWith('api/')) {
        if (!getWorld(d.db, worldId!)) return fail(404, 'NOT_FOUND');
        return roleApi(req, worldId!, roleSeg!, role, rest.slice(4));
      }
      if (req.method === 'GET' && rest === '') return indexHtml();
    }
    return fail(404, 'NOT_FOUND');
  }

  return {
    handle,
    async idle() {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
