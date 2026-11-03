// Minimal Gemini on Vertex AI call (DESIGN 9): ADC authentication, structured output, temperature 0,
// 20 s timeout, one retry on 5xx/429 only. The full AI adapter (mock mode, quotas, input source) comes later.

import { ApiError, GoogleGenAI, type GenerateContentParameters, type ThinkingLevel } from '@google/genai';
import { MissingConfigError, present, type Env } from '../config-error.ts';
import {
  RESPONSE_SCHEMA,
  SYSTEM_INSTRUCTION,
  userContent,
  validateStructured,
  type StructureContext,
  type StructureKind,
  type Structured,
} from './structure.ts';

export const DEFAULT_AI_TIMEOUT_MS = 20_000;

export interface VertexConfig {
  project: string;
  location: string;
  model: string;
}

export function loadVertexConfig(env: Env): VertexConfig {
  const keys = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'FLEXSLOT_AI_MODEL'] as const;
  const missing = keys.filter((k) => !present(env[k]));
  if (missing.length > 0) throw new MissingConfigError(missing);
  return { project: env.GOOGLE_CLOUD_PROJECT!.trim(), location: env.GOOGLE_CLOUD_LOCATION!.trim(), model: env.FLEXSLOT_AI_MODEL!.trim() };
}

export interface Usage {
  promptTokens?: number;
  outputTokens?: number;
  thoughtsTokens?: number;
  totalTokens?: number;
}

/** The slice of the SDK this module uses; tests pass a fake. */
export interface GenerateContentLike {
  generateContent(params: GenerateContentParameters): Promise<{
    text?: string | undefined;
    usageMetadata?: {
      promptTokenCount?: number | undefined;
      candidatesTokenCount?: number | undefined;
      thoughtsTokenCount?: number | undefined;
      totalTokenCount?: number | undefined;
    } | undefined;
  }>;
}

/** Vertex AI client authenticated with Application Default Credentials (no key file, nothing sent to the browser). */
export function createVertexModels(cfg: VertexConfig): GenerateContentLike {
  return new GoogleGenAI({ vertexai: true, project: cfg.project, location: cfg.location }).models;
}

export type StructureOutcome<K extends StructureKind> =
  | { kind: 'OK'; value: Structured<K>; latencyMs: number; usage: Usage; attempts: number }
  | { kind: 'INVALID_OUTPUT'; issues: string[]; latencyMs: number; usage: Usage; attempts: number }
  | { kind: 'TIMEOUT'; latencyMs: number; attempts: number }
  | { kind: 'API_ERROR'; httpStatus?: number; errorName: string; latencyMs: number; attempts: number };

export interface StructureOptions {
  timeoutMs?: number;
  thinkingLevel?: ThinkingLevel;
}

export async function structureText<K extends StructureKind>(
  models: GenerateContentLike,
  model: string,
  kind: K,
  text: string,
  ctx: StructureContext,
  opts: StructureOptions = {},
): Promise<StructureOutcome<K>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  for (let attempt = 1; ; attempt++) {
    // The timeout covers this attempt only. Aborting stops waiting on our side; Vertex may still finish the call.
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: userContent(kind, text, ctx) }] }],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          temperature: 0,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA[kind],
          abortSignal: signal,
          ...(opts.thinkingLevel ? { thinkingConfig: { thinkingLevel: opts.thinkingLevel } } : {}),
        },
      });
      const u = res.usageMetadata;
      const usage: Usage = {
        ...(u?.promptTokenCount !== undefined ? { promptTokens: u.promptTokenCount } : {}),
        ...(u?.candidatesTokenCount !== undefined ? { outputTokens: u.candidatesTokenCount } : {}),
        ...(u?.thoughtsTokenCount !== undefined ? { thoughtsTokens: u.thoughtsTokenCount } : {}),
        ...(u?.totalTokenCount !== undefined ? { totalTokens: u.totalTokenCount } : {}),
      };
      let raw: unknown;
      try {
        raw = JSON.parse(res.text ?? '');
      } catch {
        return { kind: 'INVALID_OUTPUT', issues: ['(root): not JSON'], latencyMs: elapsed(), usage, attempts: attempt };
      }
      const checked = validateStructured(kind, raw, ctx);
      return checked.ok
        ? { kind: 'OK', value: checked.value, latencyMs: elapsed(), usage, attempts: attempt }
        : { kind: 'INVALID_OUTPUT', issues: checked.issues, latencyMs: elapsed(), usage, attempts: attempt };
    } catch (error) {
      if (signal.aborted) return { kind: 'TIMEOUT', latencyMs: elapsed(), attempts: attempt };
      const status = error instanceof ApiError ? error.status : undefined;
      const retryable = status !== undefined && (status === 429 || status >= 500);
      if (retryable && attempt < 2) continue;
      return {
        kind: 'API_ERROR',
        ...(status !== undefined ? { httpStatus: status } : {}),
        errorName: error instanceof Error ? error.name : 'unknown',
        latencyMs: elapsed(),
        attempts: attempt,
      };
    }
  }
}
