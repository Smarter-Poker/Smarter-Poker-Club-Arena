import { supabase } from '../lib/supabase';
import { normaliseState, type GameState } from './DiamondGamesService';
import { parseChoiceState, type ChoiceState } from './DiamondChoiceService';
import type { BonusGame } from './DiamondBonusService';
import type { WheelBonusAward } from './DiamondWheelService';
import {
  bonusTotal,
  plinkoBudget,
  validBonusBudget,
  type BonusBudget,
} from '../utils/bonusGameBudget';
import { diamondBonusMinimum, plinkoTableVersion } from '../utils/diamondBonusPayout';
import { CHOICE_MODE } from '../utils/diamondChoiceMath';

/** What the server says this award will start with, read before Start. The
 * server is the authority; the client mirror only refuses a quote that
 * disagrees with the rule it knows, so the guarantee shown is the one paid. */
export interface BonusGuarantee {
  guarantee: 'super' | 'standard';
  /** Chips paid on any loss or un-cashed round, from the full funded entry. */
  minimumPayoutChips: number;
  /** The one setting for Donkey Cross and Diamond Mines; null for the others. */
  mode: string | null;
  /** The Plinko table this award plays: Diamond (5) or Super (4). */
  plinkoTable: number;
}
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
  /** Present exactly when a pending award was quoted. */
  quote: BonusGuarantee | null;
}
export function parseBonusGuarantee(
  g: Record<string, unknown>,
  award: EarnedGameAward,
  game: BonusGame
): BonusGuarantee {
  const boost = award.boost_multiplier === 2 ? 2 : 1;
  const rate = Number(g.diamonds_per_chip ?? (g.config as Record<string, unknown>)?.diamonds_per_chip);
  const expectedMode = game === 'crossing' || game === 'mines' ? CHOICE_MODE[game] : null;
  if (
    !Number.isSafeInteger(rate) ||
    rate < 1 ||
    g.guarantee !== (boost === 2 ? 'super' : 'standard') ||
    typeof g.minimum_payout_chips !== 'number' ||
    g.minimum_payout_chips !== diamondBonusMinimum(award.bet_diamonds / rate, boost) ||
    (g.mode ?? null) !== expectedMode ||
    g.plinko_table !== plinkoTableVersion(boost)
  )
    throw new Error('The Award Guarantee Could Not Be Quoted');
  return {
    guarantee: boost === 2 ? 'super' : 'standard',
    minimumPayoutChips: g.minimum_payout_chips,
    mode: expectedMode,
    plinkoTable: g.plinko_table,
  };
}
/** The award's funded entry with the player's Double Down answer. The Plinko drop value is derived, never chosen. */
export function awardBudget(award: WheelBonusAward, preference: BonusBudget): BonusBudget {
  return plinkoBudget({
    base: award.base_diamonds,
    doubled: preference.doubled,
    denomination: preference.denomination,
    award: {
      id: award.id,
      entryDiamonds: award.entry_diamonds,
      boostMultiplier: award.boost_multiplier as 1 | 2,
    },
  });
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
    let quote: BonusGuarantee | null = null;
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
      quote = parseBonusGuarantee(g, award, game);
    }
    return { enabled: v.enabled, award, gameState, quote };
  },
};
