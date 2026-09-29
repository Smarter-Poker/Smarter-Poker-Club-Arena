import { useCallback, useEffect, useRef } from 'react';

export type VisibleReadReason = 'initial' | 'interval' | 'visible' | 'refresh';

/**
 * A visible, mounted view reads its authoritative data. This never writes or
 * repairs database state. Like useStatsPulse, cost follows open views instead
 * of every horse hand on unpublished high-write tables. Reads never overlap;
 * leaving a scope aborts its request and discards even an uncancellable reply.
 */
export function useVisibleRead<T>({
  scopeKey,
  enabled,
  read,
  onData,
  onError,
  onReset,
  deferInitial,
  intervalMs = 8_000,
}: {
  scopeKey: string;
  enabled: boolean;
  read: (signal: AbortSignal) => Promise<T>;
  onData: (data: T, reason: VisibleReadReason) => void;
  onError: (error: unknown) => void;
  onReset?: () => void;
  /** A freshly painted device cache may wait for the first normal read. */
  deferInitial?: () => boolean;
  intervalMs?: number;
}): () => void {
  const callbacks = useRef({ read, onData, onError, onReset, deferInitial });
  useEffect(() => {
    callbacks.current = { read, onData, onError, onReset, deferInitial };
  });
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    callbacks.current.onReset?.();
    if (!enabled) return;
    let disposed = false;
    let inFlight = false;
    let refreshPending = false;
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const visible = () => document.visibilityState === 'visible' && navigator.onLine !== false;
    const stopTimer = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const fail = (error: unknown) => {
      if (!failed) callbacks.current.onError(error);
      failed = true;
    };
    const run = async (reason: VisibleReadReason) => {
      stopTimer();
      if (disposed || !visible()) return;
      if (inFlight) {
        // A completed money command may request a fresher read than the one
        // already travelling. Keep ONE successor, not overlapping requests.
        if (reason !== 'interval') refreshPending = true;
        return;
      }
      inFlight = true;
      controller = new AbortController();
      const request = controller;
      const deadline = setTimeout(() => request.abort(), 15_000);
      try {
        const data = await callbacks.current.read(request.signal);
        if (!disposed && !request.signal.aborted) {
          callbacks.current.onData(data, reason);
          failed = false;
        } else if (!disposed) fail(new Error('The requested data could not be refreshed'));
      } catch (error) {
        if (!disposed) fail(error);
      } finally {
        clearTimeout(deadline);
        inFlight = false;
        if (!disposed && visible()) {
          if (refreshPending) {
            refreshPending = false;
            void run('refresh');
          } else {
            timer = setTimeout(() => void run('interval'), intervalMs);
          }
        }
      }
    };
    const onVisibility = () => {
      if (visible()) void run('visible');
      else stopTimer();
    };
    refreshRef.current = () => void run('refresh');
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onVisibility);
    window.addEventListener('offline', onVisibility);
    if (callbacks.current.deferInitial?.()) {
      if (visible()) timer = setTimeout(() => void run('initial'), intervalMs);
    } else void run('initial');
    return () => {
      disposed = true;
      refreshRef.current = null;
      stopTimer();
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onVisibility);
      window.removeEventListener('offline', onVisibility);
    };
  }, [scopeKey, enabled, intervalMs]);

  return useCallback(() => refreshRef.current?.(), []);
}
