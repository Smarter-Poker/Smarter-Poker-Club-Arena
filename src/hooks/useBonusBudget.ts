import { useCallback, useState } from 'react';
import { useAuthUser } from './useAuthUser';
import {
  defaultBonusBudget,
  plinkoBudget,
  validBonusBudget,
  type BonusBudget,
} from '../utils/bonusGameBudget';

/** The Double Your Diamonds answer, remembered per award so a refresh lands on the right step. */
export interface BonusOfferMemory {
  /** True once the player has answered the offer for this award. */
  answered: (awardId: string) => boolean;
  /** Records an explicit answer. Nothing else may call this. */
  answer: (awardId: string) => void;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Preserves the player's selection through Buy More, separately for each
 * account and club, and remembers which award's Double Your Diamonds offer has
 * been answered, so the entry flow (offer, then setup, then play) survives a
 * refresh without ever skipping a step or answering one by itself.
 */
export function useBonusBudget(clubId: string | undefined, game: string) {
  const { user } = useAuthUser();
  const scope = `diamond-spins-budget:${user?.id ?? ''}:${clubId ?? ''}:${game}`;
  const offerScope = `${scope}:offer-answered`;
  const read = useCallback((): BonusBudget => {
    try {
      const v = JSON.parse(sessionStorage.getItem(scope) ?? 'null') as BonusBudget | null;
      if (v && validBonusBudget(v) && typeof v.doubled === 'boolean') {
        // A saved drop value that no longer splits the stake is cleared, never re-derived.
        return plinkoBudget({
          ...v,
          denomination: typeof v.denomination === 'number' ? v.denomination : null,
        });
      }
    } catch {
      /* A missing or corrupt optional preference uses the default. */
    }
    return defaultBonusBudget();
  }, [scope]);
  const readAnswered = useCallback((): string | null => {
    try {
      const v = sessionStorage.getItem(offerScope);
      return v && UUID.test(v) ? v : null;
    } catch {
      return null;
    }
  }, [offerScope]);
  const [snapshot, setSnapshot] = useState(() => ({
    scope,
    value: read(),
    answered: readAnswered(),
  }));
  const current = snapshot.scope === scope ? snapshot : null;
  const value = current?.value ?? read();
  const answeredFor = current ? current.answered : readAnswered();
  const set = useCallback(
    (next: BonusBudget | ((current: BonusBudget) => BonusBudget)) => {
      setSnapshot((state) => {
        const same = state.scope === scope;
        const budget = plinkoBudget(
          typeof next === 'function' ? next(same ? state.value : read()) : next
        );
        try {
          sessionStorage.setItem(scope, JSON.stringify(budget));
        } catch {
          /* Storage failure cannot change a wager. */
        }
        return { scope, value: budget, answered: same ? state.answered : readAnswered() };
      });
    },
    [scope, read, readAnswered]
  );
  const answer = useCallback(
    (awardId: string) => {
      setSnapshot((state) => {
        try {
          sessionStorage.setItem(offerScope, awardId);
        } catch {
          /* A forgotten answer only asks the question again after a refresh. */
        }
        return {
          scope,
          value: state.scope === scope ? state.value : read(),
          answered: awardId,
        };
      });
    },
    [scope, offerScope, read]
  );
  const offer: BonusOfferMemory = {
    answered: (awardId) => answeredFor === awardId,
    answer,
  };
  return [value, set, offer] as const;
}
