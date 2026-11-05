// Free text -> structured conditions -> the person's confirmation (DESIGN 9, 6.1 steps 2-3; AC03).
// - The AI (Vertex or mock, by the world's mode) only proposes. Its proposal and questions stay on the draft.
// - If the AI fails (timeout, API error, invalid output, quota, not configured) the draft switches to the manual
//   form and says why; nothing falls back to the mock AI.
// - Vague expressions come back as questions. A proposal with open questions cannot be confirmed unchanged: the
//   person answers (a new AI call on the text plus the answers) or fills the form themselves.
// - Confirming writes a new version (flex_preferences / b_requests) with the original text, the confirmed
//   structure, the input source and whether the person edited the proposal. A's compensation is fixed from the
//   shop's rule at this moment (D09).

import { randomUUID } from 'node:crypto';
import { immediate, type Db } from '../db/database.ts';
import type { Clock } from '../clock.ts';
import type { AiFailure, AiService } from '../ai/service.ts';
import { validateStructured, type APreference, type BRequest, type StructureKind } from '../ai/structure.ts';
import { TERMINAL_CASE_STATUSES } from '../db/schema.ts';
import { audit } from '../executor/store.ts';
import { idsFor, shopOf, structureContextFor } from './world.ts';

export interface LocalWindow {
  date: string;
  start: string;
  end: string;
}

/** Confirmed A conditions (flex_preferences.structured_json). Same stylist and service only in this MVP. */
export interface APrefStructured {
  windows: LocalWindow[];
  sameStylist: true;
  sameService: true;
}

/** Confirmed B request (b_requests.structured_json). stylistId null = the stylist of the booking being swapped. */
export interface BReqStructured {
  serviceId: string;
  windows: LocalWindow[];
  stylistId: string | null;
}

export type IntakeRole = 'A' | 'B';
export type Question = { field: string; question: string };

export interface DraftRow {
  id: string;
  world_id: string;
  kind: StructureKind;
  party_id: string;
  raw_text: string;
  source: 'AI_VERTEX' | 'AI_MOCK' | 'MANUAL';
  ai_call_id: string | null;
  manual_reason: string | null;
  proposal_json: string | null;
  questions_json: string;
  previous_draft_id: string | null;
  status: 'OPEN' | 'CONFIRMED' | 'SUPERSEDED';
  created_at: number;
}

export interface IntakeDeps {
  db: Db;
  clock: Clock;
  ai: AiService;
}

export type Refusal = { ok: false; reason: string; issues?: string[] };
const no = (reason: string, issues?: string[]): Refusal => (issues ? { ok: false, reason, issues } : { ok: false, reason });

export const MAX_TEXT = 2000;
export const MAX_WINDOWS = 5;

const kindOf = (role: IntakeRole): StructureKind => (role === 'A' ? 'A_PREFERENCE' : 'B_REQUEST');
const TERMINAL = TERMINAL_CASE_STATUSES.map((s) => `'${s}'`).join(', ');

/** Why this party cannot change its conditions now, or null. */
export function intakeBlocked(db: Db, worldId: string, role: IntakeRole, partyId: string): string | null {
  const done = db.prepare("SELECT 1 FROM swap_cases WHERE world_id = ? AND status = 'COMPLETED'").get(worldId);
  if (done) return 'SWAP_DONE';
  const active =
    role === 'A'
      ? db.prepare(`SELECT 1 FROM swap_cases c JOIN bookings b ON b.id = c.a_booking_id WHERE b.customer_id = ? AND c.status NOT IN (${TERMINAL})`).get(partyId)
      : db.prepare(`SELECT 1 FROM swap_cases c JOIN b_requests r ON r.id = c.b_request_id WHERE r.customer_id = ? AND c.status NOT IN (${TERMINAL})`).get(partyId);
  return active ? 'CASE_IN_PROGRESS' : null;
}

/** The proposal as form values (what the person sees prefilled). */
export function proposalToForm(role: IntakeRole, proposal: APreference | BRequest): APrefStructured | { serviceId: string | null; windows: LocalWindow[]; stylistId: string | null } {
  if (role === 'A') {
    const p = proposal as APreference;
    return { windows: p.allowed_windows.map((w) => ({ ...w })), sameStylist: true, sameService: true };
  }
  const p = proposal as BRequest;
  return { serviceId: p.service_id, windows: p.required_windows.map((w) => ({ ...w })), stylistId: p.stylist_id };
}

function questionsFor(role: IntakeRole, proposal: APreference | BRequest): Question[] {
  const qs: Question[] = proposal.ambiguities.map((a) => ({ field: a.field, question: a.question }));
  const windows = role === 'A' ? (proposal as APreference).allowed_windows : (proposal as BRequest).required_windows;
  // The program adds the questions the model left out: no time at all, or no service for B.
  if (windows.length === 0 && qs.length === 0) qs.push({ field: role === 'A' ? 'allowed_windows' : 'required_windows', question: 'Which date and time window works for you?' });
  if (role === 'B' && (proposal as BRequest).service_id === null && !qs.some((q) => q.field === 'service_id')) {
    qs.push({ field: 'service_id', question: 'Which service would you like?' });
  }
  return qs;
}

export type DraftResult = { ok: true; draftId: string; aiFailure: AiFailure | null } | Refusal;

export async function createDraft(
  d: IntakeDeps,
  req: { worldId: string; role: IntakeRole; partyId: string; text: string; useAi: boolean; previousDraftId?: string | null },
): Promise<DraftResult> {
  const text = req.text.trim();
  if (text.length === 0 || text.length > MAX_TEXT) return no('TEXT_LENGTH');
  const blocked = intakeBlocked(d.db, req.worldId, req.role, req.partyId);
  if (blocked) return no(blocked);
  const kind = kindOf(req.role);
  let source: DraftRow['source'] = 'MANUAL';
  let aiCallId: string | null = null;
  let manualReason: string | null = req.useAi ? null : 'CHOSEN_MANUAL';
  let proposal: APreference | BRequest | null = null;
  let aiFailure: AiFailure | null = null;
  if (req.useAi) {
    const ctx = structureContextFor(d.db, req.worldId, d.clock.now());
    const r = await d.ai.structure(req.worldId, kind, text, ctx);
    if (r.ok) {
      source = r.source;
      aiCallId = r.callId;
      proposal = r.value;
    } else {
      // DESIGN 9: switch to the manual form and say so. The AI call (if any) stays recorded in ai_calls.
      aiFailure = r.reason;
      manualReason = `AI_${r.reason}`;
    }
  }
  const now = d.clock.now();
  const draftId = randomUUID();
  try {
    writeDraft();
  } catch (e) {
    if (e instanceof IntakeRefused) return no(e.reason);
    throw e;
  }
  return { ok: true, draftId, aiFailure };

  function writeDraft(): void {
  immediate(d.db, () => {
    // Re-check under the write lock: a case may have started while the AI was answering.
    const again = intakeBlocked(d.db, req.worldId, req.role, req.partyId);
    if (again) throw new IntakeRefused(again);
    d.db.prepare("UPDATE intake_drafts SET status = 'SUPERSEDED' WHERE world_id = ? AND party_id = ? AND kind = ? AND status = 'OPEN'").run(req.worldId, req.partyId, kind);
    d.db
      .prepare(
        `INSERT INTO intake_drafts (id, world_id, kind, party_id, raw_text, source, ai_call_id, manual_reason, proposal_json, questions_json, previous_draft_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
      )
      .run(
        draftId, req.worldId, kind, req.partyId, text, source, aiCallId, manualReason,
        proposal ? JSON.stringify(proposal) : null, JSON.stringify(proposal ? questionsFor(req.role, proposal) : []), req.previousDraftId ?? null, now,
      );
    audit(d.db, now, { worldId: req.worldId, actor: req.role, action: 'INTAKE_DRAFT', detail: { draftId, kind, source, manualReason } });
  });
  }
}

class IntakeRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export function getDraft(db: Db, draftId: string): DraftRow | undefined {
  return db.prepare('SELECT * FROM intake_drafts WHERE id = ?').get(draftId) as DraftRow | undefined;
}

/** Answers to the draft's questions: the text plus the answers is structured again (a new AI call). */
export async function answerDraft(d: IntakeDeps, req: { worldId: string; role: IntakeRole; partyId: string; draftId: string; answers: string[] }): Promise<DraftResult> {
  const draft = getDraft(d.db, req.draftId);
  if (!draft || draft.world_id !== req.worldId || draft.party_id !== req.partyId || draft.kind !== kindOf(req.role)) return no('DRAFT_NOT_FOUND');
  if (draft.status !== 'OPEN') return no('DRAFT_NOT_OPEN');
  if (draft.source === 'MANUAL') return no('NO_QUESTIONS');
  const answers = req.answers.map((a) => a.trim()).filter((a) => a.length > 0);
  if (answers.length === 0) return no('NO_ANSWERS');
  const text = `${draft.raw_text}\n${answers.join('\n')}`;
  if (text.length > MAX_TEXT) return no('TEXT_LENGTH');
  try {
    return await createDraft(d, { worldId: req.worldId, role: req.role, partyId: req.partyId, text, useAi: true, previousDraftId: draft.id });
  } catch (e) {
    if (e instanceof IntakeRefused) return no(e.reason);
    throw e;
  }
}

export interface ConfirmForm {
  windows: LocalWindow[];
  /** B only. */
  serviceId?: string | null;
  stylistId?: string | null;
}

export type ConfirmResult = { ok: true; versionId: string; version: number; edited: boolean } | Refusal;

const normWindows = (ws: LocalWindow[]) =>
  ws
    .map((w) => `${w.date} ${w.start}-${w.end}`)
    .sort()
    .join('|');

/**
 * The person confirms the structure (possibly edited). `afterConfirm` runs in the same transaction (B: the
 * candidate check and the proposal, DESIGN 6.1 steps 4-5).
 */
export function confirmDraft(
  d: Pick<IntakeDeps, 'db' | 'clock'>,
  req: { worldId: string; role: IntakeRole; partyId: string; draftId: string; form: ConfirmForm },
  afterConfirm?: (versionId: string) => void,
): ConfirmResult {
  const { db } = d;
  const now = d.clock.now();
  const ctx = structureContextFor(db, req.worldId, now);
  const form = req.form;
  if (form.windows.length === 0 || form.windows.length > MAX_WINDOWS) return no('WINDOWS_COUNT');
  // The same server checks as for AI output (types, dates today..+60 d, business hours, known ids).
  const asStructured =
    req.role === 'A'
      ? { allowed_windows: form.windows, stylist_change_allowed: false, service_change_allowed: false, ambiguities: [] }
      : { service_id: form.serviceId ?? null, stylist_id: form.stylistId ?? null, required_windows: form.windows, ambiguities: [] };
  const checked = validateStructured(kindOf(req.role), asStructured, ctx);
  if (!checked.ok) return no('FORM_INVALID', checked.issues);
  if (req.role === 'B' && !form.serviceId) return no('FORM_INVALID', ['service_id: required']);

  try {
    return immediate(db, (): ConfirmResult => {
      const draft = getDraft(db, req.draftId);
      if (!draft || draft.world_id !== req.worldId || draft.party_id !== req.partyId || draft.kind !== kindOf(req.role)) return no('DRAFT_NOT_FOUND');
      if (draft.status !== 'OPEN') return no('DRAFT_NOT_OPEN');
      const blocked = intakeBlocked(db, req.worldId, req.role, req.partyId);
      if (blocked) return no(blocked);
      const proposal = draft.proposal_json ? (JSON.parse(draft.proposal_json) as APreference | BRequest) : null;
      const questions = JSON.parse(draft.questions_json) as Question[];
      let edited = false;
      if (proposal) {
        const p = proposalToForm(req.role, proposal) as { windows: LocalWindow[]; serviceId?: string | null; stylistId?: string | null };
        edited =
          normWindows(p.windows) !== normWindows(form.windows) ||
          (req.role === 'B' && ((p.serviceId ?? null) !== (form.serviceId ?? null) || (p.stylistId ?? null) !== (form.stylistId ?? null)));
        // A vague expression must not become a concrete time silently (DESIGN 9).
        if (questions.length > 0 && !edited) return no('QUESTIONS_UNANSWERED');
      }
      let versionId: string;
      let version: number;
      if (req.role === 'A') {
        const ids = idsFor(req.worldId);
        const booking = db.prepare("SELECT id FROM bookings WHERE customer_id = ? AND status = 'CONFIRMED' ORDER BY rowid LIMIT 1").get(req.partyId) as
          | { id: string }
          | undefined;
        if (!booking || req.partyId !== ids.customerAId) return no('NO_BOOKING');
        version = ((db.prepare('SELECT max(version) AS v FROM flex_preferences WHERE booking_id = ?').get(booking.id) as { v: number | null }).v ?? 0) + 1;
        versionId = `${booking.id}:pref:v${version}`;
        const structured: APrefStructured = { windows: form.windows, sameStylist: true, sameService: true };
        const comp = shopOf(db, req.worldId).compensation_minor; // D09: fixed with this version
        db.prepare(
          `INSERT INTO flex_preferences (id, booking_id, version, raw_text, structured_json, input_source, confirmed_at, compensation_minor, draft_id, edited)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(versionId, booking.id, version, draft.raw_text, JSON.stringify(structured), draft.source, now, comp, draft.id, edited ? 1 : 0);
      } else {
        version = ((db.prepare('SELECT max(version) AS v FROM b_requests WHERE customer_id = ?').get(req.partyId) as { v: number | null }).v ?? 0) + 1;
        versionId = `${req.worldId}:request:b:v${version}`;
        const structured: BReqStructured = { serviceId: form.serviceId!, windows: form.windows, stylistId: form.stylistId ?? null };
        db.prepare(
          `INSERT INTO b_requests (id, world_id, customer_id, version, raw_text, structured_json, input_source, confirmed_at, draft_id, edited)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(versionId, req.worldId, req.partyId, version, draft.raw_text, JSON.stringify(structured), draft.source, now, draft.id, edited ? 1 : 0);
      }
      db.prepare("UPDATE intake_drafts SET status = 'CONFIRMED' WHERE id = ? AND status = 'OPEN'").run(draft.id);
      audit(db, now, { worldId: req.worldId, actor: req.role, action: req.role === 'A' ? 'A_PREFERENCE_CONFIRMED' : 'B_REQUEST_CONFIRMED', detail: { versionId, version, source: draft.source, edited } });
      afterConfirm?.(versionId);
      return { ok: true, versionId, version, edited };
    });
  } catch (e) {
    if (e instanceof IntakeRefused) return no(e.reason);
    throw e;
  }
}

/** Latest confirmed A conditions of a booking. */
export function latestPreference(db: Db, bookingId: string):
  | { id: string; version: number; raw_text: string; structured: APrefStructured; input_source: string; edited: number; compensation_minor: number; confirmed_at: number }
  | undefined {
  const r = db
    .prepare('SELECT * FROM flex_preferences WHERE booking_id = ? AND confirmed_at IS NOT NULL ORDER BY version DESC LIMIT 1')
    .get(bookingId) as { id: string; version: number; raw_text: string; structured_json: string; input_source: string; edited: number; compensation_minor: number; confirmed_at: number } | undefined;
  return r ? { ...r, structured: JSON.parse(r.structured_json) as APrefStructured } : undefined;
}

/** Latest confirmed B request of a customer. */
export function latestRequest(db: Db, customerId: string):
  | { id: string; version: number; raw_text: string; structured: BReqStructured; input_source: string; edited: number; confirmed_at: number }
  | undefined {
  const r = db
    .prepare('SELECT * FROM b_requests WHERE customer_id = ? AND confirmed_at IS NOT NULL ORDER BY version DESC LIMIT 1')
    .get(customerId) as { id: string; version: number; raw_text: string; structured_json: string; input_source: string; edited: number; confirmed_at: number } | undefined;
  return r ? { ...r, structured: JSON.parse(r.structured_json) as BReqStructured } : undefined;
}
