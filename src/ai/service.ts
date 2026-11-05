// AI calls with their limits and records (DESIGN 9, 14.4).
// - The world's AI mode decides the structurer (fixed at world creation, DESIGN 10). A Vertex failure, timeout,
//   invalid output or quota is reported as such; the caller switches the person to the manual form. There is no
//   silent fallback to the mock.
// - Limits (Vertex only): 20 s per attempt, one retry on 5xx/429 (vertex.ts), 30 attempts per world, 500 attempts
//   per UTC day for the whole server. They are counted in ai_calls inside BEGIN IMMEDIATE before every attempt, so
//   they survive restarts and concurrent requests cannot both take the last one.
// - Every call is recorded (mode, model, outcome, attempts, latency, the validated result or the issues). The
//   customer's text is not stored here; it stays with the draft and the confirmed version.

import { randomUUID } from 'node:crypto';
import { immediate, type Db } from '../db/database.ts';
import type { Clock } from '../clock.ts';
import type { AiMode, AiStructurer } from './port.ts';
import type { StructureContext, StructureKind, Structured } from './structure.ts';
import type { QuotaScope } from './vertex.ts';

export interface AiLimits {
  perWorld: number;
  perDay: number;
}

export const DEFAULT_AI_LIMITS: AiLimits = { perWorld: 30, perDay: 500 };

export type AiFailure = 'NOT_CONFIGURED' | 'TIMEOUT' | 'API_ERROR' | 'INVALID_OUTPUT' | 'QUOTA_WORLD' | 'QUOTA_DAY';

export type AiResult<K extends StructureKind> =
  | { ok: true; source: 'AI_VERTEX' | 'AI_MOCK'; callId: string; model: string; value: Structured<K> }
  | { ok: false; callId: string | null; reason: AiFailure; issues: string[] };

export interface AiUsage {
  worldAttempts: number;
  dayAttempts: number;
  limits: AiLimits;
}

export class AiService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #vertex: AiStructurer | null;
  readonly #mock: AiStructurer;
  readonly #limits: AiLimits;

  constructor(o: { db: Db; clock: Clock; vertex: AiStructurer | null; mock: AiStructurer; limits?: AiLimits }) {
    if (o.vertex && o.vertex.mode !== 'VERTEX') throw new Error('vertex structurer must be in VERTEX mode');
    if (o.mock.mode !== 'MOCK') throw new Error('mock structurer must be in MOCK mode');
    this.#db = o.db;
    this.#clock = o.clock;
    this.#vertex = o.vertex;
    this.#mock = o.mock;
    this.#limits = o.limits ?? DEFAULT_AI_LIMITS;
  }

  get vertexModel(): string | null {
    return this.#vertex?.model ?? null;
  }

  get mockModel(): string {
    return this.#mock.model;
  }

  modelFor(mode: AiMode): string | null {
    return mode === 'VERTEX' ? this.vertexModel : this.mockModel;
  }

  #day(now: number): string {
    return new Date(now).toISOString().slice(0, 10);
  }

  usage(worldId: string): AiUsage {
    const now = this.#clock.now();
    return {
      worldAttempts: this.#sum('world_id = ?', worldId),
      dayAttempts: this.#sum('utc_day = ?', this.#day(now)),
      limits: this.#limits,
    };
  }

  #sum(where: string, value: string): number {
    const r = this.#db.prepare(`SELECT coalesce(sum(attempts), 0) AS n FROM ai_calls WHERE mode = 'VERTEX' AND ${where}`).get(value) as { n: number };
    return r.n;
  }

  async structure<K extends StructureKind>(worldId: string, kind: K, text: string, ctx: StructureContext): Promise<AiResult<K>> {
    const db = this.#db;
    const world = db.prepare('SELECT mode_ai FROM worlds WHERE id = ?').get(worldId) as { mode_ai: AiMode } | undefined;
    if (!world) throw new Error('unknown world');
    const structurer = world.mode_ai === 'VERTEX' ? this.#vertex : this.#mock;
    if (!structurer) return { ok: false, callId: null, reason: 'NOT_CONFIGURED', issues: [] };

    const now = this.#clock.now();
    const callId = randomUUID();
    db.prepare(
      `INSERT INTO ai_calls (id, world_id, kind, mode, model, utc_day, outcome, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, 'IN_FLIGHT', 0, ?)`,
    ).run(callId, worldId, kind, structurer.mode, structurer.model, this.#day(now), now);

    const beforeAttempt = (): QuotaScope | null =>
      immediate(db, () => {
        if (structurer.mode === 'VERTEX') {
          if (this.#sum('world_id = ?', worldId) >= this.#limits.perWorld) return 'WORLD';
          if (this.#sum('utc_day = ?', this.#day(this.#clock.now())) >= this.#limits.perDay) return 'DAY';
        }
        db.prepare('UPDATE ai_calls SET attempts = attempts + 1 WHERE id = ?').run(callId);
        return null;
      });

    const out = await structurer.structure(kind, text, ctx, { beforeAttempt });
    const fields: { outcome: string; latency: number; http: number | null; issues: string[]; result: unknown; usage: unknown } = {
      outcome: out.kind,
      latency: out.latencyMs,
      http: out.kind === 'API_ERROR' ? (out.httpStatus ?? null) : null,
      issues: out.kind === 'INVALID_OUTPUT' ? out.issues : out.kind === 'API_ERROR' ? [out.errorName] : out.kind === 'QUOTA' ? [`QUOTA_${out.scope}`] : [],
      result: out.kind === 'OK' ? out.value : null,
      usage: out.kind === 'OK' || out.kind === 'INVALID_OUTPUT' ? out.usage : {},
    };
    db.prepare(
      'UPDATE ai_calls SET outcome = ?, latency_ms = ?, http_status = ?, issues_json = ?, result_json = ?, usage_json = ? WHERE id = ?',
    ).run(fields.outcome, fields.latency, fields.http, JSON.stringify(fields.issues), fields.result === null ? null : JSON.stringify(fields.result), JSON.stringify(fields.usage), callId);

    if (out.kind === 'OK') {
      return { ok: true, source: structurer.mode === 'VERTEX' ? 'AI_VERTEX' : 'AI_MOCK', callId, model: structurer.model, value: out.value };
    }
    const reason: AiFailure = out.kind === 'QUOTA' ? (out.scope === 'WORLD' ? 'QUOTA_WORLD' : 'QUOTA_DAY') : out.kind;
    return { ok: false, callId, reason, issues: fields.issues };
  }
}
