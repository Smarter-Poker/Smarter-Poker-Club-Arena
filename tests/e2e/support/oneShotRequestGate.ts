import type { Route } from '@playwright/test';

/** Hold exactly one matching browser request until the optimistic UI is proven. */
export class OneShotRequestGate {
  private armed = false;
  private seenResolve: (() => void) | null = null;
  private releaseResolve: (() => void) | null = null;
  private seen: Promise<void> = Promise.resolve();
  private released: Promise<void> = Promise.resolve();

  arm() {
    if (this.armed) throw new Error('The previous persistence gate is still armed.');
    this.armed = true;
    this.seen = new Promise<void>((resolve) => {
      this.seenResolve = resolve;
    });
    this.released = new Promise<void>((resolve) => {
      this.releaseResolve = resolve;
    });
  }

  async holdIfArmed(route: Pick<Route, 'continue'>): Promise<boolean> {
    if (!this.armed) return false;
    this.armed = false;
    this.seenResolve?.();
    await this.released;
    await route.continue();
    return true;
  }

  async waitForRequest(timeoutMs: number) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.seen,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('The expected customization persistence request never began.')),
            timeoutMs
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  release() {
    this.armed = false;
    this.releaseResolve?.();
    this.seenResolve = null;
    this.releaseResolve = null;
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * Prove immediate paint while the request is held, always release the route,
 * and observe the response rejection from the moment the waiter is created.
 */
export async function runWithOneShotRequestGate<T>(options: {
  gate: OneShotRequestGate;
  persisted: Promise<T>;
  timeoutMs: number;
  action: () => Promise<void>;
  verifyImmediate: () => Promise<void>;
}): Promise<T> {
  const { gate, persisted, timeoutMs, action, verifyImmediate } = options;
  const persistedOutcome: Promise<Settled<T>> = persisted.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );
  gate.arm();
  try {
    await action();
    await gate.waitForRequest(timeoutMs);
    await verifyImmediate();
  } finally {
    gate.release();
  }
  const outcome = await persistedOutcome;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
