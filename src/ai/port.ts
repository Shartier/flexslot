// The AI port (DESIGN 9, 14.4). Two implementations: Gemini on Vertex AI (vertexStructurer) and the fixed-rule
// mock (mock.ts) for tests and offline use. A world's AI mode is fixed at creation (DESIGN 10); a failed Vertex
// call never falls back to the mock (service.ts).

import type { StructureContext, StructureKind } from './structure.ts';
import { DEFAULT_AI_TIMEOUT_MS, structureText, type GenerateContentLike, type StructureOptions, type StructureOutcome } from './vertex.ts';

export type AiMode = 'VERTEX' | 'MOCK';

export interface AiStructurer {
  readonly mode: AiMode;
  /** Model id shown on the screens and stored with every call ("mock-rules-v1" for the mock). */
  readonly model: string;
  structure<K extends StructureKind>(kind: K, text: string, ctx: StructureContext, opts?: StructureOptions): Promise<StructureOutcome<K>>;
}

/** Gemini on Vertex AI through @google/genai (ADC on the server; nothing reaches the browser). */
export function vertexStructurer(models: GenerateContentLike, model: string, timeoutMs = DEFAULT_AI_TIMEOUT_MS): AiStructurer {
  return {
    mode: 'VERTEX',
    model,
    structure: (kind, text, ctx, opts = {}) => structureText(models, model, kind, text, ctx, { timeoutMs, ...opts }),
  };
}
