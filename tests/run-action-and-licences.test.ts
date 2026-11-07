// Codex final review (7ef911c):
// - FR1-01: an action stays locked until the refresh after it has finished, and is released when the action or the
//   refresh fails.
// - FR1-02: the licences shipped with the screens are exact copies of the project LICENSE and the packages' own
//   licence files (React, React DOM, Scheduler, the four fonts).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runAction, type ActionHooks } from '../src/web/run-action.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function hooks(refresh: () => Promise<void>) {
  const log: string[] = [];
  const h: ActionHooks = { setBusy: (k) => log.push(`busy:${k}`), setError: (e) => log.push(`error:${e === null ? '-' : String(e)}`), refresh };
  return { h, log };
}

describe('runAction (FR1-01)', () => {
  it('ignores a second press after the POST succeeded but before the refresh finished', async () => {
    const lock = { inFlight: false };
    const gate = deferred();
    const { h, log } = hooks(() => gate.promise);
    let sends = 0;
    const post = async () => {
      sends += 1;
    };
    const first = runAction(lock, h, post, 'approve');
    await Promise.resolve();
    await Promise.resolve();
    expect(sends).toBe(1); // the POST went out; the state GET is still pending
    expect(await runAction(lock, h, post, 'approve')).toBe(false); // the stale button cannot send again
    expect(sends).toBe(1);
    gate.resolve();
    expect(await first).toBe(true);
    expect(lock.inFlight).toBe(false);
    expect(log.at(-1)).toBe('busy:null');
    expect(await runAction(lock, h, post, 'approve')).toBe(true); // after the refresh, a new action may run
    expect(sends).toBe(2);
  });

  it('ignores a second press while the POST itself is pending', async () => {
    const lock = { inFlight: false };
    const gate = deferred();
    const { h } = hooks(async () => {});
    let sends = 0;
    const first = runAction(lock, h, () => ((sends += 1), gate.promise), 'pay');
    expect(await runAction(lock, h, async () => (sends += 1), 'pay')).toBe(false);
    gate.resolve();
    await first;
    expect(sends).toBe(1);
  });

  it('shows the error and still refreshes and unlocks when the action fails', async () => {
    const lock = { inFlight: false };
    let refreshed = 0;
    const { h, log } = hooks(async () => {
      refreshed += 1;
    });
    await runAction(lock, h, async () => Promise.reject(new Error('ALREADY_DECIDED')), 'approve');
    expect(log).toContain('error:Error: ALREADY_DECIDED');
    expect(refreshed).toBe(1);
    expect(lock.inFlight).toBe(false);
  });

  it('unlocks when the refresh fails', async () => {
    const lock = { inFlight: false };
    const { h, log } = hooks(async () => Promise.reject(new Error('network')));
    expect(await runAction(lock, h, async () => {}, 'approve')).toBe(true);
    expect(lock.inFlight).toBe(false);
    expect(log.at(-1)).toBe('busy:null');
  });
});

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const SHIPPED = 'src/web/public/assets/licenses';

describe('licences shipped with the screens (FR1-02)', () => {
  it('the project licence is Apache-2.0, the same file at the root and in the build', () => {
    expect(readFileSync('LICENSE', 'utf8')).toContain('Apache License\n                           Version 2.0, January 2004');
    expect(sha(`${SHIPPED}/FlexSlot-LICENSE.txt`)).toBe(sha('LICENSE'));
    expect(JSON.parse(readFileSync('package.json', 'utf8')).license).toBe('Apache-2.0');
  });

  it.each([
    ['react', 'react-LICENSE.txt'],
    ['react-dom', 'react-dom-LICENSE.txt'],
    ['scheduler', 'scheduler-LICENSE.txt'],
    ['@fontsource/shippori-mincho', 'fontsource-shippori-mincho-LICENSE.txt'],
    ['@fontsource/zen-kaku-gothic-new', 'fontsource-zen-kaku-gothic-new-LICENSE.txt'],
    ['@fontsource/inter', 'fontsource-inter-LICENSE.txt'],
    ['@fontsource/cormorant-garamond', 'fontsource-cormorant-garamond-LICENSE.txt'],
  ])('%s: the shipped copy equals the package licence', (pkg, file) => {
    expect(sha(`${SHIPPED}/${file}`)).toBe(sha(`node_modules/${pkg}/LICENSE`));
    expect(readFileSync(`${SHIPPED}/README.txt`, 'utf8')).toContain(file);
  });
});
