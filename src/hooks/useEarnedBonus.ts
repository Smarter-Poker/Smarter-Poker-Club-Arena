import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthUser } from './useAuthUser';
import {
  WheelBonusEntryService,
  awardBudget,
  type WheelBonusState,
} from '../services/WheelBonusEntryService';
import type { BonusGame } from '../services/DiamondBonusService';
import { defaultBonusBudget, type BonusBudget } from '../utils/bonusGameBudget';
import { reportError } from '../utils/errorReporter';

/** A server read owns entitlement discovery; a URL or saved preference never grants play. */
export function useEarnedBonus(
  club: string | null,
  game: BonusGame,
  preference: BonusBudget,
  mode?: string
) {
  const { user } = useAuthUser();
  const { search } = useLocation();
  const requested = new URLSearchParams(search).get('wheelAward');
  const scope = `${user?.id ?? ''}:${club ?? ''}:${game}:${requested ?? ''}`;
  const quote = `${scope}:${preference.doubled}:${mode ?? ''}`;
  const [snapshot, setSnapshot] = useState<{ quote: string; state: WheelBonusState } | null>(null);
  const [failure, setFailure] = useState<{ quote: string; message: string } | null>(null);
  const [spent, setSpent] = useState<{ scope: string; id: string } | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!club || !user?.id) return;
    try {
      const state = await WheelBonusEntryService.state(
        club,
        game,
        preference.doubled,
        mode,
        requested
      );
      if (current !== generation.current) return;
      setSnapshot({ quote, state });
      setFailure(null);
    } catch (error) {
      reportError(error, 'useEarnedBonus.state');
      if (current === generation.current) {
        setSnapshot(null);
        setFailure({ quote, message: 'Your Wheel Award Could Not Be Checked. Try Refresh.' });
      }
    }
  }, [club, user?.id, game, preference.doubled, mode, requested, quote]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const state = snapshot?.quote === quote ? snapshot.state : null;
  const award =
    state?.award?.status === 'pending' && !(spent?.scope === scope && spent.id === state.award.id)
      ? state.award
      : null;
  const budget = award
    ? awardBudget(award, preference)
    : preference.award
      ? defaultBonusBudget()
      : preference;
  const required = state?.enabled ?? true;
  const ready = !!state && (!required || !!award) && (!requested || !!award);
  const consume = (awardId?: string) => {
    if (awardId) setSpent({ scope, id: awardId });
    void refresh();
  };
  return {
    budget,
    award,
    required,
    ready,
    refresh,
    consume,
    gameState: award ? (state?.gameState ?? null) : null,
    recoveredResult: state?.award?.status === 'redeemed' ? state.award.result : null,
    error: failure?.quote === quote ? failure.message : null,
    loading: !state && failure?.quote !== quote,
  };
}
