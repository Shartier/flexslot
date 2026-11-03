// All server-side time goes through a Clock (DESIGN 2). Values are UTC epoch milliseconds.

export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/** Test clock: fixed until moved explicitly with set() or advance(). */
export class ManualClock implements Clock {
  #nowMs: number;

  constructor(startMs: number) {
    this.#nowMs = assertEpochMs(startMs);
  }

  now(): number {
    return this.#nowMs;
  }

  set(ms: number): void {
    this.#nowMs = assertEpochMs(ms);
  }

  advance(deltaMs: number): void {
    if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
      throw new RangeError(`advance() needs a non-negative integer, got ${deltaMs}`);
    }
    this.#nowMs = assertEpochMs(this.#nowMs + deltaMs);
  }
}

function assertEpochMs(ms: number): number {
  if (!Number.isSafeInteger(ms)) {
    throw new RangeError(`epoch milliseconds must be a safe integer, got ${ms}`);
  }
  return ms;
}
