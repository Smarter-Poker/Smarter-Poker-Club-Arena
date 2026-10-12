/**
 * LIGHTNING PHASE 12/13: THE OPERATOR DASHBOARD'S EVENT-OWNED READS.
 *
 * One read in flight, scoped to the current view generation. Named engine
 * events wake reads; hidden tabs retain a dirty marker and read on visibility.
 * Initial open, explicit Refresh and reconnect reconcile missed events.
 * Refusals stop automatic reads. No periodic poll supplies correctness.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperatorAnswer } from './lightningOperatorApi';
import { watchLightningOperator } from './lightningOperatorEvents';

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
  _intervalMs: number,
  clubId: string | null = scope?.startsWith('overview:') ? scope.split(':')[1] : null
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
  const inFlightRef = useRef<{ scope: string; generation: number } | null>(null);
  const generationRef = useRef(0);
  const pendingReadRef = useRef(false);
  const answerRef = useRef<OperatorAnswer<T> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const read = useCallback(async (): Promise<void> => {
    const readScope = scopeRef.current;
    if (readScope === null || !mountedRef.current) return;
    const generation = generationRef.current;
    if (inFlightRef.current?.generation === generation) {
      pendingReadRef.current = true;
      return;
    }
    const owner = { scope: readScope, generation };
    inFlightRef.current = owner;
    setState((s) => (s.scope === readScope ? { ...s, loading: true } : s));
    try {
      const answer = await loadRef.current();
      if (
        !mountedRef.current ||
        scopeRef.current !== readScope ||
        generationRef.current !== generation
      )
        return;
      answerRef.current = answer;
      setState({ scope: readScope, answer, loading: false, refreshedAt: Date.now() });
    } finally {
      if (inFlightRef.current === owner) {
        inFlightRef.current = null;
        if (mountedRef.current && pendingReadRef.current && generationRef.current === generation) {
          pendingReadRef.current = false;
          void read();
        }
      }
    }
  }, []);

  // A new scope: forget the old answer and read now.
  useEffect(() => {
    generationRef.current += 1;
    pendingReadRef.current = false;
    answerRef.current = null;
    inFlightRef.current = null;
    setState({ scope, answer: null, loading: scope !== null, refreshedAt: null });
    if (scope !== null) void read();
  }, [scope, read]);

  // Discrete transaction events and connection recovery replace polling.
  useEffect(() => {
    if (scope === null) return undefined;
    let dirty = false;
    const onChange = () => {
      dirty = true;
      if (isHidden() || !keepsPolling(answerRef.current)) return;
      dirty = false;
      void read();
    };
    const clusterId = scope.startsWith('cluster:') ? scope.split(':')[1] : null;
    const stop = watchLightningOperator(clubId, clusterId, onChange);
    const onVisible = () => {
      if (!isHidden() && dirty) onChange();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [scope, clubId, read]);

  const current = state.scope === scope ? state : null;
  return {
    answer: current?.answer ?? null,
    loading: current ? current.loading : scope !== null,
    refreshedAt: current?.refreshedAt ?? null,
    refresh: () => void read(),
  };
}
