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
import { useAutoSettle } from './useAutoSettle';

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
  const [snapshot, setSnapshot] = useState<{ quote: string; state: WheelBonusState } | null>(null);
  // The Double Your Diamonds answer is the player's own for ONE award. A saved
  // answer for an earlier award is not carried into the quote for a new one
  // (Dan 2026-09-21, R9): until the award is known, or when it differs, the
  // entry is quoted without the addition.
  const targetAward = snapshot?.state.award?.id ?? requested;
  const doubled =
    preference.award && preference.award.id !== targetAward ? false : preference.doubled;
  const quote = `${scope}:${doubled}:${mode ?? ''}`;
  const [failure, setFailure] = useState<{ quote: string; message: string } | null>(null);
  const [spent, setSpent] = useState<{ scope: string; id: string } | null>(null);
  // Failed reads in a row. A read that fails is tried again on its own
  // schedule (useAutoSettle); the player is never asked to press Refresh.
  const [failures, setFailures] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!club || !user?.id) return;
    try {
      const state = await WheelBonusEntryService.state(club, game, doubled, mode, requested);
      if (current !== generation.current) return;
      setSnapshot({ quote, state });
      setFailure(null);
      setFailures(0);
    } catch (error) {
      reportError(error, 'useEarnedBonus.state');
      if (current === generation.current) {
        setSnapshot(null);
        setFailure({ quote, message: 'Reconnecting To Your Wheel Award' });
        setFailures((count) => count + 1);
      }
    }
  }, [club, user?.id, game, doubled, mode, requested, quote]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);
  // The first read is the effect above; a failed one is retried after 1s, 2s,
  // 4s, then every 8s until the award answers.
  useAutoSettle(failure?.quote === quote && failures > 0, failures, async () => {
    await refresh();
    return true;
  });
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
    /** The server's own guarantee for this award, shown before Start. */
    quote: award ? (state?.quote ?? null) : null,
    recoveredResult: state?.award?.status === 'redeemed' ? state.award.result : null,
    error: failure?.quote === quote ? failure.message : null,
    loading: !state && failure?.quote !== quote,
  };
}
