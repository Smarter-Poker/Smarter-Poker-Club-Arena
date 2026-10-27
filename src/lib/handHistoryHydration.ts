import type { HandHistoryLoadState } from './handHistoryLive';

interface HandHistoryHydration<T> {
  load: () => Promise<T>;
  commit: (result: T) => void;
  setState: (state: HandHistoryLoadState) => void;
  onReady?: () => void;
  onError: (error: unknown) => void;
}

/** One open's read owns its state and cannot commit after its effect closes. */
export function startHandHistoryHydration<T>(options: HandHistoryHydration<T>): () => void {
  let cancelled = false;
  let pending = true;
  options.setState('loading');
  void (async () => {
    try {
      const result = await options.load();
      if (cancelled) return;
      options.commit(result);
      pending = false;
      options.setState('ready');
      options.onReady?.();
    } catch (error) {
      if (cancelled) return;
      pending = false;
      options.setState('failed');
      options.onError(error);
    }
  })();
  return () => {
    if (cancelled) return;
    cancelled = true;
    // A cancelled read can no longer settle the UI. Release its loading state
    // now, so the next open (or another table) can start its own read.
    if (pending) options.setState('idle');
  };
}
