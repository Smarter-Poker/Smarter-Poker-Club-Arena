import type { Page } from '@playwright/test';

/** Serialized into each observer before the application starts. No auth data is read. */
export function installNaturalAuthAdmissionDiagnosticScript(): void {
  const target = window as any;
  if (target.__naturalAuthAdmissionDiagnostic) return;
  const locks = navigator.locks;
  const events: Array<{ at: number; id: number; name: string; event: string }> = [];
  let sequence = 0;
  let stopped = false;
  const name = 'lock:smarter-poker-auth';
  const original = locks?.request;
  const originalDescriptor = locks && Object.getOwnPropertyDescriptor(locks, 'request');
  const record = (id: number, event: string) => {
    if (!stopped) events.push({ at: Date.now(), id, name, event });
  };
  const wrapped = function (this: LockManager, ...args: any[]): any {
    // Other lock names and invalid overloads reach the original untouched.
    const callbackIndex = args.length === 2 ? 1 : 2;
    const callback = args[callbackIndex];
    if (args[0] !== name || typeof callback !== 'function')
      return Reflect.apply(original!, this, args);
    const id = ++sequence;
    let acquired = false;
    record(id, 'requested');
    const forwarded = [...args];
    forwarded[callbackIndex] = function (this: unknown, ...callbackArgs: any[]) {
      acquired = Boolean(callbackArgs[0]);
      if (acquired) record(id, 'acquired');
      return Reflect.apply(callback, this, callbackArgs);
    };
    try {
      const result = Reflect.apply(original!, this, forwarded);
      // Observe the native request promise, returning that very same promise.
      // In particular, do not await/wrap the callback result or inspect options.
      void result.then(
        () => {
          if (acquired) record(id, 'released');
        },
        () => {
          if (acquired) record(id, 'released');
          record(id, 'rejected');
        }
      );
      return result;
    } catch (error) {
      if (acquired) record(id, 'released');
      record(id, 'rejected');
      throw error;
    }
  };
  let installed = false;
  if (locks && typeof original === 'function') {
    try {
      locks.request = wrapped;
      installed = locks.request === wrapped;
    } catch {
      /* An unavailable diagnostic must not change application admission. */
    }
  }
  target.__naturalAuthAdmissionDiagnostic = {
    read: async () => {
      let state: { held: unknown[]; pending: unknown[] } | null = null;
      let queryFailed = false;
      if (locks?.query) {
        try {
          const snapshot = await locks.query();
          const sanitize = (items: LockInfo[] | undefined) =>
            (items ?? [])
              .filter((item) => item.name === name)
              .map((item) => ({ name, mode: item.mode }));
          state = { held: sanitize(snapshot.held), pending: sanitize(snapshot.pending) };
        } catch {
          queryFailed = true;
        }
      }
      return {
        installed,
        stopped,
        events: events.map((event) => ({ ...event })),
        state,
        queryFailed,
      };
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (installed && locks.request === wrapped) {
        if (originalDescriptor) Object.defineProperty(locks, 'request', originalDescriptor);
        else delete (locks as any).request;
      }
    },
  };
}

export async function installNaturalAuthAdmissionDiagnostic(page: Page): Promise<void> {
  await page.addInitScript(installNaturalAuthAdmissionDiagnosticScript);
}

export async function readNaturalAuthAdmissionDiagnostic(page: Page) {
  return page.evaluate(
    async () => (window as any).__naturalAuthAdmissionDiagnostic?.read() ?? null
  );
}

export async function stopNaturalAuthAdmissionDiagnostic(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__naturalAuthAdmissionDiagnostic?.stop());
}
