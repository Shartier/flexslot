// Script-side helpers for the connection checks (DESIGN 12): .env, the Sandbox adapter, the file-backed run store,
// and the console report. Output is limited to time, mode, check results, anonymized ids and the exit code.
// Run state (raw ids, request ids, body hashes) lives in work/verify/runs.json, which Git ignores.
// work/verify/state.json from the first runs (before IP1-01) is kept as it was and no longer read.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandboxPayPal, loadPayPalConfig, type PayPalConfig } from '../../src/paypal/config.ts';
import type { PayPalLogEntry } from '../../src/paypal/port.ts';
import type { PayPalRestAdapter } from '../../src/paypal/rest.ts';
import { EXIT, NotReady, Runs, type ReportLike, type RunsFile, type RunStore } from './core.ts';
import type { StepContext } from './steps.ts';

export { anon, EXIT, NotReady } from './core.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_DIR = join(ROOT, 'work', 'verify');
const RUNS_FILE = join(STATE_DIR, 'runs.json');
const RESULTS_FILE = join(STATE_DIR, 'results.jsonl');

/** Return URLs for buyer approval. Nothing listens there; the browser shows a connection error after approval. */
export const RETURN_URL = 'http://localhost:8799/flexslot-verify/return';
export const CANCEL_URL = 'http://localhost:8799/flexslot-verify/cancel';

export function loadDotEnv(): boolean {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}

class FileRunStore implements RunStore {
  load(): RunsFile {
    return existsSync(RUNS_FILE) ? (JSON.parse(readFileSync(RUNS_FILE, 'utf8')) as RunsFile) : { runs: {} };
  }
  save(file: RunsFile): void {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(RUNS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  }
}

export class Report implements ReportLike {
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

  /** Records a value that is not pass/fail. Never pass secrets or raw ids. */
  note(key: string, value: string | number | boolean): void {
    this.#notes[key] = value;
    console.log(`  ${key}: ${value}`);
  }

  say(text: string): void {
    console.log(`  ${text}`);
  }

  finish(forced?: number): number {
    const exit = forced ?? (this.#checks.length > 0 && this.#checks.every((c) => c.ok) ? EXIT.PASS : EXIT.FAIL);
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

function logLine(e: PayPalLogEntry): void {
  console.log(`  · ${e.event} ${e.route} ${e.httpStatus ?? '-'} ${e.outcome} ${e.durationMs}ms`);
}

export function sandboxFromEnv(): { paypal: PayPalRestAdapter; config: PayPalConfig } {
  loadDotEnv(); // optional: variables may also come from the shell; missing ones are named by loadPayPalConfig
  const config = loadPayPalConfig(process.env);
  return { paypal: createSandboxPayPal(config, { logger: logLine }), config };
}

/** Step context for V2-V7 against the Sandbox, with the file-backed run store. */
export function sandboxStepContext(r: Report): StepContext {
  const { paypal, config } = sandboxFromEnv();
  return {
    paypal,
    expectedMerchantId: config.expectedMerchantId,
    runs: new Runs(new FileRunStore()),
    r,
    returnUrl: RETURN_URL,
    cancelUrl: CANCEL_URL,
  };
}
