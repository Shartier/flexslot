// What each screen may see (DESIGN 5): the owner sees the world; A sees A's booking and the cases about it; B sees
// B's request and the cases about it. Customers get plain status texts and next steps, never API errors, request
// ids or PayPal ids (SPEC 3). Amounts and times are formatted here from the database; the browser computes nothing.

import type { Db } from '../db/database.ts';
import { estimateSwapProfit, expectedOpportunityLossMinor } from '../domain/profit.ts';
import { getCase } from '../executor/store.ts';
import type { CaseRow } from '../executor/terms.ts';
import { formatLocal } from '../time.ts';
import { intakeBlocked, latestPreference, latestRequest, proposalToForm, type DraftRow, type IntakeRole, type LocalWindow, type Question } from './intake.ts';
import { exampleTexts, getWorld, hhmm, idsFor, servicesOf, shopOf, stylistsOf, type Role } from './world.ts';

export interface Money {
  minor: number;
  currency: string;
  text: string;
}

export function money(minor: number, currency: string): Money {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return { minor, currency, text: `${sign}${currency} ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}` };
}

const span = (start: number, end: number, tz: string) => `${formatLocal(start, tz)}–${formatLocal(end, tz).slice(11)}`;

/** SPEC 7 status table, in the screens' words. */
export const CASE_LABELS: Record<string, string> = {
  DRAFT: 'Please confirm the conditions',
  NEEDS_CLARIFICATION: 'Please confirm the conditions',
  AWAITING_APPROVAL: 'Waiting for approval',
  A_ACCEPTED: 'Waiting for approval',
  READY: 'Preparing payment',
  PAYMENT_STARTED: 'Preparing payment',
  AUTHORIZING: 'Preparing payment',
  AUTHORIZED: 'Preparing payment',
  CAPTURING: 'Confirming payment',
  PAYMENT_PENDING: 'Confirming payment',
  PAYMENT_UNKNOWN: 'Checking the payment result',
  RECONCILING: 'Checking the payment result',
  CAPTURED: 'Confirming the booking',
  BOOKING_COMMIT_PENDING: 'Confirming the booking',
  BOOKING_COMMITTED: 'Booking changed · compensation refund pending',
  REFUND_PENDING: 'Booking changed · compensation refund pending',
  REFUND_FAILED: 'Booking changed · compensation refund needs attention',
  COMPLETED: 'Swap completed',
  REJECTED: 'Not completed (declined)',
  EXPIRED: 'Not completed (expired)',
  VOID_PENDING: 'Not completed · releasing the authorization',
  B_REFUND_PENDING: 'Swap not possible · refunding the new customer',
  B_REFUND_FAILED: 'Swap not possible · refund needs attention',
  COMPENSATED: 'Swap not possible · refund completed',
};

export const REASON_TEXT: Record<string, string> = {
  NO_BOOKING_IN_REQUESTED_WINDOW: 'No existing booking occupies the requested time (the slot may simply be free to book normally).',
  A_BOOKING_NOT_CONFIRMED: 'The existing booking is not confirmed.',
  A_BOOKING_ALREADY_STARTED: 'The existing booking has already started.',
  A_PAYMENT_NOT_VERIFIED: "The existing customer's payment is not confirmed yet.",
  A_NO_FLEX_PREFERENCE: 'The existing customer has not registered move conditions yet.',
  B_STYLIST_MISMATCH: 'The requested stylist is different.',
  B_SERVICE_LONGER_THAN_REQUEST_WINDOW: 'The requested service is longer than the requested time window.',
  B_SERVICE_LONGER_THAN_ORIGIN_SLOT: 'The requested service is longer than the existing booking.',
  B_WINDOW_OUTSIDE_ORIGIN_SLOT: 'The requested time does not fit inside the existing booking.',
  B_SLOT_OUTSIDE_BUSINESS_HOURS: 'The requested time is outside business hours.',
  B_SLOT_CONFLICT: 'The requested time overlaps another booking or hold.',
  A_SERVICE_LONGER_THAN_WINDOW: "The existing customer's service does not fit in their move window.",
  DESTINATION_IN_PAST: 'The move window is in the past.',
  DESTINATION_OUTSIDE_BUSINESS_HOURS: 'The move window is outside business hours.',
  DESTINATION_OVERLAPS_ORIGIN: 'The move window overlaps the original booking.',
  DESTINATION_CONFLICT: 'The move window overlaps another booking or hold.',
  CASE_IN_PROGRESS: 'Another swap is already in progress.',
  A_ALREADY_COMPENSATED: 'This booking already received compensation once.',
  PAYEE_NOT_SET: "The shop's PayPal account is not set.",
};

export const SOURCE_TEXT: Record<string, string> = {
  AI_VERTEX: 'AI (Gemini on Vertex AI)',
  AI_MOCK: 'AI (mock rules)',
  MANUAL: 'Entered by hand',
};

interface ObligationRow {
  id: string;
  kind: string;
  amount_minor: number;
  currency: string;
  status: string;
}

interface AttemptRow {
  id: string;
  attempt_no: number;
  status: string;
  expires_at: number | null;
}

interface OpSummary {
  id: string;
  op_kind: string;
  status: string;
  external_status: string | null;
  reconcile_status: string | null;
  sends: number;
  last_error_class: string | null;
}

function obligations(db: Db, caseId: string): Array<ObligationRow & { attempts: Array<AttemptRow & { ops: OpSummary[] }> }> {
  const obs = db.prepare('SELECT id, kind, amount_minor, currency, status FROM money_obligations WHERE case_id = ? ORDER BY rowid').all(caseId) as unknown as ObligationRow[];
  return obs.map((o) => ({
    ...o,
    attempts: (db.prepare('SELECT id, attempt_no, status, expires_at FROM payment_attempts WHERE obligation_id = ? ORDER BY attempt_no').all(o.id) as unknown as AttemptRow[]).map(
      (t) => ({
        ...t,
        ops: db
          .prepare('SELECT id, op_kind, status, external_status, reconcile_status, sends, last_error_class FROM payment_operations WHERE attempt_id = ? ORDER BY rowid')
          .all(t.id) as unknown as OpSummary[],
      }),
    ),
  }));
}

/** One money step as a customer reads it. */
function moneyStep(o: ReturnType<typeof obligations>[number] | undefined): { state: string; text: string } {
  if (!o) return { state: 'NONE', text: 'Not started' };
  const att = o.attempts.at(-1);
  const op = att?.ops.at(-1);
  if (o.status === 'SETTLED') {
    return { state: 'DONE', text: o.kind === 'B_CHARGE' ? 'Paid' : o.kind === 'B_AUTH_VOID' ? 'Authorization released' : 'Refunded' };
  }
  if (o.status === 'CANCELLED') return { state: 'CANCELLED', text: att?.status === 'EXPIRED' ? 'Payment window expired (not charged)' : 'Cancelled' };
  if (o.status === 'NEEDS_ATTENTION') return { state: 'ATTENTION', text: 'Needs attention by the shop' };
  if (o.kind === 'B_CHARGE') {
    if (!att || att.status === 'OPEN') return { state: 'WORKING', text: 'Preparing the PayPal order' };
    if (att.status === 'ORDER_CREATED') {
      if (op?.op_kind === 'ORDER_AUTHORIZE' && op.status !== 'NOT_ACCEPTED' && op.status !== 'FAILED') return { state: 'WORKING', text: 'Authorizing the payment' };
      return { state: 'WAITING_BUYER', text: 'Waiting for approval on PayPal' };
    }
    if (att.status === 'AUTHORIZED') return { state: 'WORKING', text: op?.op_kind === 'AUTH_CAPTURE' ? 'Capturing the payment' : 'Authorized (not charged yet)' };
    if (att.status === 'CAPTURED') return { state: 'WORKING', text: 'Payment captured, checking it' };
  }
  if (op?.status === 'PENDING') return { state: 'WORKING', text: 'PayPal reports it as pending; checking again' };
  if (op?.status === 'UNKNOWN' || op?.status === 'SENDING') return { state: 'WORKING', text: 'Checking the result with PayPal' };
  if (op?.status === 'SUCCEEDED' && op.reconcile_status === 'AWAITING') return { state: 'WORKING', text: 'Checking the result with PayPal' };
  return { state: 'WORKING', text: o.kind === 'B_AUTH_VOID' ? 'Releasing the authorization' : 'Refund in progress' };
}

function approvalsOf(db: Db, c: CaseRow): Record<'OWNER' | 'A' | 'B', string | null> {
  const rows = db.prepare('SELECT role, decision FROM approvals WHERE case_id = ? AND terms_hash = ?').all(c.id, c.terms_hash) as Array<{ role: 'OWNER' | 'A' | 'B'; decision: string }>;
  const out: Record<'OWNER' | 'A' | 'B', string | null> = { OWNER: null, A: null, B: null };
  for (const r of rows) out[r.role] = r.decision;
  return out;
}

const CUSTOMER_EVENTS: Record<string, string> = {
  CASE_PROPOSED: 'Swap proposal created',
  OWNER_APPROVED: 'The shop approved',
  A_APPROVED: 'The existing customer agreed to move',
  B_APPROVED: 'The new customer approved',
  OWNER_REJECTED: 'The shop declined',
  A_REJECTED: 'The existing customer declined',
  B_REJECTED: 'The new customer declined',
  OFFER_EXPIRED: 'The proposal expired',
  PAYMENT_STARTED: 'Payment started',
  PAYMENT_EXPIRED: 'The payment window expired (nothing was charged)',
  BOOKING_COMMITTED: 'Bookings changed',
};

function caseView(db: Db, c: CaseRow, role: Role, now: number) {
  const tz = shopOf(db, c.world_id).timezone;
  const service = db.prepare('SELECT s.name FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.id = ?').get(c.a_booking_id) as { name: string };
  const bService = db.prepare('SELECT s.name FROM b_requests r JOIN services s ON s.id = json_extract(r.structured_json, \'$.serviceId\') WHERE r.id = ?').get(c.b_request_id) as
    | { name: string }
    | undefined;
  const stylist = db.prepare('SELECT name FROM stylists WHERE id = ?').get(c.stylist_id) as { name: string };
  const obs = obligations(db, c.id);
  const ob = (kind: string) => obs.find((o) => o.kind === kind);
  const approvals = approvalsOf(db, c);
  const beforePayment = c.status === 'AWAITING_APPROVAL' || c.status === 'A_ACCEPTED';
  const open = beforePayment && now < c.offer_expires_at;
  const charge = ob('B_CHARGE');
  const chargeAtt = charge?.attempts.at(-1);
  const awaitingBuyer = c.status === 'PAYMENT_STARTED' && chargeAtt?.status === 'ORDER_CREATED' && (chargeAtt.expires_at ?? 0) > now;
  const actions = {
    approve: open && ((role === 'OWNER' && approvals.OWNER === null) || (role === 'A' && approvals.OWNER === 'APPROVED' && approvals.A === null)),
    reject: open && role !== 'OWNER' ? approvals[role] !== 'REJECTED' : open && approvals.OWNER !== 'REJECTED',
    pay: role === 'B' && c.status === 'A_ACCEPTED' && open,
    payPal: role === 'B' && awaitingBuyer,
  };
  const events = (
    db.prepare('SELECT action, created_at FROM audit_log WHERE case_id = ? ORDER BY id').all(c.id) as Array<{ action: string; created_at: number }>
  )
    .filter((e) => CUSTOMER_EVENTS[e.action])
    .map((e) => ({ at: formatLocal(e.created_at, tz), text: CUSTOMER_EVENTS[e.action]! }));
  const bBooking = db.prepare("SELECT 1 FROM bookings WHERE id = ? AND status = 'CONFIRMED'").get(`${c.id}:booking:b`);
  return {
    id: c.id,
    version: c.version,
    termsHash: c.terms_hash,
    status: c.status,
    statusLabel: CASE_LABELS[c.status] ?? c.status,
    origin: span(c.origin_start_ms, c.origin_end_ms, tz),
    destination: span(c.dest_start_ms, c.dest_end_ms, tz),
    bSlot: span(c.b_start_ms, c.b_end_ms, tz),
    aService: service.name,
    bService: bService?.name ?? null,
    stylist: stylist.name,
    bPrice: money(c.b_price_minor, c.currency),
    aCompensation: money(c.a_comp_minor, c.currency),
    offerExpiresAt: formatLocal(c.offer_expires_at, tz),
    paymentDeadline: chargeAtt?.expires_at ? formatLocal(chargeAtt.expires_at, tz) : null,
    approvals,
    actions,
    steps: {
      bPayment: moneyStep(charge),
      authorizationRelease: ob('B_AUTH_VOID') ? moneyStep(ob('B_AUTH_VOID')) : null,
      aRefund: moneyStep(ob('A_COMPENSATION_REFUND')),
      bRefund: ob('B_RECOVERY_REFUND') ? moneyStep(ob('B_RECOVERY_REFUND')) : null,
      bookings: bBooking ? 'Changed: the existing booking moved and the new booking is confirmed' : 'Not changed',
    },
    events,
  };
}

function header(db: Db, worldId: string, role: Role, now: number, ai: { vertexModel: string | null; mockModel: string }) {
  const w = getWorld(db, worldId)!;
  const shop = shopOf(db, worldId);
  return {
    worldId,
    role,
    modes: {
      ai: w.mode_ai,
      aiModel: w.mode_ai === 'VERTEX' ? ai.vertexModel : ai.mockModel,
      aiAvailable: w.mode_ai === 'MOCK' || ai.vertexModel !== null,
      payment: w.mode_payment,
    },
    shop: {
      name: shop.name,
      timeZone: shop.timezone,
      hours: `${hhmm(shop.business_open_min)}–${hhmm(shop.business_close_min)}`,
      stylists: stylistsOf(db, shop.id).map((s) => s.name),
      services: servicesOf(db, shop.id).map((s) => ({ id: s.id, name: s.name, durationMin: s.duration_min, price: money(s.price_minor, shop.currency) })),
      compensation: money(shop.compensation_minor, shop.currency),
    },
    baseDate: w.base_local_date,
    serverTime: formatLocal(now, shop.timezone),
    examples: exampleTexts(w.base_local_date ?? formatLocal(now, shop.timezone).slice(0, 10)),
  };
}

function draftView(db: Db, worldId: string, role: IntakeRole, partyId: string) {
  const d = db
    .prepare("SELECT * FROM intake_drafts WHERE world_id = ? AND party_id = ? AND kind = ? AND status = 'OPEN' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(worldId, partyId, role === 'A' ? 'A_PREFERENCE' : 'B_REQUEST') as DraftRow | undefined;
  if (!d) return null;
  const proposal = d.proposal_json ? proposalToForm(role, JSON.parse(d.proposal_json)) : null;
  return {
    id: d.id,
    rawText: d.raw_text,
    source: d.source,
    sourceText: SOURCE_TEXT[d.source],
    manualReason: d.manual_reason,
    proposal,
    questions: JSON.parse(d.questions_json) as Question[],
  };
}

export function profitView(db: Db, c: CaseRow) {
  const shop = shopOf(db, c.world_id);
  const a = JSON.parse(shop.profit_assumptions_json) as {
    bServiceCostMinor: number; paymentFeesMinor: number; fillProbabilityBasisPoints: number; marginalProfitMinor: number; otherIncrementalCostMinor: number;
  };
  const opportunity = expectedOpportunityLossMinor(a.fillProbabilityBasisPoints, a.marginalProfitMinor);
  const est = estimateSwapProfit({
    bPriceMinor: c.b_price_minor,
    aCompensationMinor: c.a_comp_minor,
    bServiceCostMinor: a.bServiceCostMinor,
    paymentFeesMinor: a.paymentFeesMinor,
    opportunityLossMinor: opportunity,
    otherIncrementalCostMinor: a.otherIncrementalCostMinor,
  });
  const names: Record<string, string> = {
    bPriceMinor: "New customer's price (additional revenue)",
    aCompensationMinor: 'Fixed compensation to the existing customer',
    bServiceCostMinor: 'Extra cost of serving the new customer (assumption)',
    paymentFeesMinor: 'Extra payment and refund fees (assumption, not a PayPal rate)',
    opportunityLossMinor: `Opportunity loss at the destination (assumption: ${a.fillProbabilityBasisPoints / 100}% × ${money(a.marginalProfitMinor, c.currency).text})`,
    otherIncrementalCostMinor: 'Other incremental costs (assumption)',
  };
  return {
    lines: est.lines.map((l) => ({ name: names[l.key], sign: l.sign, amount: money(l.amountMinor, c.currency) })),
    additionalRevenue: money(est.additionalRevenueMinor, c.currency),
    additionalProfit: money(est.additionalProfitMinor, c.currency),
    note: "Estimate with fictional assumptions. A's original payment is already booked revenue and is not counted again. The owner decides whether the swap pays off.",
  };
}

const sanitizeDetail = (detail: string): Record<string, unknown> => {
  const d = JSON.parse(detail) as Record<string, unknown>;
  for (const k of Object.keys(d)) if (/token|secret|request_?id|authorization/i.test(k)) delete d[k];
  return d;
};

export interface AiInfo {
  vertexModel: string | null;
  mockModel: string;
}

export function ownerView(db: Db, worldId: string, now: number, ai: AiInfo) {
  const ids = idsFor(worldId);
  const shop = shopOf(db, worldId);
  const tz = shop.timezone;
  const bookings = (
    db.prepare('SELECT b.*, s.name AS service_name, c.display_name FROM bookings b JOIN services s ON s.id = b.service_id JOIN customers c ON c.id = b.customer_id WHERE b.shop_id = ? ORDER BY start_ms').all(shop.id) as Array<{
      id: string; start_ms: number; end_ms: number; status: string; version: number; price_minor: number; service_name: string; display_name: string;
    }>
  ).map((b) => {
    const paid = db.prepare("SELECT kind, status_raw, verified_at FROM payments WHERE booking_id = ?").get(b.id) as { kind: string; status_raw: string; verified_at: number | null } | undefined;
    return {
      customer: b.display_name,
      time: span(b.start_ms, b.end_ms, tz),
      service: b.service_name,
      status: b.status,
      version: b.version,
      price: money(b.price_minor, shop.currency),
      payment: paid ? `${paid.kind === 'A_ORIGINAL' ? 'Paid' : 'Paid (swap)'} · ${paid.status_raw}${paid.verified_at ? ' · verified' : ''}` : 'Not paid',
    };
  });
  const pref = latestPreference(db, ids.aBookingId);
  const req = latestRequest(db, ids.customerBId);
  const evalRow = db.prepare('SELECT * FROM candidate_evaluations WHERE world_id = ? ORDER BY evaluated_at DESC, rowid DESC LIMIT 1').get(worldId) as
    | { feasible: number; result_json: string; evaluated_at: number; case_id: string | null }
    | undefined;
  const cases = (db.prepare('SELECT id FROM swap_cases WHERE world_id = ? ORDER BY rowid DESC').all(worldId) as Array<{ id: string }>).map((r) => {
    const c = getCase(db, r.id)!;
    const obs = obligations(db, c.id).map((o) => ({
      id: o.id,
      kind: o.kind,
      amount: money(o.amount_minor, o.currency),
      status: o.status,
      attempts: o.attempts.map((t) => ({
        no: t.attempt_no,
        status: t.status,
        ops: t.ops.map((op) => ({ kind: op.op_kind, status: op.status, external: op.external_status, reconcile: op.reconcile_status, sends: op.sends, error: op.last_error_class })),
      })),
      retryable: o.status === 'NEEDS_ATTENTION' && o.kind !== 'B_CHARGE' && o.attempts.at(-1)?.status === 'FAILED',
    }));
    return { ...caseView(db, c, 'OWNER', now), profit: profitView(db, c), obligations: obs };
  });
  const attention = (
    db.prepare("SELECT action, detail_json, created_at FROM audit_log WHERE world_id = ? AND action IN ('ATTENTION', 'PRE_CAPTURE_CHECK_FAILED', 'RECOVERY_EXCLUDED') ORDER BY id DESC LIMIT 20").all(worldId) as Array<{
      action: string; detail_json: string; created_at: number;
    }>
  ).map((e) => ({ at: formatLocal(e.created_at, tz), action: e.action, detail: sanitizeDetail(e.detail_json) }));
  const held = db
    .prepare(
      `SELECT count(*) AS n FROM payment_operations o JOIN payment_attempts t ON t.id = o.attempt_id JOIN money_obligations m ON m.id = t.obligation_id
       JOIN swap_cases c ON c.id = m.case_id WHERE c.world_id = ? AND o.last_error_class LIKE 'HOLD:%'`,
    )
    .get(worldId) as { n: number };
  const history = (
    db.prepare('SELECT actor, action, detail_json, created_at, case_id FROM audit_log WHERE world_id = ? ORDER BY id DESC LIMIT 60').all(worldId) as Array<{
      actor: string; action: string; detail_json: string; created_at: number; case_id: string | null;
    }>
  ).map((e) => ({ at: formatLocal(e.created_at, tz), actor: e.actor.startsWith('executor-') ? 'executor' : e.actor, action: e.action, detail: sanitizeDetail(e.detail_json) }));
  return {
    header: header(db, worldId, 'OWNER', now, ai),
    bookings,
    preference: pref
      ? { version: pref.version, source: SOURCE_TEXT[pref.input_source], edited: !!pref.edited, windows: pref.structured.windows, compensation: money(pref.compensation_minor, shop.currency), rawText: pref.raw_text }
      : null,
    request: req
      ? { version: req.version, source: SOURCE_TEXT[req.input_source], edited: !!req.edited, windows: req.structured.windows, service: serviceName(db, req.structured.serviceId), rawText: req.raw_text }
      : null,
    evaluation: evalRow
      ? {
          at: formatLocal(evalRow.evaluated_at, tz),
          feasible: !!evalRow.feasible,
          reasons: (JSON.parse(evalRow.result_json) as { reasons: string[] }).reasons.map((r) => ({ code: r, text: REASON_TEXT[r] ?? r })),
          detail: (JSON.parse(evalRow.result_json) as { detail: unknown }).detail,
        }
      : null,
    cases,
    attention,
    heldOperations: held.n,
    history,
    aiUsage: aiUsage(db, worldId),
  };
}

function aiUsage(db: Db, worldId: string) {
  const rows = db.prepare('SELECT mode, model, outcome, attempts, latency_ms, created_at, kind FROM ai_calls WHERE world_id = ? ORDER BY created_at DESC LIMIT 20').all(worldId) as Array<{
    mode: string; model: string; outcome: string; attempts: number; latency_ms: number | null; created_at: number; kind: string;
  }>;
  return rows.map((r) => ({ mode: r.mode, model: r.model, kind: r.kind, outcome: r.outcome, attempts: r.attempts, latencyMs: r.latency_ms }));
}

function serviceName(db: Db, serviceId: string): string {
  return (db.prepare('SELECT name FROM services WHERE id = ?').get(serviceId) as { name: string } | undefined)?.name ?? '?';
}

export function customerView(db: Db, worldId: string, role: 'A' | 'B', partyId: string, now: number, ai: AiInfo) {
  const ids = idsFor(worldId);
  const shop = shopOf(db, worldId);
  const tz = shop.timezone;
  const blocked = intakeBlocked(db, worldId, role, partyId);
  const caseIds = (
    role === 'A'
      ? db.prepare('SELECT c.id FROM swap_cases c JOIN bookings b ON b.id = c.a_booking_id WHERE b.customer_id = ? AND c.world_id = ? ORDER BY c.rowid DESC').all(partyId, worldId)
      : db.prepare('SELECT c.id FROM swap_cases c JOIN b_requests r ON r.id = c.b_request_id WHERE r.customer_id = ? AND c.world_id = ? ORDER BY c.rowid DESC').all(partyId, worldId)
  ) as Array<{ id: string }>;
  const cases = caseIds.map((r) => caseView(db, getCase(db, r.id)!, role, now));
  const base = { header: header(db, worldId, role, now, ai), draft: draftView(db, worldId, role, partyId), intakeBlocked: blocked, cases };
  if (role === 'A') {
    const b = db.prepare('SELECT b.*, s.name AS service_name FROM bookings b JOIN services s ON s.id = b.service_id WHERE b.id = ?').get(ids.aBookingId) as {
      start_ms: number; end_ms: number; price_minor: number; service_name: string; version: number;
    };
    const paid = db.prepare("SELECT 1 FROM payments WHERE booking_id = ? AND kind = 'A_ORIGINAL' AND verified_at IS NOT NULL").get(ids.aBookingId);
    const aOp = db.prepare("SELECT op_kind, status FROM a_payment_operations WHERE booking_id = ? ORDER BY rowid DESC LIMIT 1").get(ids.aBookingId) as
      | { op_kind: string; status: string }
      | undefined;
    const pref = latestPreference(db, ids.aBookingId);
    return {
      ...base,
      booking: {
        time: span(b.start_ms, b.end_ms, tz),
        service: b.service_name,
        stylist: stylistsOf(db, shop.id)[0]?.name ?? '',
        price: money(b.price_minor, shop.currency),
        payment: paid
          ? { state: 'PAID', text: 'Paid' }
          : aOp
            ? { state: 'WAITING_BUYER', text: aOp.op_kind === 'ORDER_CAPTURE' && aOp.status !== 'NOT_ACCEPTED' && aOp.status !== 'FAILED' ? 'Confirming the payment' : 'Waiting for approval on PayPal' }
            : { state: 'UNPAID', text: 'Not paid yet' },
      },
      preference: pref
        ? {
            version: pref.version,
            windows: pref.structured.windows as LocalWindow[],
            source: SOURCE_TEXT[pref.input_source],
            edited: !!pref.edited,
            rawText: pref.raw_text,
            compensation: money(pref.compensation_minor, shop.currency),
          }
        : null,
      refundNote: `The compensation is refunded to the PayPal account you paid this booking with, as a partial refund of that payment.`,
    };
  }
  const req = latestRequest(db, partyId);
  const evalRow = req
    ? (db.prepare('SELECT * FROM candidate_evaluations WHERE b_request_id = ? ORDER BY evaluated_at DESC, rowid DESC LIMIT 1').get(req.id) as
        | { feasible: number; result_json: string }
        | undefined)
    : undefined;
  return {
    ...base,
    request: req
      ? { version: req.version, windows: req.structured.windows, service: serviceName(db, req.structured.serviceId), source: SOURCE_TEXT[req.input_source], edited: !!req.edited, rawText: req.raw_text }
      : null,
    result: evalRow
      ? {
          feasible: !!evalRow.feasible,
          reasons: (JSON.parse(evalRow.result_json) as { reasons: string[] }).reasons.map((r) => REASON_TEXT[r] ?? 'The requested time cannot be offered.'),
        }
      : null,
  };
}
