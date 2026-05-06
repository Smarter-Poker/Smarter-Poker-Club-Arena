/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INSURANCE ENGINE — All-In Equity Insurance System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages insurance offers when players go all-in:
 * - Triggered when 2+ players are all-in before the river
 * - Uses MonteCarloEquity to calculate real equity percentages
 * - Premium = (1 - equity%) × insuredAmount × houseMargin (20% edge)
 * - Offer/accept/decline flow with configurable timeout
 * - Partial coverage: player can insure 1-100% via slider (default 100%)
 * - Per-street recalculation: equity changes as board cards are dealt
 * - Max insurable = pot amount
 * - Settlement after board is dealt — premium deducted like rake at end
 * - Optional event callbacks for UI synchronization
 *
 * Ported from client: src/engine/InsuranceEngine.ts (291 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 *
 * FIX 78: House margin 5%→20%, partial coverage slider, per-street recalc
 */

import { monteCarloEquity } from './MonteCarloEquity.js';
import type { Card } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { deadlineScheduler, type DeadlineScheduler } from './DeadlineScheduler.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface InsuranceConfig {
  enabled: boolean;
  /** House margin multiplier: 1.20 = 20% house edge on premiums */
  houseMargin: number;
  /** Max insurable as % of pot (100 = can insure up to full pot) */
  maxInsurablePercent: number;
  offerTimeoutSeconds: number;
  minPotForInsurance: number;
  equityIterations: number;
}

export interface InsuranceOffer {
  tableId: string;
  handId: string;
  playerId: string;
  holeCards: Card[];
  /** Player's equity % (0-100) at current board state */
  equity: number;
  /** Premium for FULL insurance (100% coverage) — scales with coveragePercent */
  fullPremium: number;
  /** Actual premium to pay based on coveragePercent */
  premium: number;
  /** Full insured amount (100% coverage) — scales with coveragePercent */
  fullInsuredAmount: number;
  /** Actual insured amount based on coveragePercent */
  insuredAmount: number;
  /** Coverage percentage chosen by player (1-100, default 100) */
  coveragePercent: number;
  status: 'offered' | 'accepted' | 'declined' | 'settled';
  /** If true, player declined for the entire hand (won't be re-offered on later streets) */
  declinedForHand: boolean;
  // Phase 1.2 PR-G-real: timeouts routed through DeadlineScheduler singleton via
  // the engine's private `scheduler` ref, keyed by
  // eventId = `insurance_offer:${playerId}` on the offer's tableId. The raw
  // setTimeout handle was deleted — nothing else to store on the offer.
}

export interface InsuranceSettlement {
  playerId: string;
  insuredAmount: number;
  premium: number;
  payout: number;
  /** true = insurance paid out (player lost the hand) */
  won: boolean;
}

export type InsuranceEventType =
  | 'INSURANCE_OFFERED'
  | 'INSURANCE_ACCEPTED'
  | 'INSURANCE_DECLINED'
  | 'INSURANCE_SETTLED'
  | 'INSURANCE_RECALCULATED';

export interface InsuranceEvent {
  type: InsuranceEventType;
  tableId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INSURANCE ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class InsuranceEngine {
  private tableConfigs: Map<string, InsuranceConfig> = new Map();
  private activeOffers: Map<string, InsuranceOffer[]> = new Map();
  private onEvent?: (event: InsuranceEvent) => void;
  /**
   * Phase 1.2 PR-G-real: central scheduler used for offer expiry. Replaces
   * per-offer setTimeout handles. The scheduler is the single source of
   * truth for deadlines — it survives rehydration after server restart and
   * one tick loop fires every expiring offer across all tables.
   */
  private scheduler: DeadlineScheduler;

  private readonly DEFAULT_CONFIG: InsuranceConfig = {
    enabled: false,
    houseMargin: 1.2, // 20% house edge — per Dan's explicit instruction
    maxInsurablePercent: 100, // Max insurable = pot amount
    offerTimeoutSeconds: 15,
    minPotForInsurance: 0,
    equityIterations: 5000,
  };

  constructor(
    onEvent?: (event: InsuranceEvent) => void,
    scheduler: DeadlineScheduler = deadlineScheduler
  ) {
    this.onEvent = onEvent;
    this.scheduler = scheduler;
    // Idempotent: singleton already running in production, but tests may
    // construct their own scheduler and need it started here.
    this.scheduler.start();
  }

  /** Phase 1.2 PR-G-real: stable key for this engine's scheduler entries. */
  private offerEventId(playerId: string): string {
    return `insurance_offer:${playerId}`;
  }

  configure(tableId: string, config: Partial<InsuranceConfig>): void {
    this.tableConfigs.set(tableId, { ...this.DEFAULT_CONFIG, ...config });
  }

  isEnabled(tableId: string): boolean {
    return this.tableConfigs.get(tableId)?.enabled ?? false;
  }

  /**
   * Create insurance offers for all-in players.
   * Called by ServerTableEngine when an all-in runout is pending.
   *
   * Default offer is FULL insurance (100% coverage).
   * Player can adjust via acceptPartial() with a slider before accepting.
   * Premium = (1 - equity%) × insuredAmount × houseMargin
   * Max insurable = min(pot × maxInsurablePercent%, pot × equity%)
   */
  createOffers(
    tableId: string,
    handId: string,
    allInPlayers: Array<{ playerId: string; holeCards: Card[] }>,
    board: Card[],
    pot: number,
    shortDeck: boolean = false
  ): InsuranceOffer[] {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    if (!config.enabled || pot < config.minPotForInsurance) return [];
    if (allInPlayers.length < 2) return [];
    // Insurance requires cards still to come (board < 5). Board can be 0 (preflop all-in).
    if (board.length >= 5) return [];

    const offers: InsuranceOffer[] = [];
    const numOpponents = allInPlayers.length - 1;

    for (const player of allInPlayers) {
      // FIX 139: Pass shortDeck flag for correct Short Deck hand rankings in equity calculation
      const equity = monteCarloEquity(
        player.holeCards,
        board,
        numOpponents,
        config.equityIterations,
        shortDeck
      );

      // Max insurable = pot amount (maxInsurablePercent defaults to 100%)
      const maxInsurable = pot * (config.maxInsurablePercent / 100);
      const lossProbability = 1 - equity / 100;
      // Full insured amount = the portion of pot the player "expects" to win
      const fullInsuredAmount =
        Math.round(Math.min(maxInsurable, pot * (equity / 100)) * 100) / 100;
      // Full premium = insuredAmount × lossProbability × houseMargin (20% edge)
      const fullPremium =
        Math.round(fullInsuredAmount * lossProbability * config.houseMargin * 100) / 100;

      const offer: InsuranceOffer = {
        tableId,
        handId,
        playerId: player.playerId,
        holeCards: player.holeCards,
        equity,
        fullPremium,
        premium: fullPremium, // Default: 100% coverage
        fullInsuredAmount,
        insuredAmount: fullInsuredAmount, // Default: 100% coverage
        coveragePercent: 100,
        status: 'offered',
        declinedForHand: false,
      };

      // Phase 1.2 PR-G-real: replace setTimeout with DeadlineScheduler entry.
      this.scheduler.schedule({
        tableId,
        eventId: this.offerEventId(player.playerId),
        deadlineMs: Date.now() + config.offerTimeoutSeconds * 1000,
        callback: () => {
          if (offer.status === 'offered') {
            this.decline(tableId, player.playerId);
          }
        },
      });

      offers.push(offer);

      this.emitEvent({
        type: 'INSURANCE_OFFERED',
        tableId,
        handId,
        playerId: player.playerId,
        equity,
        fullPremium,
        premium: fullPremium,
        fullInsuredAmount,
        insuredAmount: fullInsuredAmount,
        coveragePercent: 100,
        pot,
      });
    }

    this.activeOffers.set(tableId, offers);
    return offers;
  }

  /**
   * Accept insurance with full coverage (100%).
   */
  accept(tableId: string, playerId: string): boolean {
    return this.acceptPartial(tableId, playerId, 100);
  }

  /**
   * Accept insurance with partial coverage (1-100%).
   * Player uses a slider to choose how much coverage they want.
   * e.g., 75% coverage = 75% of the insuredAmount, 75% of the premium.
   */
  acceptPartial(tableId: string, playerId: string, coveragePercent: number): boolean {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return false;

    const offer = offers.find((o) => o.playerId === playerId && o.status === 'offered');
    if (!offer) return false;

    // Clamp coverage to valid range
    const coverage = Math.max(1, Math.min(100, Math.round(coveragePercent)));
    const coverageMultiplier = coverage / 100;

    // Scale insured amount and premium by coverage percentage
    offer.coveragePercent = coverage;
    offer.insuredAmount = Math.round(offer.fullInsuredAmount * coverageMultiplier * 100) / 100;
    offer.premium = Math.round(offer.fullPremium * coverageMultiplier * 100) / 100;
    offer.status = 'accepted';
    // Phase 1.2 PR-G-real: cancel the pending expiry deadline.
    this.scheduler.cancel(tableId, this.offerEventId(playerId));

    this.emitEvent({
      type: 'INSURANCE_ACCEPTED',
      tableId,
      handId: offer.handId,
      playerId,
      premium: offer.premium,
      insuredAmount: offer.insuredAmount,
      coveragePercent: coverage,
    });

    return true;
  }

  /**
   * Decline insurance.
   * @param forHand — If true, player declines for the ENTIRE hand (won't be re-offered on later streets).
   *                  If false (default), player declines this street only — may be re-offered if equity shifts.
   */
  decline(tableId: string, playerId: string, forHand: boolean = false): void {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return;

    const offer = offers.find((o) => o.playerId === playerId && o.status === 'offered');
    if (!offer) return;

    offer.status = 'declined';
    offer.declinedForHand = forHand;
    // Phase 1.2 PR-G-real: cancel the pending expiry deadline.
    this.scheduler.cancel(tableId, this.offerEventId(playerId));

    this.emitEvent({
      type: 'INSURANCE_DECLINED',
      tableId,
      handId: offer.handId,
      playerId,
      declinedForHand: forHand,
    });
  }

  /**
   * Recalculate equity and premiums for all offers when a new street is dealt.
   * Called by ServerTableEngine when board changes (turn/river dealt during insurance window).
   *
   * Key behaviors:
   * - Recalculates equity for all players
   * - Updates premiums dynamically per-street
   * - If a player who "Declined Now" (not "Declined for Hand") was NOT the leader before
   *   but IS now the leader, they get a new offer (equity shifted in their favor)
   * - Players who "Declined for Hand" are NEVER re-offered
   */
  recalculateOffers(
    tableId: string,
    newBoard: Card[],
    pot: number,
    shortDeck: boolean = false
  ): void {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return;

    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    const maxInsurable = pot * (config.maxInsurablePercent / 100);
    const numOpponents = offers.length - 1;

    // First pass: recalculate equity for ALL offers
    for (const offer of offers) {
      // FIX 139: Pass shortDeck flag for correct Short Deck hand rankings
      const newEquity = monteCarloEquity(
        offer.holeCards,
        newBoard,
        numOpponents,
        config.equityIterations,
        shortDeck
      );

      const lossProbability = 1 - newEquity / 100;
      const newFullInsured =
        Math.round(Math.min(maxInsurable, pot * (newEquity / 100)) * 100) / 100;
      const newFullPremium =
        Math.round(newFullInsured * lossProbability * config.houseMargin * 100) / 100;

      const oldEquity = offer.equity;
      offer.equity = newEquity;
      offer.fullInsuredAmount = newFullInsured;
      offer.fullPremium = newFullPremium;

      // Recalculate actual premium/insured based on current coverage selection
      const coverageMultiplier = offer.coveragePercent / 100;
      offer.insuredAmount = Math.round(newFullInsured * coverageMultiplier * 100) / 100;
      offer.premium = Math.round(newFullPremium * coverageMultiplier * 100) / 100;

      // Re-offer to players who only declined THIS street (not for hand)
      // if their equity has now become the highest (they took the lead)
      if (offer.status === 'declined' && !offer.declinedForHand && newEquity > oldEquity) {
        // Player's equity improved — they may now be the leader. Re-offer insurance.
        offer.status = 'offered';
        offer.coveragePercent = 100;
        offer.insuredAmount = newFullInsured;
        offer.premium = newFullPremium;

        // Phase 1.2 PR-G-real: re-arm the expiry deadline via DeadlineScheduler.
        this.scheduler.schedule({
          tableId,
          eventId: this.offerEventId(offer.playerId),
          deadlineMs: Date.now() + config.offerTimeoutSeconds * 1000,
          callback: () => {
            if (offer.status === 'offered') {
              this.decline(tableId, offer.playerId);
            }
          },
        });

        this.emitEvent({
          type: 'INSURANCE_OFFERED',
          tableId,
          handId: offer.handId,
          playerId: offer.playerId,
          equity: newEquity,
          fullPremium: newFullPremium,
          premium: newFullPremium,
          fullInsuredAmount: newFullInsured,
          insuredAmount: newFullInsured,
          coveragePercent: 100,
          reoffered: true,
          board: newBoard,
        });
      } else if (offer.status === 'offered') {
        // Still pending — just update the numbers
        this.emitEvent({
          type: 'INSURANCE_RECALCULATED',
          tableId,
          handId: offer.handId,
          playerId: offer.playerId,
          equity: newEquity,
          fullPremium: newFullPremium,
          premium: offer.premium,
          fullInsuredAmount: newFullInsured,
          insuredAmount: offer.insuredAmount,
          coveragePercent: offer.coveragePercent,
          board: newBoard,
        });
      }
    }
  }

  /**
   * Get a premium preview for a specific coverage percentage.
   * Used by the client slider to show real-time cost/payout as user adjusts.
   */
  getPreview(
    tableId: string,
    playerId: string,
    coveragePercent: number
  ): { premium: number; insuredAmount: number; coveragePercent: number } | null {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return null;

    const offer = offers.find((o) => o.playerId === playerId && o.status === 'offered');
    if (!offer) return null;

    const coverage = Math.max(1, Math.min(100, Math.round(coveragePercent)));
    const coverageMultiplier = coverage / 100;

    return {
      premium: Math.round(offer.fullPremium * coverageMultiplier * 100) / 100,
      insuredAmount: Math.round(offer.fullInsuredAmount * coverageMultiplier * 100) / 100,
      coveragePercent: coverage,
    };
  }

  /**
   * Settle all accepted insurance offers based on hand outcome.
   */
  /**
   * FIX 118 (restored FIX 110): Accept string | string[] for winnerIds.
   * Bible V8 §4.19: TIES = PUSH — if pot is chopped (multiple winners),
   * insurance is voided for the winner (no premium charged, no payout).
   */
  settle(tableId: string, winnerIds: string | string[]): InsuranceSettlement[] {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return [];

    const winners = Array.isArray(winnerIds) ? winnerIds : [winnerIds];
    const isChop = winners.length > 1;
    const settlements: InsuranceSettlement[] = [];

    for (const offer of offers) {
      if (offer.status !== 'accepted') continue;

      const playerIsWinner = winners.includes(offer.playerId);

      // FIX 118: TIES = PUSH — chop + player is a winner → insurance voided
      if (isChop && playerIsWinner) {
        const settlement: InsuranceSettlement = {
          playerId: offer.playerId,
          insuredAmount: offer.insuredAmount,
          premium: 0, // PUSH — no premium charged
          payout: 0, // PUSH — no payout
          won: false,
        };
        settlements.push(settlement);
        offer.status = 'settled';
        this.emitEvent({
          type: 'INSURANCE_SETTLED',
          tableId,
          handId: offer.handId,
          playerId: offer.playerId,
          payout: 0,
          premium: 0,
          insuredAmount: offer.insuredAmount,
          coveragePercent: offer.coveragePercent,
          won: false,
        });
        continue;
      }

      const playerLost = !playerIsWinner;
      const payout = playerLost ? offer.insuredAmount : 0;

      const settlement: InsuranceSettlement = {
        playerId: offer.playerId,
        insuredAmount: offer.insuredAmount,
        premium: offer.premium,
        payout,
        won: playerLost,
      };

      settlements.push(settlement);
      offer.status = 'settled';

      this.emitEvent({
        type: 'INSURANCE_SETTLED',
        tableId,
        handId: offer.handId,
        playerId: offer.playerId,
        payout,
        premium: offer.premium,
        insuredAmount: offer.insuredAmount,
        coveragePercent: offer.coveragePercent,
        won: playerLost,
      });
    }

    // Phase 1.2 PR-G-real: drop any lingering expiry entries for this table.
    // Accepted/declined offers already cancelled theirs at transition time;
    // this belt-and-suspenders covers any edge-case where settle runs while
    // an offer is still notionally 'offered' (chopped tie with no response).
    for (const offer of this.activeOffers.get(tableId) ?? []) {
      this.scheduler.cancel(tableId, this.offerEventId(offer.playerId));
    }
    this.activeOffers.delete(tableId);
    return settlements;
  }

  allResponded(tableId: string): boolean {
    const offers = this.activeOffers.get(tableId);
    if (!offers || offers.length === 0) return true;
    return offers.every((o) => o.status !== 'offered');
  }

  /**
   * Check if any player is still eligible for insurance offers on future streets.
   * Returns false if ALL players have declined for the entire hand — meaning
   * per-street pause is void and remaining streets should run out instantly.
   *
   * Per Dan's rule: "THIS IS VOID IF THE PLAYER DECLINES INSURANCE FOR HAND OPTION.
   * IT WILL RUN OUT NORMAL, UNLESS THAT PLAYER IS NOT 'BEHIND' —
   * INSURANCE WILL BE OFFERED TO THE PLAYER THAT IS 'AHEAD' IF ANY STREETS ARE STILL PENDING."
   *
   * So we check: is there at least one player who hasn't declined for the entire hand?
   * If yes → per-street pause continues (that player can be offered next street).
   * If no → all have declined for hand → instant runout.
   */
  anyEligibleForInsurance(tableId: string): boolean {
    const offers = this.activeOffers.get(tableId);
    if (!offers || offers.length === 0) return false;
    // At least one player must NOT have declinedForHand
    return offers.some((o) => !o.declinedForHand);
  }

  getOffers(tableId: string): InsuranceOffer[] {
    return this.activeOffers.get(tableId) || [];
  }

  dispose(tableId: string): void {
    const offers = this.activeOffers.get(tableId);
    if (offers) {
      // Phase 1.2 PR-G-real: cancel every expiry deadline we own for this table.
      for (const offer of offers) {
        this.scheduler.cancel(tableId, this.offerEventId(offer.playerId));
      }
    }
    this.activeOffers.delete(tableId);
    this.tableConfigs.delete(tableId);
  }

  disposeAll(): void {
    for (const [tableId] of this.activeOffers) {
      this.dispose(tableId);
    }
    this.tableConfigs.clear();
  }

  private emitEvent(event: InsuranceEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'InsuranceEngine.Event_handler_error');
      }
    }
  }
}
