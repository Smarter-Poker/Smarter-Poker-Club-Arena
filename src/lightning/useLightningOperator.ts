/**
 * LIGHTNING PHASE 12: THE OPERATOR DASHBOARD'S READ LOOP.
 *
 * One polled read per surface, with the rules every operator surface needs:
 *
 *   - A sane interval (15 s for the overview, 30 s for one Cluster, 5 s for
 *     one Cluster while its drain or conversion is in flight), and NO
 *     reads while the tab is hidden. Coming back to a stale tab reads once.
 *   - One read in flight per surface. A slow answer is never overtaken by a
 *     second request for the same thing.
 *   - A late answer for a scope the page has left (another club, another
 *     Cluster, another window) is dropped, never painted.
 *   - A door the database does not have yet ("not available yet") and a
 *     refusal (NOT_AUTHORIZED) STOP the loop. Asking again every 15 s would
 *     not change either answer; it would only be a retry storm. A manual
 *     Refresh still asks.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperatorAnswer } from './lightningOperatorApi';

export const OVERVIEW_REFRESH_MS = 15_000;
export const CLUSTER_REFRESH_MS = 30_000;
/** One Cluster while a drain or a conversion is in flight (Phase 13). */
export const CLUSTER_ACTIVE_REFRESH_MS = 5_000;

export interface PolledAnswer<T> {
  answer: OperatorAnswer<T> | null;
  loading: boolean;
  refreshedAt: number | null;
  refresh: () => void;
}

/** Whether the loop keeps asking after this answer. */
export function keepsPolling(answer: OperatorAnswer<unknown> | null): boolean {
  if (!answer) return true;
  return answer.status === 'ok' || answer.status === 'error';
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * `scope` names what is being read; when it changes the previous answer is
 * discarded at once (it described something else) and a fresh read starts.
 * A null scope reads nothing.
 */
export function usePolledAnswer<T>(
  scope: string | null,
  load: () => Promise<OperatorAnswer<T>>,
  intervalMs: number
): PolledAnswer<T> {
  const [state, setState] = useState<{
    scope: string | null;
    answer: OperatorAnswer<T> | null;
    loading: boolean;
    refreshedAt: number | null;
  }>({ scope, answer: null, loading: scope !== null, refreshedAt: null });

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  /* Synced in an effect, never while rendering. Declared before the effect
     that reads on a new scope, so that read already sees the new scope. */
  const scopeRef = useRef(scope);
  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  const inFlightRef = useRef<string | null>(null);
  const answerRef = useRef<OperatorAnswer<T> | null>(null);
  const lastReadRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const read = useCallback(async () => {
    const readScope = scopeRef.current;
    if (readScope === null) return;
    if (inFlightRef.current === readScope) return;
    inFlightRef.current = readScope;
    setState((s) => (s.scope === readScope ? { ...s, loading: true } : s));
    try {
      const answer = await loadRef.current();
      if (!mountedRef.current || scopeRef.current !== readScope) return;
      answerRef.current = answer;
      lastReadRef.current = Date.now();
      setState({ scope: readScope, answer, loading: false, refreshedAt: Date.now() });
    } finally {
      if (inFlightRef.current === readScope) inFlightRef.current = null;
    }
  }, []);

  // A new scope: forget the old answer and read now.
  useEffect(() => {
    answerRef.current = null;
    lastReadRef.current = 0;
    inFlightRef.current = null;
    setState({ scope, answer: null, loading: scope !== null, refreshedAt: null });
    if (scope !== null) void read();
  }, [scope, read]);

  // The interval, paused while the tab is hidden and stopped by a final answer.
  useEffect(() => {
    if (scope === null) return undefined;
    const tick = () => {
      if (isHidden()) return;
      if (!keepsPolling(answerRef.current)) return;
      void read();
    };
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (isHidden()) return;
      if (!keepsPolling(answerRef.current)) return;
      if (Date.now() - lastReadRef.current >= intervalMs) void read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [scope, intervalMs, read]);

  const current = state.scope === scope ? state : null;
  return {
    answer: current?.answer ?? null,
    loading: current ? current.loading : scope !== null,
    refreshedAt: current?.refreshedAt ?? null,
    refresh: () => void read(),
  };
}
