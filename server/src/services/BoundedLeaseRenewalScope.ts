/** One retained transport per scope. Retirement revokes result authority without
 * pretending an uncancellable transport was cancelled. No waiter accumulation. */
export class BoundedLeaseRenewalScope<T> {
  private retained: object | null = null;

  run(
    timeoutMs: number,
    ownerIsCurrent: () => boolean,
    operation: (isCurrent: () => boolean) => Promise<T>,
    onAbandon: () => void
  ): Promise<T | null> {
    if (this.retained || !ownerIsCurrent()) return Promise.resolve(null);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new Error('invalid lease renewal deadline'));
    }
    const token = {};
    this.retained = token;
    const deadline = performance.now() + timeoutMs;
    let active = true;
    const isCurrent = () =>
      active && this.retained === token && performance.now() < deadline && ownerIsCurrent();
    return new Promise<T | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        active = false;
        resolve(null); // Always release the caller, even if reporting throws.
        try {
          onAbandon();
        } catch {
          /* Reporting cannot hold the lifecycle. */
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const cleanup = () => {
        active = false;
        clearTimeout(timer);
        if (this.retained === token) this.retained = null;
      };
      // Publish retained token before invoking code that can synchronously reenter.
      let pending: Promise<T>;
      try {
        pending = operation(isCurrent);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      Promise.resolve(pending).then(
        (value) => {
          const current = isCurrent();
          cleanup();
          resolve(current ? value : null);
        },
        (error) => {
          const current = isCurrent();
          cleanup();
          if (current) reject(error);
          else resolve(null);
        }
      );
    });
  }
}
