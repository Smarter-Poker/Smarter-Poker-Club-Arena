import { supabase } from '../lib/supabase';
import { titleCase } from '../utils/titleCase';

export type OpeningPromotionType =
  | 'leaderboard'
  | 'rake_race'
  | 'milestone'
  | 'mystery'
  | 'high_hand';

export interface ClubOpeningSetupInput {
  clubId: string;
  tagline: string;
  rakePercent: number;
  rakeCapBB: number;
  bbjEnabled: boolean;
  bbjSeed: number;
  spinsEnabled: boolean;
  spinSeed: number;
  spinMaxStake: number;
  promoEnabled: boolean;
  promoType: OpeningPromotionType;
  promoName: string;
  promoDescription: string;
  promoBudget: number;
  leaderboardRewardsEnabled: boolean;
  leaderboardMetric: 'profit' | 'hands_played' | 'tournaments_won' | 'roi';
  leaderboardPrizeBudget: number;
  /**
   * The owner's explicit answer on a paid leaderboard: true when the Club Bank
   * may pay a later round's shortfall as its own recorded overlay leg. Never a
   * default; the server records OFF unless it is sent.
   */
  leaderboardOverlayEnabled: boolean;
}

export interface ClubOpeningSetupResult {
  success: boolean;
  already_completed: boolean;
  club_id: string;
  club_bank_after: number;
  allocated?: number;
  bbj_seeded?: number;
  spin_seeded?: number;
  promo_budget?: number;
  promotion_id?: string | null;
  leaderboard_overlay_enabled?: boolean;
  operation_id: string;
}

export interface ClubOpeningSetupState {
  completed_at: string;
  bbj_enabled: boolean;
  spins_enabled: boolean;
  promo_enabled: boolean;
}

/** What the SERVER holds for the club after an opening setup committed. */
export interface ClubOpeningAppliedState {
  tagline: string;
  spinsEnabled: boolean;
}

/**
 * A refused or failed opening setup, with the one fact a retry needs.
 *
 * `definitive` is true when the database or the API gateway ANSWERED with an
 * error code: the RPC is one transaction, so an answered error means nothing
 * was committed. It is false when no coded answer came back (a dropped
 * connection, a gateway page), where the transaction may have committed and
 * only the response was lost. The caller keeps its request key on an
 * indefinite failure and may rotate it on a definitive one.
 */
export class ClubOpeningSetupError extends Error {
  readonly definitive: boolean;
  readonly code: string;

  constructor(message: string, definitive: boolean, code = '') {
    super(message);
    this.name = 'ClubOpeningSetupError';
    this.definitive = definitive;
    this.code = code;
  }
}

const GENERIC_REFUSAL = 'Club Opening Setup Was Refused. Nothing Was Deducted';

/**
 * A server refusal, fit to print. The opening RPC's own refusals are Title Case
 * but carry numeric(18,2) chip figures ("Club Bank Has 500.00 Chips But Setup
 * Requires 600.00"), and a chip count never prints a decimal: every figure is
 * floored to a whole chip with separators. A percentage keeps its decimal. A
 * raw database message (lower-case, or naming a snake_case identifier) is
 * replaced with a plain refusal rather than shown to the owner.
 */
export function presentOpeningSetupRefusal(message: string | null | undefined): string {
  const text = String(message ?? '').trim();
  if (!/^[A-Z]/.test(text) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(text)) return GENERIC_REFUSAL;
  return titleCase(
    text.replace(/\d[\d,]*(?:\.\d+)?(?!\d|\.\d|\s*%)/g, (figure) =>
      Math.floor(Number(figure.replace(/,/g, ''))).toLocaleString('en-US')
    )
  );
}

/** True when the server answered with a coded refusal, so nothing committed. */
export function isDefinitiveOpeningSetupRefusal(error: unknown): boolean {
  if (error instanceof ClubOpeningSetupError) return error.definitive;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.trim().length > 0;
}

export interface OpeningLeaderboardPrizeSplit {
  first: number;
  second: number;
  third: number;
}

/**
 * The balanced top-three plan the opening RPC publishes for a paid
 * leaderboard. The browser sends ONLY the budget; the server builds the rows
 * as round(budget * 0.50, 2), round(budget * 0.30, 2) and the remainder. This
 * preview floors second and third place to whole chips and gives first place
 * the remainder, so the three figures always sum exactly to the budget. The
 * two calculations agree exactly when the budget is a whole multiple of 10
 * chips, which is why the wizard refuses any other paid budget: the owner is
 * never shown a split the server would not publish.
 */
export function openingLeaderboardPrizeSplit(budget: number): OpeningLeaderboardPrizeSplit {
  const total = Math.max(0, Math.floor(Number(budget) || 0));
  const second = Math.floor((total * 3) / 10);
  const third = Math.floor((total * 2) / 10);
  return { first: total - second - third, second, third };
}

/** True when the preview above is exactly the split the server publishes. */
export function openingLeaderboardBudgetSplitsEvenly(budget: number): boolean {
  return Number.isInteger(budget) && budget > 0 && budget % 10 === 0;
}

export interface OpeningLeaderboardFundingInput {
  promoEnabled: boolean;
  promoBudget: number;
  /** Promo Wallet chips the club already holds. A new club holds none. */
  existingPromoBalance?: number | null;
}

/** The smallest weekly budget the opening RPC accepts for a paid leaderboard. */
export const OPENING_LEADERBOARD_MINIMUM_BUDGET = 100;

/**
 * The Promo Wallet the club holds once setup commits: what it already holds
 * plus the Promotion budget. A paid leaderboard's first round is paid from its
 * own seed; every later round draws on this wallet.
 */
export function openingLeaderboardFundingCapacity(input: OpeningLeaderboardFundingInput): number {
  const existing = Math.max(0, Math.floor(Number(input.existingPromoBalance) || 0));
  const promo = input.promoEnabled ? Math.max(0, Math.floor(Number(input.promoBudget) || 0)) : 0;
  return existing + promo;
}

/**
 * Mirrors what the server still refuses about a paid leaderboard's funding
 * when a club opens.
 *
 * The opening RPC moves the whole weekly budget out of the Club Bank as the
 * first round's explicit seed and, since 20260923143157, writes the setup row
 * that holds it BEFORE it publishes the program. The funding gate
 * (fn_enforce_leaderboard_program_funding) counts that unreleased seed, for
 * the setup's own publication only, beside clubs.promo_balance. The published
 * plan sums exactly to the budget, so the seed alone covers it: no Promotion is
 * required and no Promotion size can refuse it. What the server still refuses
 * is a paid budget under its 100-chip minimum ("A Prize Leaderboard Requires A
 * Minimum 100-Chip Budget"). The seed's Club Bank cover is checked with every
 * other transfer, on the review step.
 *
 * Returns '' when the server will accept the budget, otherwise the Title Case
 * reason to show the owner.
 */
export function openingLeaderboardFundingRefusal(input: {
  leaderboardPrizeBudget: number;
}): string {
  const budget = Number(input.leaderboardPrizeBudget) || 0;
  return budget >= OPENING_LEADERBOARD_MINIMUM_BUDGET
    ? ''
    : 'Leaderboard Prize Budget Must Be At Least 100 Chips';
}

export const clubOpeningSetupService = {
  async getState(clubId: string): Promise<ClubOpeningSetupState | null> {
    const { data, error } = await supabase
      .from('club_opening_setups' as never)
      .select('completed_at, bbj_enabled, spins_enabled, promo_enabled')
      .eq('club_id', clubId)
      .maybeSingle();
    if (error) throw error;
    return data as ClubOpeningSetupState | null;
  },

  /**
   * Reads what the server actually holds after a setup committed. Used when
   * the RPC reports an EARLIER setup, so the page is never told that this
   * browser's unsent answers were applied.
   */
  async getAppliedState(clubId: string): Promise<ClubOpeningAppliedState | null> {
    const { data, error } = await supabase
      .from('clubs')
      .select('tagline, spins_enabled')
      .eq('id', clubId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as { tagline?: string | null; spins_enabled?: boolean | null };
    return { tagline: row.tagline ?? '', spinsEnabled: row.spins_enabled === true };
  },

  /**
   * `operationId` is the CALLER's key: minted once per submission and reused
   * on every retry of it, so a committed setup whose response was lost can be
   * recognised as this submission (the server echoes the key that committed).
   */
  async complete(
    input: ClubOpeningSetupInput,
    operationId: string
  ): Promise<ClubOpeningSetupResult> {
    if (!operationId) throw new ClubOpeningSetupError('Operation ID Is Required', true);
    const { data, error } = await supabase.rpc(
      'fn_complete_club_opening_setup' as never,
      {
        p_club_id: input.clubId,
        p_operation_id: operationId,
        p_tagline: input.tagline,
        p_rake_percent: input.rakePercent,
        p_rake_cap_bb: input.rakeCapBB,
        p_bbj_enabled: input.bbjEnabled,
        p_bbj_seed: input.bbjEnabled ? input.bbjSeed : 0,
        p_spins_enabled: input.spinsEnabled,
        p_spin_seed: input.spinsEnabled ? input.spinSeed : 0,
        p_spin_max_stake: input.spinsEnabled ? input.spinMaxStake : 0,
        p_promo_enabled: input.promoEnabled,
        p_promo_type: input.promoType,
        p_promo_name: input.promoName,
        p_promo_description: input.promoDescription,
        p_promo_budget: input.promoEnabled ? input.promoBudget : 0,
        p_leaderboard_rewards_enabled: input.leaderboardRewardsEnabled,
        p_leaderboard_metric: input.leaderboardMetric,
        p_leaderboard_prize_budget: input.leaderboardRewardsEnabled
          ? input.leaderboardPrizeBudget
          : 0,
        /* The Club Bank overlay travels only when the owner allowed it on a
           paid leaderboard. The server records OFF unless it is sent, so
           leaving it out IS the owner's "Leave Unpaid Until Funded", and the
           eighteen-argument payload is unchanged for every other answer. */
        ...(input.leaderboardRewardsEnabled && input.leaderboardOverlayEnabled
          ? { p_leaderboard_overlay_enabled: true }
          : {}),
      } as never
    );
    if (error) {
      const definitive = isDefinitiveOpeningSetupRefusal(error);
      throw new ClubOpeningSetupError(
        definitive
          ? presentOpeningSetupRefusal(error.message)
          : 'Club Opening Setup Could Not Be Confirmed. Check Your Connection And Try Again',
        definitive,
        typeof error.code === 'string' ? error.code : ''
      );
    }
    const result = data as unknown as ClubOpeningSetupResult;
    if (!result?.success) {
      throw new ClubOpeningSetupError('Club Opening Setup Was Not Completed', false);
    }
    return result;
  },
};
