import { useCallback, useEffect, useRef, useState } from 'react';
import {
  prepareCashoutOperation,
  assertCashoutStartCurrent,
  type CashoutStart,
  type CashoutOperationIntent,
  type CashoutKind,
  type PreparedCashoutOperation,
} from '../services/CashoutOperation';

export interface CashoutPreparationInput {
  key: string;
  intent: Omit<CashoutOperationIntent, 'isCurrent'>;
}
const unavailable = () => false;

/** Stale UI results are suppressed; this does not cancel a remote operation. */
export function isCashoutStartCurrent(start: CashoutStart | null): boolean {
  if (!start) return false;
  try {
    assertCashoutStartCurrent(start);
    return true;
  } catch {
    return false;
  }
}

/** Prepare exact form/row intents while idle; this hook never starts a cashout. */
export function usePreparedCashoutOperations(
  inputs: readonly CashoutPreparationInput[],
  isCurrent: (() => boolean) | null,
  sourceRevision: unknown
) {
  const current = isCurrent ?? unavailable;
  const signature = JSON.stringify(
    inputs.map(({ key, intent }) => [
      key,
      intent.userId,
      intent.clubId,
      intent.targetId,
      intent.playerId,
      intent.kind,
      intent.amount,
      intent.note ?? '',
    ])
  );
  const tokenRef = useRef<{ signature: string; current: () => boolean; revision: unknown } | null>(
    null
  );
  const [, refresh] = useState(0);
  if (
    !tokenRef.current ||
    tokenRef.current.signature !== signature ||
    tokenRef.current.current !== current ||
    tokenRef.current.revision !== sourceRevision
  ) {
    tokenRef.current = { signature, current, revision: sourceRevision };
  }
  const token = tokenRef.current;
  const [resolved, setResolved] = useState<{
    token: typeof token;
    isCurrent: () => boolean;
    prepared: Map<string, PreparedCashoutOperation>;
    errors: Map<string, string>;
  } | null>(null);
  const latestInputs = useRef(inputs);
  latestInputs.current = inputs;
  const invalidate = useCallback(() => {
    // Input handlers call this BEFORE setting state. Even an A -> B -> A edit
    // without a render cannot revive the old accepted/prepared input epoch.
    tokenRef.current = null;
    refresh((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    const ownsToken = () => active && tokenRef.current === token && token.current();
    const snapshot = latestInputs.current.map((entry) => ({
      key: entry.key,
      intent: { ...entry.intent },
    }));
    if (!ownsToken())
      return () => {
        active = false;
      };
    if (new Set(snapshot.map((entry) => entry.key)).size !== snapshot.length) {
      setResolved({
        token,
        isCurrent: ownsToken,
        prepared: new Map(),
        errors: new Map([['', 'The Cashout Actions Could Not Be Verified']]),
      });
      return () => {
        active = false;
      };
    }
    void Promise.all(
      snapshot.map(async (entry) => {
        try {
          const prepared = await prepareCashoutOperation({ ...entry.intent, isCurrent: ownsToken });
          return { key: entry.key, prepared, error: null };
        } catch (error) {
          return {
            key: entry.key,
            prepared: null,
            error:
              error instanceof Error ? error.message : 'The Cashout Request Could Not Be Prepared',
          };
        }
      })
    ).then((results) => {
      if (!ownsToken()) return;
      setResolved({
        token,
        isCurrent: ownsToken,
        prepared: new Map(
          results
            .filter((entry) => entry.prepared !== null)
            .map((entry) => [entry.key, entry.prepared!])
        ),
        errors: new Map(
          results.filter((entry) => entry.error !== null).map((entry) => [entry.key, entry.error!])
        ),
      });
    });
    return () => {
      active = false;
    };
  }, [token]);

  const ready = () =>
    resolved?.token === token && tokenRef.current === token && resolved.isCurrent();
  return {
    get: <K extends CashoutKind>(key: string, kind: K): PreparedCashoutOperation<K> | null => {
      const prepared = ready() ? resolved?.prepared.get(key) : null;
      return prepared?.kind === kind ? (prepared as PreparedCashoutOperation<K>) : null;
    },
    error: ready() ? (resolved?.errors.values().next().value ?? null) : null,
    invalidate,
  };
}
