// The mock AI (DESIGN 9, 10): fixed text rules for tests and offline demos, shown on the screens as "AI: mock".
// It is NOT evidence that the real AI works (AC03). Like the real model it only proposes: its output goes through
// the same server checks (validateStructured) and the person confirms it. It reads dates and explicit time ranges,
// sends vague expressions ("afternoon", "午後", "next week") to a clarifying question, and has no field for money,
// approval or payment, so instructions in the text are ignored.

import type { AiStructurer } from './port.ts';
import { validateStructured, type StructureContext, type StructureKind } from './structure.ts';
import type { StructureOptions, StructureOutcome } from './vertex.ts';

export const MOCK_AI_MODEL = 'mock-rules-v1';

const JA = /[぀-ヿ一-鿿]/;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// A time with an explicit marker (":MM", am/pm, or 時) so that bare numbers (dates, counts) are never times.
const TIME_SRC = String.raw`(?:午後|午前)?\s*\d{1,2}(?::\d{2}\s*(?:am|pm)?|\s*(?:am|pm)|時(?:\d{1,2}分|半)?)`;
const SEP_SRC = String.raw`\s*(?:-|–|—|〜|~|～|to|から|until|till|and)\s*`;
const RANGE = new RegExp(`(${TIME_SRC})${SEP_SRC}(${TIME_SRC})(?:\\s*まで)?`, 'gi');
const VAGUE = /(午後|午前中|夕方|朝|夜|昼過ぎ|来週|週末|いつでも|afternoon|morning|evening|tonight|night|next week|weekend|any ?time|sometime|later)/i;

interface DateHit {
  index: number;
  length: number;
  date: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function realDate(y: number, m: number, d: number): string | null {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Month/day without a year: this year, or next year if that day has passed (shop-local "today"). */
function inferYear(today: string, m: number, d: number): string | null {
  const year = Number(today.slice(0, 4));
  const thisYear = realDate(year, m, d);
  if (thisYear && thisYear >= today) return thisYear;
  return realDate(year + 1, m, d);
}

function findDates(text: string, today: string): DateHit[] {
  const hits: DateHit[] = [];
  const add = (re: RegExp, toDate: (m: RegExpExecArray) => string | null) => {
    for (const m of text.matchAll(re)) {
      const date = toDate(m as RegExpExecArray);
      const index = m.index ?? 0;
      if (date && !hits.some((h) => index < h.index + h.length && h.index < index + m[0].length)) hits.push({ index, length: m[0].length, date });
    }
  };
  add(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g, (m) => realDate(Number(m[1]), Number(m[2]), Number(m[3])));
  add(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/g, (m) => (m[1] ? realDate(Number(m[1]), Number(m[2]), Number(m[3])) : inferYear(today, Number(m[2]), Number(m[3]))));
  add(/(?<![\d/:])(\d{1,2})\/(\d{1,2})(?![\d/:])/g, (m) => inferYear(today, Number(m[1]), Number(m[2])));
  add(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi, (m) =>
    inferYear(today, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, Number(m[2])),
  );
  return hits.sort((a, b) => a.index - b.index);
}

/** "14:00", "2pm", "午後2時", "10時半" -> "HH:MM"; `pmFrom` carries 午後/pm from the start of a range to its end. */
function parseTime(token: string, pmFrom = false): { hhmm: string; pm: boolean } | null {
  const pm = /午後|pm/i.test(token);
  const am = /午前|am/i.test(token);
  const m = /(\d{1,2})(?::(\d{2})|時(?:(\d{1,2})分|(半))?)?/.exec(token);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : m[4] ? 30 : 0;
  if ((pm || (pmFrom && !am)) && h < 12) h += 12;
  if (am && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { hhmm: `${pad(h)}:${pad(min)}`, pm };
}

export interface MockParse {
  windows: Array<{ date: string; start: string; end: string }>;
  questions: Array<{ field: string; question: string }>;
}

export function mockParse(kind: StructureKind, text: string, ctx: StructureContext): MockParse {
  const ja = JA.test(text);
  const field = kind === 'A_PREFERENCE' ? 'allowed_windows' : 'required_windows';
  const dates = findDates(text, ctx.today);
  let masked = text;
  const mask = (index: number, length: number) => {
    masked = masked.slice(0, index) + ' '.repeat(length) + masked.slice(index + length);
  };
  for (const d of dates) mask(d.index, d.length);
  const ranges: Array<{ index: number; start: string; end: string }> = [];
  for (const m of masked.matchAll(RANGE)) {
    const start = parseTime(m[1]!);
    const end = start && parseTime(m[2]!, start.pm);
    // The pattern may start with the spaces that replaced a date: the range begins at its first non-space.
    if (start && end) ranges.push({ index: (m.index ?? 0) + (m[0].length - m[0].trimStart().length), start: start.hhmm, end: end.hhmm });
  }
  for (const m of [...masked.matchAll(RANGE)]) mask(m.index ?? 0, m[0].length);

  const windows: MockParse['windows'] = [];
  const questions: MockParse['questions'] = [];
  let rangeWithoutDate = false;
  for (const r of ranges) {
    const date = [...dates].reverse().find((d) => d.index < r.index)?.date;
    if (!date) rangeWithoutDate = true;
    else if (!windows.some((w) => w.date === date && w.start === r.start && w.end === r.end)) windows.push({ date, start: r.start, end: r.end });
  }
  // A vague word is a question only when no explicit range was given ("11/10 afternoon 13:00-15:00" is precise).
  const vague = windows.length === 0 ? VAGUE.exec(masked)?.[1] : undefined;
  if (vague) {
    questions.push({ field, question: ja ? `「${vague}」は具体的に何時から何時までですか？（例：10:00〜12:00）` : `What exact time window do you mean by "${vague}"? (e.g. 10:00-12:00)` });
  } else if (windows.length === 0 || rangeWithoutDate) {
    questions.push({
      field,
      question: ja ? 'ご希望の日付と時間帯を教えてください（例：11月10日 10:00〜12:00）。' : 'Which date and time window works for you (e.g. Nov 10 10:00-12:00)?',
    });
  }
  return { windows, questions };
}

function mockStructured(kind: StructureKind, text: string, ctx: StructureContext): unknown {
  const { windows, questions } = mockParse(kind, text, ctx);
  if (kind === 'A_PREFERENCE') {
    return { allowed_windows: windows, stylist_change_allowed: false, service_change_allowed: false, ambiguities: questions };
  }
  const color = ctx.services.find((s) => /colou?r/i.test(s.name));
  const cut = ctx.services.find((s) => /cut/i.test(s.name) && !/colou?r/i.test(s.name));
  const serviceId = /カラー|colou?r/i.test(text) ? (color?.id ?? null) : /カット|cut/i.test(text) ? (cut?.id ?? null) : null;
  if (serviceId === null) {
    questions.push({
      field: 'service_id',
      question: JA.test(text) ? 'ご希望の施術はカットとカット＋カラーのどちらですか？' : 'Which service would you like: Cut or Cut + Color?',
    });
  }
  const stylist = ctx.stylists.find((s) => new RegExp(`\\b${s.name}\\b`, 'i').test(text));
  return { service_id: serviceId, stylist_id: stylist?.id ?? null, required_windows: windows, ambiguities: questions };
}

export class MockStructurer implements AiStructurer {
  readonly mode = 'MOCK' as const;
  readonly model = MOCK_AI_MODEL;

  async structure<K extends StructureKind>(kind: K, text: string, ctx: StructureContext, opts: StructureOptions = {}): Promise<StructureOutcome<K>> {
    const refused = opts.beforeAttempt?.(1) ?? null;
    if (refused) return { kind: 'QUOTA', scope: refused, latencyMs: 0, attempts: 0 };
    const checked = validateStructured(kind, mockStructured(kind, text, ctx), ctx);
    return checked.ok
      ? { kind: 'OK', value: checked.value, latencyMs: 0, usage: {}, attempts: 1 }
      : { kind: 'INVALID_OUTPUT', issues: checked.issues, latencyMs: 0, usage: {}, attempts: 1 };
  }
}
