// One action at a time (Codex FR1-01): a button's action stays locked until the screen has been refreshed with the
// server's new state, so a second press on the stale screen cannot send the same request again. The lock is released
// even when the action or the refresh fails. Kept free of React so it can be tested directly.

export interface ActionHooks {
  setBusy: (key: string | null) => void;
  setError: (e: unknown) => void;
  refresh: () => Promise<void>;
}

export interface ActionLock {
  inFlight: boolean;
}

/** Runs `fn` unless another action is in flight; returns false when it was ignored. */
export async function runAction(lock: ActionLock, hooks: ActionHooks, fn: () => Promise<unknown>, key: string): Promise<boolean> {
  if (lock.inFlight) return false;
  lock.inFlight = true;
  hooks.setBusy(key);
  hooks.setError(null);
  try {
    try {
      await fn();
    } catch (e) {
      hooks.setError(e);
    }
    await hooks.refresh();
  } catch {
    // A failed refresh shows its own message on the screen; the lock must still be released.
  } finally {
    lock.inFlight = false;
    hooks.setBusy(null);
  }
  return true;
}
