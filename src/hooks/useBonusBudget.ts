import { useCallback, useState } from 'react';
import { useAuthUser } from './useAuthUser';
import {
  defaultBonusBudget,
  plinkoBudget,
  validBonusBudget,
  type BonusBudget,
} from '../utils/bonusGameBudget';

/**
 * A new entry never carries the retired Double Diamonds add-on (Dan
 * 2026-10-16). A selection saved by an older page that took it is read back
 * without it, so nothing remembered can ask the server for the add-on again.
 */
const withoutAddOn = (budget: BonusBudget): BonusBudget =>
  budget.doubled ? { ...budget, doubled: false } : budget;

/**
 * Preserves the player's selection through Buy More, separately for each
 * account and club, so the entry survives a refresh without ever answering a
 * choice by itself.
 */
export function useBonusBudget(clubId: string | undefined, game: string) {
  const { user } = useAuthUser();
  const scope = `diamond-spins-budget:${user?.id ?? ''}:${clubId ?? ''}:${game}`;
  const read = useCallback((): BonusBudget => {
    try {
      const v = JSON.parse(sessionStorage.getItem(scope) ?? 'null') as BonusBudget | null;
      if (v && validBonusBudget(v) && typeof v.doubled === 'boolean') {
        // A saved drop value that no longer splits the stake is cleared, never re-derived.
        return plinkoBudget(
          withoutAddOn({
            ...v,
            denomination: typeof v.denomination === 'number' ? v.denomination : null,
          })
        );
      }
    } catch {
      /* A missing or corrupt optional preference uses the default. */
    }
    return defaultBonusBudget();
  }, [scope]);
  const [snapshot, setSnapshot] = useState(() => ({ scope, value: read() }));
  const value = snapshot.scope === scope ? snapshot.value : read();
  const set = useCallback(
    (next: BonusBudget | ((current: BonusBudget) => BonusBudget)) => {
      setSnapshot((state) => {
        const same = state.scope === scope;
        const budget = plinkoBudget(
          withoutAddOn(typeof next === 'function' ? next(same ? state.value : read()) : next)
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
