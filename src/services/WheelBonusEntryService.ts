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
import {
  BONUS_PAYOUT_VERSION,
  diamondBonusFloor,
  diamondBonusMinimum,
  plinkoTableForFloor,
  plinkoTableVersion,
} from '../utils/diamondBonusPayout';
import { crashCashoutFloorCents } from '../utils/diamondGamesFairness';
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
  /** The Plinko table this award plays: the open board its FLOOR chose, Super
   *  (4) at half the stake and Super Double (6) at the two thirds an add-on
   *  Super award paid. Diamond (5) closed on 2026-09-21. */
  plinkoTable: number;
  /** The contract this award will be sealed under, as the server named it. */
  payoutVersion: number;
  /** The spin entry plus the Double Diamonds add-on, in diamonds. */
  paidDiamonds: number;
  /** Crash only: the first hundredth this contract lets a player book. */
  cashoutFloorCents: number;
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
/**
 * THE GUARANTEE THE SERVER WILL SEAL, CHECKED AGAINST THE RULE THE CLIENT KNOWS.
 *
 * CONTRACT 4 (Dan 2026-09-21, R10/R11, live since 2026-09-23 03:23Z). The floor
 * is fn_diamond_bonus_floor: half the stake ordinarily, and for a Super award
 * the greater of that half and what the player PAID - the spin entry, plus the
 * entry again when Double Diamonds was taken. The board follows that floor
 * through fn_plinko_table_for_floor rather than the boost, which is why a Super
 * award with the add-on is dealt on Super Double (6) and every other stake on
 * Super (4). This read the retired rule on both counts, so the quote for every
 * live award was refused and the player saw "The Award Guarantee Could Not Be
 * Quoted" instead of a game. An award quoted under an older contract - the
 * server still names the version - is still checked by the rule it names.
 */
export function parseBonusGuarantee(
  g: Record<string, unknown>,
  award: EarnedGameAward,
  game: BonusGame
): BonusGuarantee {
  const boost = award.boost_multiplier === 2 ? 2 : 1;
  const rate = Number(
    g.diamonds_per_chip ?? (g.config as Record<string, unknown>)?.diamonds_per_chip
  );
  const expectedMode = game === 'crossing' || game === 'mines' ? CHOICE_MODE[game] : null;
  const version = Number.isSafeInteger(g.payout_version) ? Number(g.payout_version) : 0;
  const sealedWithFloor = version >= BONUS_PAYOUT_VERSION;
  const betChips = award.bet_diamonds / rate;
  // What the player paid: the spin entry, plus whatever the add-on put on top
  // of the funded base. Exactly fn_diamond_game_paid_diamonds.
  const paid = award.entry_diamonds + (award.bet_diamonds - award.base_diamonds);
  const floor = sealedWithFloor
    ? diamondBonusFloor(betChips, boost, paid, rate)
    : diamondBonusMinimum(betChips, boost);
  const table = sealedWithFloor ? plinkoTableForFloor(betChips, floor) : plinkoTableVersion(boost);
  if (
    !Number.isSafeInteger(rate) ||
    rate < 1 ||
    !Number.isSafeInteger(paid) ||
    paid < 0 ||
    g.guarantee !== (boost === 2 ? 'super' : 'standard') ||
    typeof g.minimum_payout_chips !== 'number' ||
    g.minimum_payout_chips !== floor ||
    (g.mode ?? null) !== expectedMode ||
    g.plinko_table !== table ||
    (sealedWithFloor && g.paid_diamonds !== undefined && g.paid_diamonds !== paid) ||
    (sealedWithFloor &&
      game === 'crash' &&
      g.cashout_floor_cents !== undefined &&
      g.cashout_floor_cents !== crashCashoutFloorCents(version))
  )
    throw new Error('The Award Guarantee Could Not Be Quoted');
  return {
    guarantee: boost === 2 ? 'super' : 'standard',
    minimumPayoutChips: g.minimum_payout_chips,
    mode: expectedMode,
    plinkoTable: g.plinko_table as number,
    payoutVersion: version,
    paidDiamonds: paid,
    cashoutFloorCents: crashCashoutFloorCents(version),
  };
}
/**
 * The award's funded entry with the player's own answers for THIS award: the
 * Double Your Diamonds choice and, for Plinko, the drop value. An answer given
 * for an earlier award never pre-answers a new one (Dan 2026-09-21, R9: the
 * decision is its own step; R6: nothing is pre-selected).
 */
export function awardBudget(award: WheelBonusAward, preference: BonusBudget): BonusBudget {
  const own = preference.award?.id === award.id;
  return fundedBudget(
    award,
    own ? preference.doubled : false,
    own ? preference.denomination : null
  );
}
/** The award's funded entry at a stated Double Your Diamonds answer, as the server was asked to quote it. */
function fundedBudget(
  award: WheelBonusAward,
  doubled: boolean,
  denomination: number | null
): BonusBudget {
  return plinkoBudget({
    base: award.base_diamonds,
    doubled,
    denomination,
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
        !validBonusBudget(fundedBudget(award, false, null))
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
      const budget = fundedBudget(award, doubled, null);
      const g = v.game_state as Record<string, unknown> | null;
      if (
        !g ||
        g.ok !== true ||
        g.club_id !== club ||
        g.game !== game ||
        award.bet_diamonds !== bonusTotal(budget) ||
        award.added_diamonds !== (doubled ? award.entry_diamonds : 0) ||
        !Number.isSafeInteger(award.cap_cents) ||
        // The cap must cover the first hundredth this contract lets a player
        // book, which is 1.11x from contract 4 and 1.01x before it.
        award.cap_cents <
          crashCashoutFloorCents(
            typeof (v.game_state as Record<string, unknown> | null)?.payout_version === 'number'
              ? ((v.game_state as Record<string, unknown>).payout_version as number)
              : undefined
          )
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
