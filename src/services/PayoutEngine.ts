/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PAYOUT ENGINE — Dynamic Payout Calculation & ICM Approximation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Features:
 * - Dynamic payout calculation based on player count + template selection
 * - Templates: Top 15%, Top 20%, Winner-Take-All, 50/30/20, Custom
 * - ICM-approximation for deal-making (Malmuth-Harville model)
 * - Overlay detection: alert when guaranteed_prize > entries * buy_in
 * - Auto-distribute when players bust
 */

import { PAYOUT_STRUCTURES } from '../config/blindStructures';
import { computePlacePrize } from '../lib/payoutMath';
import { UNIT_CENTS_ASSET_NOT_READ } from '../../server/src/tournament/tournamentUnit';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface PayoutEntry {
  place: number;
  percentage: number;
  amount?: number;
}

export type PayoutTemplate =
  | 'top15'
  | 'top20'
  | 'winner_take_all'
  | '50_30_20'
  | 'sng3'
  | 'sng6'
  | 'sng9'
  | 'custom';

export interface ICMResult {
  userId: string;
  chips: number;
  chipPercentage: number;
  icmEquity: number;
  icmValue: number;
}

export interface OverlayStatus {
  hasOverlay: boolean;
  guaranteedPrize: number;
  entriesPrize: number;
  overlayAmount: number;
  overlayPercentage: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYOUT TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

const PAYOUT_TEMPLATES: Record<PayoutTemplate, PayoutEntry[] | null> = {
  winner_take_all: [{ place: 1, percentage: 100 }],
  '50_30_20': [
    { place: 1, percentage: 50 },
    { place: 2, percentage: 30 },
    { place: 3, percentage: 20 },
  ],
  sng3: [
    { place: 1, percentage: 65 },
    { place: 2, percentage: 35 },
  ],
  sng6: PAYOUT_STRUCTURES.sng6 || [
    { place: 1, percentage: 65 },
    { place: 2, percentage: 35 },
  ],
  sng9: PAYOUT_STRUCTURES.sng9 || [
    { place: 1, percentage: 50 },
    { place: 2, percentage: 30 },
    { place: 3, percentage: 20 },
  ],
  top15: null, // Dynamically generated
  top20: null, // Dynamically generated
  custom: null, // User-defined
};

// ═══════════════════════════════════════════════════════════════════════════════
// PAYOUT ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class PayoutEngineClass {
  /**
   * Generate payout structure for a given template and player count
   */
  generatePayouts(
    template: PayoutTemplate,
    playerCount: number,
    customPayouts?: PayoutEntry[]
  ): PayoutEntry[] {
    if (template === 'custom' && customPayouts) {
      return this.normalizePayouts(customPayouts);
    }

    if (template === 'top15') {
      return this.generateTopPercentPayouts(playerCount, 0.15);
    }

    if (template === 'top20') {
      return this.generateTopPercentPayouts(playerCount, 0.2);
    }

    const staticTemplate = PAYOUT_TEMPLATES[template];
    if (staticTemplate) return [...staticTemplate];

    // Fallback: auto-select based on player count
    return this.autoSelectPayouts(playerCount);
  }

  /**
   * Generate top N% payout structure with smooth distribution
   */
  private generateTopPercentPayouts(playerCount: number, topPercent: number): PayoutEntry[] {
    const paidPlaces = Math.max(1, Math.floor(playerCount * topPercent));
    return this.generateSmoothPayouts(paidPlaces);
  }

  /**
   * Generate smooth payout distribution for N places
   * Uses a weighted geometric series for natural-feeling payouts
   */
  private generateSmoothPayouts(paidPlaces: number): PayoutEntry[] {
    if (paidPlaces <= 0) return [{ place: 1, percentage: 100 }];
    if (paidPlaces === 1) return [{ place: 1, percentage: 100 }];
    if (paidPlaces === 2)
      return [
        { place: 1, percentage: 65 },
        { place: 2, percentage: 35 },
      ];
    if (paidPlaces === 3)
      return [
        { place: 1, percentage: 50 },
        { place: 2, percentage: 30 },
        { place: 3, percentage: 20 },
      ];

    // For 4+ places: geometric decay with floor
    const payouts: PayoutEntry[] = [];
    const decayRate = 0.65; // Each place gets ~65% of the previous
    let remaining = 100;

    for (let i = 1; i <= paidPlaces; i++) {
      let pct: number;
      if (i === paidPlaces) {
        pct = remaining; // Last place gets remainder
      } else {
        pct = Math.max(
          1, // Minimum 1% per place
          Math.round(remaining * (1 - decayRate) * (1 + (paidPlaces - i) * 0.05))
        );
      }
      pct = Math.min(pct, remaining);
      payouts.push({ place: i, percentage: Math.round(pct * 100) / 100 });
      remaining -= pct;
    }

    // Ensure total is exactly 100%
    return this.normalizePayouts(payouts);
  }

  /**
   * Normalize payouts so percentages sum to exactly 100%
   */
  normalizePayouts(payouts: PayoutEntry[]): PayoutEntry[] {
    const total = payouts.reduce((s, p) => s + p.percentage, 0);
    if (Math.abs(total - 100) < 0.01) return payouts;

    const scale = 100 / total;
    const normalized = payouts.map((p) => ({
      ...p,
      percentage: Math.round(p.percentage * scale * 100) / 100,
    }));

    // Fix rounding delta on first place
    const newTotal = normalized.reduce((s, p) => s + p.percentage, 0);
    if (normalized.length > 0) {
      normalized[0].percentage += Math.round((100 - newTotal) * 100) / 100;
    }

    return normalized;
  }

  /**
   * PokerBros-parity payout choice -> concrete structure (2026-08-22).
   *
   * The create-table form's Payout Structure select (Payout 1/2/3 and Winner
   * Take All) used to fall through to autoSelectPayouts, so the four choices
   * produced identical payouts. They now mean what they say:
   *
   *   payout1         top-heavy, ~10% of the field paid
   *   payout2         ~15% of the field paid
   *   payout3         ~20% of the field paid (flattest)
   *   winner_take_all 100% to first
   *
   * Paid places are clamped to (field - 1) so a bubble always exists — the
   * service refuses a structure that pays as many places as there are seats.
   */
  payoutsForChoice(choice: string, playerCount: number): PayoutEntry[] {
    if (choice === 'winner_take_all') return [{ place: 1, percentage: 100 }];
    const n = Math.max(2, Math.floor(playerCount) || 2);
    const spec: Record<string, { pct: number; minPlaces: number; alpha: number }> = {
      payout1: { pct: 0.1, minPlaces: 1, alpha: 1.5 },
      payout2: { pct: 0.125, minPlaces: 1, alpha: 1.25 },
      payout3: { pct: 0.15, minPlaces: 1, alpha: 1.0 },
    };
    const s = spec[choice] ?? spec.payout1;
    const paidPlaces = Math.max(1, Math.min(n - 1, Math.max(s.minPlaces, Math.round(n * s.pct))));
    // 1-3 places: the standard canned shapes (100 / 65-35 / 50-30-20).
    if (paidPlaces <= 3) return this.normalizePayouts(this.generateSmoothPayouts(paidPlaces));
    // 4+ places: power-law weights 1/place^alpha. A higher alpha concentrates
    // money at the top, so payout1 is genuinely top-heavier than payout3.
    // (generateSmoothPayouts is NOT used here: its decay formula grows the
    // first-place share as paid places increase, which is the opposite of
    // what "flatter" means.)
    const weights = Array.from({ length: paidPlaces }, (_, i) => 1 / Math.pow(i + 1, s.alpha));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const payouts = weights.map((w, i) => ({
      place: i + 1,
      percentage: Math.round((w / totalWeight) * 100 * 100) / 100,
    }));
    return this.normalizePayouts(payouts);
  }

  /**
   * Auto-select best payout structure based on player count
   */
  autoSelectPayouts(playerCount: number): PayoutEntry[] {
    if (playerCount <= 3) return PAYOUT_TEMPLATES.sng3!;
    if (playerCount <= 6) return PAYOUT_TEMPLATES.sng6 as PayoutEntry[];
    if (playerCount <= 9) return PAYOUT_TEMPLATES.sng9 as PayoutEntry[];
    if (playerCount <= 18)
      return PAYOUT_STRUCTURES.mtt10 || this.generateTopPercentPayouts(playerCount, 0.2);
    if (playerCount <= 35)
      return PAYOUT_STRUCTURES.mtt20 || this.generateTopPercentPayouts(playerCount, 0.2);
    return PAYOUT_STRUCTURES.mtt50 || this.generateTopPercentPayouts(playerCount, 0.15);
  }

  /**
   * Calculate actual chip amounts from percentages and prize pool
   * Ensures total payouts never exceed prize pool due to rounding
   */
  calculateAmounts(payouts: PayoutEntry[], prizePool: number): PayoutEntry[] {
    /**
     * 2026-08-29: this was a third payout rule, and the worst of them.
     *
     * It TRUNCATED each place (`Math.trunc(...)`) where the engine rounds, and
     * then, if the truncated places somehow still exceeded the pool, it shaved
     * the difference off FIRST PLACE -- the headline prize, the one number
     * every player looks at. The engine's rule does the opposite on purpose:
     * the adjustment lands on the smallest prize, never a headline one.
     *
     * There is one rule now, shared with the engine byte for byte. It already
     * guarantees the places sum to the pool and never exceed it, so the
     * shave-first-place fallback has nothing left to do and is gone with it.
     *
     * 2026-09-13: the unit is stated rather than defaulted, for the reason in
     * server/src/tournament/tournamentUnit.ts. This method is handed a
     * structure and a pool with no tournament and no club behind them, so it
     * cannot read an asset; UNIT_CENTS_ASSET_NOT_READ is that admission
     * spelled out, and is a cent because every tournament that can currently
     * exist is a chip tournament.
     */
    return payouts.map((p) => ({
      ...p,
      amount: computePlacePrize(prizePool, payouts, p.place, UNIT_CENTS_ASSET_NOT_READ),
    }));
  }

  /**
   * ICM Calculation — Malmuth-Harville Model
   * Approximates tournament equity based on chip stacks
   */
  calculateICM(
    players: { userId: string; chips: number }[],
    payouts: PayoutEntry[],
    prizePool: number
  ): ICMResult[] {
    const totalChips = players.reduce((s, p) => s + p.chips, 0);
    if (totalChips <= 0) return [];

    const n = players.length;
    const payoutAmounts = payouts
      .filter((p) => p.place <= n)
      .map((p) => (prizePool * p.percentage) / 100);

    // Malmuth-Harville: recursive probability of finishing in each position
    const results: ICMResult[] = players.map((p) => {
      const chipPct = p.chips / totalChips;

      // Simplified ICM: weighted average of payout positions
      // Each player's probability of finishing in position k is approximately
      // proportional to their chip stack relative to remaining stacks
      let icmEquity = 0;

      // First place probability = chip percentage
      if (payoutAmounts.length > 0) {
        icmEquity += chipPct * payoutAmounts[0];
      }

      // Second place probability (simplified): proportional share of remaining
      if (payoutAmounts.length > 1) {
        const secondProb = chipPct * (1 - chipPct) * (n / (n - 1));
        icmEquity += secondProb * payoutAmounts[1];
      }

      // Third+ place: distribute remaining proportionally
      for (let k = 2; k < payoutAmounts.length; k++) {
        const kthProb = chipPct * (1 / n);
        icmEquity += kthProb * payoutAmounts[k];
      }

      return {
        userId: p.userId,
        chips: p.chips,
        chipPercentage: Math.round(chipPct * 10000) / 100,
        icmEquity: Math.round(icmEquity * 100) / 100,
        icmValue: Math.round(icmEquity * 100) / 100,
      };
    });

    // Normalize so ICM values sum to prize pool
    const icmTotal = results.reduce((s, r) => s + r.icmEquity, 0);
    if (icmTotal > 0) {
      const scale = prizePool / icmTotal;
      for (const r of results) {
        r.icmEquity = Math.round(r.icmEquity * scale * 100) / 100;
        r.icmValue = r.icmEquity;
      }
    }

    return results.sort((a, b) => b.chips - a.chips);
  }

  /**
   * Check overlay status for guaranteed tournaments
   */
  getOverlayStatus(
    guaranteedPrize: number,
    playerCount: number,
    buyInAmount: number
  ): OverlayStatus {
    const entriesPrize = playerCount * buyInAmount;
    const overlayAmount = Math.max(0, guaranteedPrize - entriesPrize);
    return {
      hasOverlay: overlayAmount > 0,
      guaranteedPrize,
      entriesPrize,
      overlayAmount,
      overlayPercentage:
        entriesPrize > 0 ? Math.round((overlayAmount / guaranteedPrize) * 10000) / 100 : 100,
    };
  }

  /**
   * Get remaining payouts for currently playing players
   */
  getRemainingPayouts(
    payouts: PayoutEntry[],
    playersRemaining: number,
    totalPlayers: number,
    prizePool: number
  ): PayoutEntry[] {
    // Filter to only positions that haven't been paid yet
    const remainingPayouts = payouts.filter((p) => p.place <= playersRemaining);
    return this.calculateAmounts(remainingPayouts, prizePool);
  }

  /**
   * Calculate bounty payouts for bounty/PKO tournaments
   * In bounty tournaments, only a portion of buy-in goes to prize pool,
   * the rest is allocated as bounties to award to knockout winners.
   *
   * @param playerCount - Number of players in tournament
   * @param buyIn - Total buy-in per player
   * @param bountyPercentage - Percentage of buy-in allocated to bounties (e.g., 0.5 = 50%)
   * @param payouts - Base payout structure (based on buy-in only)
   * @returns Bounty and payout structure
   */
  calculateBountyPayouts(
    playerCount: number,
    buyIn: number,
    bountyPercentage: number,
    payouts?: PayoutEntry[]
  ): {
    bountyPool: number;
    baseBounty: number;
    prizePool: number;
    payouts: PayoutEntry[];
  } {
    const totalAmount = playerCount * buyIn;
    const bountyPool = totalAmount * bountyPercentage;
    const prizePool = totalAmount - bountyPool;
    const baseBounty = bountyPool / playerCount;

    const finalPayouts = payouts ? this.calculateAmounts(payouts, prizePool) : [];

    return {
      bountyPool,
      baseBounty,
      prizePool,
      payouts: finalPayouts,
    };
  }

  /**
   * Get all available template names with descriptions
   */
  getTemplateOptions(): { value: PayoutTemplate; label: string; description: string }[] {
    return [
      { value: 'top15', label: 'Top 15%', description: 'Standard MTT - Pays Top 15% Of Field' },
      { value: 'top20', label: 'Top 20%', description: 'Generous MTT - Pays Top 20% Of Field' },
      {
        value: 'winner_take_all',
        label: 'Winner Take All',
        description: 'All Chips Go To 1st Place',
      },
      { value: '50_30_20', label: '50/30/20', description: 'Classic 3-Way Split' },
      { value: 'sng3', label: 'SNG (3-Way)', description: '65/35 Two-Player SNG' },
      { value: 'sng6', label: 'SNG (6-Max)', description: 'Standard 6-Max Payout' },
      { value: 'sng9', label: 'SNG (9-Max)', description: 'Standard 9-Max Payout' },
      { value: 'custom', label: 'Custom', description: 'Define Your Own Payout Structure' },
    ];
  }
}

export const payoutEngine = new PayoutEngineClass();
export default payoutEngine;
