import type { Route } from '@playwright/test';

/** Keep every held callback owned until it has completed, including failed proofs. */
export class HeldRouteLifecycle {
  private release!: () => void;
  private notify!: () => void;
  readonly seen = new Promise<void>((resolve) => {
    this.notify = resolve;
  });
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private readonly callbacks: Promise<{ error?: unknown }>[] = [];

  readonly handler = (route: Pick<Route, 'continue'>): Promise<void> => {
    const callback = (async () => {
      this.notify();
      await this.gate;
      await route.continue();
    })();
    // Observe failures immediately, while preserving them for cleanup to report.
    this.callbacks.push(
      callback.then(
        () => ({}),
        (error: unknown) => ({ error })
      )
    );
    return callback;
  };

  async finish(removeHandler: () => Promise<void>): Promise<void> {
    this.release();
    let failure: { error?: unknown } | undefined;
    // A second matched request can arrive while an earlier callback is draining.
    for (let index = 0; index < this.callbacks.length; index++) {
      const result = await this.callbacks[index];
      if ('error' in result && !failure) failure = result;
    }
    await removeHandler();
    if (failure) throw failure.error;
  }
}
