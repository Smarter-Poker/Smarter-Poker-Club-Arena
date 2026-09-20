import { useCallback, useEffect, useRef, useState } from 'react';
import { captureCashoutAccountGuard } from '../services/CashoutService';
import { masterBus } from '../core/MasterBus';

function captureAccount(accountId: string | undefined): () => boolean {
  try {
    return accountId ? captureCashoutAccountGuard(accountId) : () => false;
  } catch {
    return () => false;
  }
}

/** A response belongs to the exact account and view generation that dispatched it. */
export function useCashoutScope(accountId: string | undefined, view: string): () => boolean {
  const key = JSON.stringify([accountId ?? null, view]);
  const scope = useRef<{ key: string; accountCurrent: () => boolean } | null>(null);
  const live = useRef(true);
  if (!scope.current || scope.current.key !== key) {
    scope.current = { key, accountCurrent: captureAccount(accountId) };
  } else if (!scope.current.accountCurrent()) {
    // Retire an observed auth epoch even when React batched A -> B -> A.
    // An unavailable identity keeps a stable false token until it is loaded.
    const accountCurrent = captureAccount(accountId);
    if (accountCurrent()) scope.current = { key, accountCurrent };
  }
  const token = scope.current;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return useCallback(
    () => live.current && scope.current === token && token.accountCurrent(),
    [token]
  );
}

/**
 * Key the entire caller's local locks/reads to its actual auth/view generation.
 * An auth event schedules the outer render even when React sees the same final
 * user ID after A -> B -> A. Remounting is local retirement, never cancellation
 * of an in-flight remote operation or permission to replace its durable UUID.
 */
export function useCashoutScopeKey(accountId: string | undefined, view: string): string {
  const [, refresh] = useState(0);
  const isCurrent = useCashoutScope(accountId, view);
  const available = isCurrent();
  const key = useRef({ isCurrent, available, generation: 0 });
  if (key.current.isCurrent !== isCurrent || key.current.available !== available) {
    key.current = { isCurrent, available, generation: key.current.generation + 1 };
  }
  useEffect(() => {
    const unsubscribe = masterBus.subscribe('AUTH_STATE_CHANGED', () =>
      refresh((value) => value + 1)
    );
    // Observe a change between the initial render and installing the listener.
    // Unavailable identity keeps the same false token/key on this extra render.
    refresh((value) => value + 1);
    return unsubscribe;
  }, []);
  return JSON.stringify([accountId ?? null, view, key.current.generation]);
}
