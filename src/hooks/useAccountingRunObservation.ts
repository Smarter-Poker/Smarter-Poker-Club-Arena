import { useCallback, useEffect, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { useCashoutScope } from './useCashoutScope';
import { readAccountingRunObservation, type AccountingObservationInput, type AccountingRunObservation } from '../services/AccountingObservationService';

export function useAccountingRunObservation(input: Omit<AccountingObservationInput, 'isCurrent'> | null) {
  const key = JSON.stringify(input);
  const isCurrent = useCashoutScope(input?.actorId, key);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{ token: () => boolean; revision: number; loading: boolean; observation: AccountingRunObservation | null }>({
    token: isCurrent, revision: -1, loading: true, observation: null,
  });
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => masterBus.subscribe('AUTH_STATE_CHANGED', refresh), [refresh]);
  useEffect(() => {
    let active = true;
    const finish = (observation: AccountingRunObservation | null) => {
      if (active && isCurrent()) setState({ token: isCurrent, revision, loading: false, observation });
    };
    if (!input || !isCurrent()) {
      setState({ token: isCurrent, revision, loading: false, observation: null });
      return () => { active = false; };
    }
    setState({ token: isCurrent, revision, loading: true, observation: null });
    void readAccountingRunObservation({ ...input, isCurrent: () => active && isCurrent() })
      .then(finish).catch(() => finish(null));
    return () => { active = false; };
    // key includes every immutable request field; never depend on a fresh caller object.
  }, [key, isCurrent, revision]);
  const current = state.token === isCurrent && state.revision === revision && isCurrent();
  return { observation: current ? state.observation : null,
    loading: !!input && isCurrent() && (!current || state.loading), refresh };
}
