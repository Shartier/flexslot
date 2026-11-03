// Shared helpers for the connection checks (DESIGN 12). Output is limited to time, mode, check results,
// anonymized external ids and the exit code. Secrets and raw ids are never printed.
// Run state (raw ids, request ids) is kept in work/verify/, which Git ignores, so a step can be resumed or
// resent with the same PayPal-Request-Id after an interruption.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandboxPayPal, loadPayPalConfig, type PayPalConfig } from '../../src/paypal/config.ts';
import type { PayPalLogEntry } from '../../src/paypal/port.ts';
import type { PayPalRestAdapter } from '../../src/paypal/rest.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_DIR = join(ROOT, 'work', 'verify');
const STATE_FILE = join(STATE_DIR, 'state.json');
const RESULTS_FILE = join(STATE_DIR, 'results.jsonl');

/** Return URLs for buyer approval. Nothing listens there; the browser shows a connection error after approval. */
export const RETURN_URL = 'http://localhost:8799/flexslot-verify/return';
export const CANCEL_URL = 'http://localhost:8799/flexslot-verify/cancel';

export const EXIT = { PASS: 0, FAIL: 1, NOT_READY: 2, ERROR: 3 } as const;

export function loadDotEnv(): boolean {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

/** Short, stable, non-reversible label for an external id, e.g. "order#1a2b3c4d". */
export function anon(label: string, id: string | undefined): string {
  if (!id) return `${label}#(none)`;
  return `${label}#${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
}

// ---- state -------------------------------------------------------------------------

export type State = Record<string, Record<string, unknown>>;

export function readState(): State {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
}

export function saveState(section: string, patch: Record<string, unknown>): void {
  const state = readState();
  state[section] = { ...(state[section] ?? {}), ...patch };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

// ---- report ------------------------------------------------------------------------

export class NotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotReady';
  }
}

export class Report {
  readonly #id: string;
  readonly #mode: string;
  readonly #checks: Array<{ name: string; ok: boolean }> = [];
  readonly #notes: Record<string, string | number | boolean> = {};

  constructor(id: string, mode: string) {
    this.#id = id;
    this.#mode = mode;
    console.log(`[${new Date().toISOString()}] ${id} mode=${mode} start`);
  }

  check(name: string, ok: boolean): boolean {
    this.#checks.push({ name, ok });
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
    return ok;
  }

  /** Records a value that is not pass/fail (observed shape, anonymized id, latency). Never pass secrets or raw ids. */
  note(key: string, value: string | number | boolean): void {
    this.#notes[key] = value;
    console.log(`  ${key}: ${value}`);
  }

  say(text: string): void {
    console.log(`  ${text}`);
  }

  finish(forced?: number): number {
    const exit = forced ?? (this.#checks.every((c) => c.ok) ? EXIT.PASS : EXIT.FAIL);
    const at = new Date().toISOString();
    console.log(`[${at}] ${this.#id} mode=${this.#mode} exit=${exit}`);
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(RESULTS_FILE, `${JSON.stringify({ id: this.#id, mode: this.#mode, at, exit, checks: this.#checks, notes: this.#notes })}\n`);
    return exit;
  }
}

/** Runs one check script and sets the process exit code. Errors print their class and message only. */
export async function run(id: string, mode: string, body: (r: Report) => Promise<void>): Promise<void> {
  const report = new Report(id, mode);
  try {
    await body(report);
    process.exitCode = report.finish();
  } catch (error) {
    if (error instanceof NotReady) {
      report.say(`not ready: ${error.message}`);
      process.exitCode = report.finish(EXIT.NOT_READY);
      return;
    }
    const e = error instanceof Error ? error : new Error(String(error));
    report.say(`error: ${e.name}: ${e.message.slice(0, 200)}`);
    process.exitCode = report.finish(EXIT.ERROR);
  }
}

// ---- PayPal --------------------------------------------------------------------------

function logLine(e: PayPalLogEntry): void {
  console.log(`  · ${e.event} ${e.route} ${e.httpStatus ?? '-'} ${e.outcome} ${e.durationMs}ms`);
}

export function sandboxFromEnv(): { paypal: PayPalRestAdapter; config: PayPalConfig } {
  loadDotEnv(); // optional: variables may also come from the shell; missing ones are named by loadPayPalConfig
  const config = loadPayPalConfig(process.env);
  return { paypal: createSandboxPayPal(config, { logger: logLine }), config };
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
