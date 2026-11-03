// V9: Gemini on Vertex AI structured output with the three DESIGN 9 examples (A, B, ambiguous), plus a
// deliberately tiny timeout to see that a slow call ends as TIMEOUT instead of hanging.
// Options: --model <id> (overrides FLEXSLOT_AI_MODEL), --thinking MINIMAL|LOW|MEDIUM|HIGH.

import type { ThinkingLevel } from '@google/genai';
import { sampleStructureContext } from '../../src/ai/sample-context.ts';
import type { APreference, BRequest } from '../../src/ai/structure.ts';
import { createVertexModels, loadVertexConfig, structureText, type StructureOutcome } from '../../src/ai/vertex.ts';
import { loadDotEnv, run } from './_lib.ts';

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const EXAMPLES = {
  A: 'もし11月10日（火）の10時から12時のあいだに施術が終わるなら、予約を移動しても大丈夫です。担当はMikaさんのままでお願いします。それと、補償は50ドルにしてください。',
  B: '11月7日の14時から15時しか行けません。カットをお願いしたいです。',
  AMBIGUOUS: '来週の午後ならいつでも行けます。カラーもしたいかもしれません。',
};

function describe<K extends 'A_PREFERENCE' | 'B_REQUEST'>(r: { note: (k: string, v: string | number | boolean) => void }, label: string, o: StructureOutcome<K>) {
  r.note(`${label}_outcome`, o.kind);
  r.note(`${label}_latency_ms`, o.latencyMs);
  r.note(`${label}_attempts`, o.attempts);
  if (o.kind === 'OK' || o.kind === 'INVALID_OUTPUT') {
    r.note(`${label}_tokens`, `prompt=${o.usage.promptTokens ?? '-'} output=${o.usage.outputTokens ?? '-'} thoughts=${o.usage.thoughtsTokens ?? '-'} total=${o.usage.totalTokens ?? '-'}`);
  }
  if (o.kind === 'INVALID_OUTPUT') r.note(`${label}_issues`, o.issues.join('; '));
  if (o.kind === 'API_ERROR') r.note(`${label}_error`, `${o.errorName} http=${o.httpStatus ?? '-'}`);
}

await run('V9', 'VERTEX', async (r) => {
  r.note('env_source', loadDotEnv() ? '.env' : 'shell');
  const cfg = loadVertexConfig(process.env);
  const model = arg('--model') ?? cfg.model;
  const thinking = arg('--thinking') as ThinkingLevel | undefined;
  r.note('model', model);
  r.note('location', cfg.location);
  r.note('thinking_level', thinking ?? '(model default)');
  const models = createVertexModels(cfg);
  const ctx = sampleStructureContext('demo');
  const opts = thinking ? { thinkingLevel: thinking } : {};

  const a = await structureText(models, model, 'A_PREFERENCE', EXAMPLES.A, ctx, opts);
  describe(r, 'A', a);
  if (r.check('A: schema-valid JSON', a.kind === 'OK') && a.kind === 'OK') {
    const v: APreference = a.value;
    r.note('A_windows', v.allowed_windows.map((w) => `${w.date} ${w.start}-${w.end}`).join(' | ') || '-');
    r.note('A_ambiguities', v.ambiguities.length);
    r.check('A: window 2026-11-10 10:00-12:00', v.allowed_windows.some((w) => w.date === '2026-11-10' && w.start === '10:00' && w.end === '12:00'));
    r.check('A: stylist change not allowed', v.stylist_change_allowed === false);
  }

  const b = await structureText(models, model, 'B_REQUEST', EXAMPLES.B, ctx, opts);
  describe(r, 'B', b);
  if (r.check('B: schema-valid JSON', b.kind === 'OK') && b.kind === 'OK') {
    const v: BRequest = b.value;
    r.note('B_service', v.service_id ?? 'null');
    r.note('B_windows', v.required_windows.map((w) => `${w.date} ${w.start}-${w.end}`).join(' | ') || '-');
    r.note('B_ambiguities', v.ambiguities.length);
    r.check('B: service is Cut', v.service_id === 'demo:service:cut');
    r.check('B: window 2026-11-07 14:00-15:00', v.required_windows.some((w) => w.date === '2026-11-07' && w.start === '14:00' && w.end === '15:00'));
  }

  const c = await structureText(models, model, 'B_REQUEST', EXAMPLES.AMBIGUOUS, ctx, opts);
  describe(r, 'AMBIGUOUS', c);
  if (r.check('AMBIGUOUS: schema-valid JSON', c.kind === 'OK') && c.kind === 'OK') {
    r.note('AMBIGUOUS_windows', c.value.required_windows.map((w) => `${w.date} ${w.start}-${w.end}`).join(' | ') || '-');
    r.note('AMBIGUOUS_service', c.value.service_id ?? 'null');
    r.note('AMBIGUOUS_questions', c.value.ambiguities.length);
    r.check('AMBIGUOUS: asks at least one clarifying question', c.value.ambiguities.length >= 1);
  }

  const started = Date.now();
  const t = await structureText(models, model, 'A_PREFERENCE', EXAMPLES.A, ctx, { ...opts, timeoutMs: 1 });
  r.note('TIMEOUT_outcome', t.kind);
  r.note('TIMEOUT_returned_after_ms', Date.now() - started);
  r.check('1 ms timeout ends as TIMEOUT without hanging', t.kind === 'TIMEOUT' && Date.now() - started < 5000);
});
