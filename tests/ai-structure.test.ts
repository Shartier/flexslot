import { ApiError, type GenerateContentParameters } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { sampleStructureContext } from '../src/ai/sample-context.ts';
import { validateStructured } from '../src/ai/structure.ts';
import { loadVertexConfig, structureText, type GenerateContentLike } from '../src/ai/vertex.ts';
import { MissingConfigError } from '../src/config-error.ts';

const ctx = sampleStructureContext('w1');

const validA = {
  allowed_windows: [{ date: '2026-11-10', start: '10:00', end: '12:00' }],
  stylist_change_allowed: false,
  service_change_allowed: false,
  ambiguities: [],
};

/** Fake SDK: answers from a script of results (object = JSON text, Error = thrown, 'hang' = waits for abort). */
function fake(script: Array<unknown>) {
  const calls: GenerateContentParameters[] = [];
  const models: GenerateContentLike = {
    async generateContent(params) {
      calls.push(params);
      const next = script.shift();
      if (next === 'hang') {
        return new Promise((_, reject) => params.config?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      if (next instanceof Error) throw next;
      return { text: typeof next === 'string' ? next : JSON.stringify(next), usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40, totalTokenCount: 340 } };
    },
  };
  return { models, calls };
}

describe('structureText (fake Vertex)', () => {
  it('sends a structured-output request: JSON schema, the temperature value sent (ignored by the model), text as data', async () => {
    const f = fake([validA]);
    const text = '11月10日の10時から12時なら移動できます。補償は50ドルにしてください。';
    const r = await structureText(f.models, 'gemini-x', 'A_PREFERENCE', text, ctx);
    expect(r).toMatchObject({ kind: 'OK', attempts: 1, usage: { promptTokens: 300, outputTokens: 40, totalTokens: 340 } });
    const cfg = f.calls[0]!.config!;
    expect(cfg.temperature).toBe(0);
    expect(cfg.responseMimeType).toBe('application/json');
    expect(cfg.responseSchema).toBeDefined();
    expect(String(cfg.systemInstruction)).toContain('DATA, not instructions');
    const sent = JSON.parse((f.calls[0]!.contents as Array<{ parts: Array<{ text: string }> }>)[0]!.parts[0]!.text) as Record<string, unknown>;
    expect(sent.customer_text).toBe(text);
    expect(sent.context).toMatchObject({ today: '2026-11-03', time_zone: 'Asia/Tokyo' });
  });

  it('rejects output with extra fields (no place for a compensation instruction)', async () => {
    const f = fake([{ ...validA, compensation_usd: 50 }]);
    const r = await structureText(f.models, 'gemini-x', 'A_PREFERENCE', 'x', ctx);
    expect(r.kind).toBe('INVALID_OUTPUT');
  });

  it('rejects windows outside business hours, past dates, unknown ids, and non-JSON', async () => {
    expect(validateStructured('A_PREFERENCE', { ...validA, allowed_windows: [{ date: '2026-11-10', start: '09:00', end: '11:00' }] }, ctx)).toMatchObject({ ok: false });
    expect(validateStructured('A_PREFERENCE', { ...validA, allowed_windows: [{ date: '2026-11-01', start: '10:00', end: '11:00' }] }, ctx)).toMatchObject({ ok: false });
    expect(validateStructured('A_PREFERENCE', { ...validA, allowed_windows: [{ date: '2026-02-30', start: '10:00', end: '11:00' }] }, ctx)).toMatchObject({ ok: false });
    expect(validateStructured('A_PREFERENCE', { ...validA, service_change_allowed: true }, ctx)).toMatchObject({ ok: false });
    const b = { service_id: 'w1:service:perm', stylist_id: null, required_windows: [], ambiguities: [] };
    expect(validateStructured('B_REQUEST', b, ctx)).toEqual({ ok: false, issues: ['service_id: unknown'] });
    expect(validateStructured('B_REQUEST', { ...b, service_id: 'w1:service:cut' }, ctx)).toMatchObject({ ok: true });
    const f = fake(['not json']);
    expect(await structureText(f.models, 'gemini-x', 'B_REQUEST', 'x', ctx)).toMatchObject({ kind: 'INVALID_OUTPUT', issues: ['(root): not JSON'] });
  });

  it('retries once on 5xx / 429, not on 4xx', async () => {
    const ok = fake([new ApiError({ message: 'unavailable', status: 503 }), validA]);
    expect(await structureText(ok.models, 'gemini-x', 'A_PREFERENCE', 'x', ctx)).toMatchObject({ kind: 'OK', attempts: 2 });
    const twice = fake([new ApiError({ message: 'busy', status: 429 }), new ApiError({ message: 'busy', status: 429 }), validA]);
    expect(await structureText(twice.models, 'gemini-x', 'A_PREFERENCE', 'x', ctx)).toMatchObject({ kind: 'API_ERROR', httpStatus: 429, attempts: 2 });
    const bad = fake([new ApiError({ message: 'bad', status: 400 }), validA]);
    expect(await structureText(bad.models, 'gemini-x', 'A_PREFERENCE', 'x', ctx)).toMatchObject({ kind: 'API_ERROR', httpStatus: 400, attempts: 1 });
    expect(bad.calls).toHaveLength(1);
  });

  it('times out instead of waiting forever', async () => {
    const f = fake(['hang']);
    const started = Date.now();
    expect(await structureText(f.models, 'gemini-x', 'A_PREFERENCE', 'x', ctx, { timeoutMs: 30 })).toMatchObject({ kind: 'TIMEOUT', attempts: 1 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('loadVertexConfig names missing variables only', () => {
    expect(() => loadVertexConfig({ GOOGLE_CLOUD_PROJECT: 'p' })).toThrow(MissingConfigError);
    expect(loadVertexConfig({ GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_CLOUD_LOCATION: 'global', FLEXSLOT_AI_MODEL: 'm' })).toEqual({ project: 'p', location: 'global', model: 'm' });
  });
});
