// Side-effect-free parts of the connection checks, shared by the scripts and the tests (IP1-01).
// A verification run groups V2-V7. Each POST of a run is bound once to its target id, body hash and
// PayPal-Request-Id; a resume reuses that binding, anything else is refused before sending.

import { createHash, randomUUID } from 'node:crypto';
import type { BuiltRequest, OperationKind } from '../../src/paypal/requests.ts';

export const EXIT = { PASS: 0, FAIL: 1, NOT_READY: 2, ERROR: 3 } as const;

export class NotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotReady';
  }
}

/** An operation key is already bound to another target or body. Nothing was sent. */
export class OpBindingError extends Error {
  constructor(key: string) {
    super(`operation ${key} is bound to a different target or body in this run; not sent`);
    this.name = 'OpBindingError';
  }
}

/** Short, stable, non-reversible label for an external id, e.g. "order#1a2b3c4d". */
export function anon(label: string, id: string | undefined): string {
  if (!id) return `${label}#(none)`;
  return `${label}#${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
}

export interface ReportLike {
  check(name: string, ok: boolean): boolean;
  note(key: string, value: string | number | boolean): void;
  say(text: string): void;
}

// ---- runs ----------------------------------------------------------------------------

export interface OpRecord {
  op: OperationKind;
  targetId: string | null;
  hash: string;
  requestId: string;
  createdAt: string;
  resultId?: string;
}

export interface RunRecord {
  runId: string;
  createdAt: string;
  /** Set-once values of the run (order ids, custom ids, ...). */
  data: Record<string, string>;
  /** One binding per POST of the run, never overwritten. */
  ops: Record<string, OpRecord>;
}

export interface RunsFile {
  currentRunId?: string;
  runs: Record<string, RunRecord>;
}

export interface RunStore {
  load(): RunsFile;
  save(file: RunsFile): void;
}

export class MemoryRunStore implements RunStore {
  #file: RunsFile = { runs: {} };
  load(): RunsFile {
    return structuredClone(this.#file);
  }
  save(file: RunsFile): void {
    this.#file = structuredClone(file);
  }
}

export class Runs {
  readonly #store: RunStore;
  readonly #newId: () => string;
  readonly #now: () => string;

  constructor(store: RunStore, newId: () => string = randomUUID, now: () => string = () => new Date().toISOString()) {
    this.#store = store;
    this.#newId = newId;
    this.#now = now;
  }

  /** V2/V3 start: joins the current run if it has not done `phase` yet, otherwise opens a new run. */
  startPhase(phase: 'v2' | 'v3'): RunRecord {
    const file = this.#store.load();
    let run = file.currentRunId ? file.runs[file.currentRunId] : undefined;
    if (!run || run.data[`phase.${phase}`] !== undefined) {
      const runId = `run-${this.#now().slice(0, 10).replaceAll('-', '')}-${this.#newId().slice(0, 8)}`;
      run = { runId, createdAt: this.#now(), data: {}, ops: {} };
      file.runs[runId] = run;
      file.currentRunId = runId;
    }
    run.data[`phase.${phase}`] = this.#now();
    this.#store.save(file);
    return run;
  }

  current(): RunRecord {
    const file = this.#store.load();
    const run = file.currentRunId ? file.runs[file.currentRunId] : undefined;
    if (!run) throw new NotReady('no verification run yet; run "v2 start" / "v3 start" first');
    return run;
  }

  /** Sets run values once. Changing a value that is already set is refused. */
  set(runId: string, patch: Record<string, string>): void {
    const file = this.#store.load();
    const run = file.runs[runId]!;
    for (const [k, v] of Object.entries(patch)) {
      if (run.data[k] !== undefined && run.data[k] !== v) throw new Error(`run value ${k} is already set to something else`);
      run.data[k] = v;
    }
    this.#store.save(file);
  }

  /**
   * Binds a POST of this run to its target and body. The first call creates the binding with a new request id;
   * later calls with the same target and body return it unchanged (resume = same id, stored hash).
   */
  bind(runId: string, key: string, built: BuiltRequest, targetId: string | null): OpRecord {
    const file = this.#store.load();
    const run = file.runs[runId]!;
    const existing = run.ops[key];
    if (existing) {
      if (existing.op !== built.op || existing.targetId !== targetId || existing.hash !== built.hash) throw new OpBindingError(key);
      return existing;
    }
    const usedIds = new Set(Object.values(file.runs).flatMap((r) => Object.values(r.ops).map((o) => o.requestId)));
    let requestId = this.#newId();
    while (usedIds.has(requestId)) requestId = this.#newId();
    const record: OpRecord = { op: built.op, targetId, hash: built.hash, requestId, createdAt: this.#now() };
    run.ops[key] = record;
    this.#store.save(file);
    return record;
  }

  recordResult(runId: string, key: string, resultId: string): void {
    const file = this.#store.load();
    const op = file.runs[runId]!.ops[key]!;
    if (op.resultId !== undefined && op.resultId !== resultId) throw new Error(`operation ${key} already has a different result`);
    op.resultId = resultId;
    this.#store.save(file);
  }
}

/** Polls a query until `done` or the attempts run out (for PENDING results). */
export async function poll<T>(query: () => Promise<T>, done: (v: T) => boolean, attempts = 10, intervalMs = 3000): Promise<T> {
  let last = await query();
  for (let i = 1; i < attempts && !done(last); i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await query();
  }
  return last;
}
