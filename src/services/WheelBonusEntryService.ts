import { supabase } from '../lib/supabase';
import { normaliseState, type GameState } from './DiamondGamesService';
import { parseChoiceState, type ChoiceState } from './DiamondChoiceService';
import type { BonusGame } from './DiamondBonusService';
import type { WheelBonusAward } from './DiamondWheelService';
import { bonusTotal, validBonusBudget, type BonusBudget } from '../utils/bonusGameBudget';

export interface EarnedGameAward extends WheelBonusAward {
  club_id: string;
  status: 'pending' | 'redeemed';
  cap_cents: number;
  bet_diamonds: number;
  added_diamonds: number;
  result: Record<string, unknown> | null;
  commit_id: string | null;
}
export interface WheelBonusState {
  enabled: boolean;
  award: EarnedGameAward | null;
  gameState: GameState | ChoiceState | null;
}
export function awardBudget(award: WheelBonusAward, preference: BonusBudget): BonusBudget {
  const next: BonusBudget = {
    base: award.base_diamonds,
    doubled: preference.doubled,
    denomination: preference.denomination,
    award: {
      id: award.id,
      entryDiamonds: award.entry_diamonds,
      boostMultiplier: award.boost_multiplier as 1 | 2,
    },
  };
  if (bonusTotal(next) % next.denomination !== 0) next.denomination = 1;
  return next;
}
export const WheelBonusEntryService = {
  async state(
    club: string,
    game: BonusGame,
    doubled: boolean,
    mode?: string,
    awardId?: string | null
  ): Promise<WheelBonusState> {
    const { data, error } = await supabase.rpc(
      'fn_wheel_bonus_state' as never,
      {
        p_club_id: club,
        p_game: game,
        p_double: doubled,
        p_mode: mode ?? null,
        p_award_id: awardId ?? null,
      } as never
    );
    if (error) throw error;
    const v = data as Record<string, unknown> | null;
    if (
      !v ||
      v.ok !== true ||
      v.contract_version !== 2 ||
      typeof v.enabled !== 'boolean' ||
      !Array.isArray(v.awards)
    )
      throw new Error('Your Wheel Award Could Not Be Checked');
    const awards = v.awards as EarnedGameAward[];
    const validateAward = (award: EarnedGameAward) => {
      if (
        !award ||
        award.club_id !== club ||
        award.game !== game ||
        !['pending', 'redeemed'].includes(award.status) ||
        !validBonusBudget(awardBudget(award, { base: 100, doubled: false, denomination: 1 }))
      )
        throw new Error('The Wheel Award Does Not Match This Game');
    };
    awards.forEach(validateAward);
    const award = v.award as EarnedGameAward | null;
    // A specifically requested older award can fall outside the recent-50 list.
    if (award !== null) {
      validateAward(award);
      if (awardId && award.id !== awardId)
        throw new Error('The Wheel Award Does Not Match This Game');
    }
    if (
      award?.result &&
      (award.result.ok !== true ||
        award.result.club_id !== club ||
        award.result.game !== game ||
        award.result.award_id !== award.id)
    )
      throw new Error('The Saved Award Does Not Match This Game');
    let gameState: GameState | ChoiceState | null = null;
    if (award?.status === 'pending') {
      const budget = awardBudget(award, { base: 100, doubled, denomination: 1 });
      const g = v.game_state as Record<string, unknown> | null;
      if (
        !g ||
        g.ok !== true ||
        g.club_id !== club ||
        g.game !== game ||
        award.bet_diamonds !== bonusTotal(budget) ||
        award.added_diamonds !== (doubled ? award.entry_diamonds : 0) ||
        !Number.isSafeInteger(award.cap_cents) ||
        award.cap_cents < 101
      )
        throw new Error('The Award Entry Could Not Be Quoted');
      gameState =
        game === 'mines' || game === 'crossing'
          ? parseChoiceState(g, club, game)
          : normaliseState(g);
    }
    return { enabled: v.enabled, award, gameState };
  },
};
