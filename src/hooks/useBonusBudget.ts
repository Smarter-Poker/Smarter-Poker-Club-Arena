import { useCallback, useState } from 'react';
import { useAuthUser } from './useAuthUser';
import {
  defaultBonusBudget,
  plinkoBudget,
  validBonusBudget,
  type BonusBudget,
} from '../utils/bonusGameBudget';

/** Preserves the player's selection through Buy More, separately for each account and club. */
export function useBonusBudget(clubId: string | undefined, game: string) {
  const { user } = useAuthUser();
  const scope = `diamond-spins-budget:${user?.id ?? ''}:${clubId ?? ''}:${game}`;
  const read = useCallback((): BonusBudget => {
    try {
      const v = JSON.parse(sessionStorage.getItem(scope) ?? 'null') as BonusBudget | null;
      // A saved drop value from before ten drops became the one setting is re-derived.
      if (v && validBonusBudget(v) && typeof v.doubled === 'boolean') return plinkoBudget(v);
    } catch {
      /* A missing or corrupt optional preference uses the default. */
    }
    return defaultBonusBudget();
  }, [scope]);
  const [snapshot, setSnapshot] = useState(() => ({ scope, value: read() }));
  const value = snapshot.scope === scope ? snapshot.value : read();
  const set = useCallback(
    (next: BonusBudget | ((current: BonusBudget) => BonusBudget)) => {
      setSnapshot((current) => {
        const budget = plinkoBudget(
          typeof next === 'function'
            ? next(current.scope === scope ? current.value : read())
            : next
        );
        try {
          sessionStorage.setItem(scope, JSON.stringify(budget));
        } catch {
          /* Storage failure cannot change a wager. */
        }
        return { scope, value: budget };
      });
    },
    [scope, read]
  );
  return [value, set] as const;
}
