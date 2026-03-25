/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INSURANCE ENGINE — All-In Equity Insurance System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages insurance offers when players go all-in:
 * - Triggered when 2+ players are all-in before the river
 * - Uses MonteCarloEquity to calculate real equity percentages
 * - Premium = (1 - equity%) × insuredAmount × margin
 * - Offer/accept/decline flow with configurable timeout
 * - Settlement after board is dealt
 * - Optional event callbacks for UI synchronization
 *
 * Ported from client: src/engine/InsuranceEngine.ts (291 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

import { monteCarloEquity } from './MonteCarloEquity.js';
import type { Card } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface InsuranceConfig {
  enabled: boolean;
  houseMargin: number;
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
  equity: number;
  premium: number;
  insuredAmount: number;
  status: 'offered' | 'accepted' | 'declined' | 'settled';
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

export interface InsuranceSettlement {
  playerId: string;
  insuredAmount: number;
  premium: number;
  payout: number;
  won: boolean;
}

export type InsuranceEventType =
  | 'INSURANCE_OFFERED'
  | 'INSURANCE_ACCEPTED'
  | 'INSURANCE_DECLINED'
  | 'INSURANCE_SETTLED';

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

  private readonly DEFAULT_CONFIG: InsuranceConfig = {
    enabled: false,
    houseMargin: 1.05,
    maxInsurablePercent: 100,
    offerTimeoutSeconds: 15,
    minPotForInsurance: 0,
    equityIterations: 5000,
  };

  constructor(onEvent?: (event: InsuranceEvent) => void) {
    this.onEvent = onEvent;
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
   */
  createOffers(
    tableId: string,
    handId: string,
    allInPlayers: Array<{ playerId: string; holeCards: Card[] }>,
    board: Card[],
    pot: number
  ): InsuranceOffer[] {
    const config = this.tableConfigs.get(tableId) || this.DEFAULT_CONFIG;
    if (!config.enabled || pot < config.minPotForInsurance) return [];
    if (allInPlayers.length < 2 || board.length < 3) return [];

    const offers: InsuranceOffer[] = [];
    const numOpponents = allInPlayers.length - 1;

    for (const player of allInPlayers) {
      const equity = monteCarloEquity(
        player.holeCards,
        board,
        numOpponents,
        config.equityIterations
      );

      const maxInsurable = pot * (config.maxInsurablePercent / 100);
      const lossProbability = 1 - equity / 100;
      const insuredAmount = Math.min(maxInsurable, pot * (equity / 100));
      const premium = Math.round(insuredAmount * lossProbability * config.houseMargin * 100) / 100;

      const offer: InsuranceOffer = {
        tableId,
        handId,
        playerId: player.playerId,
        holeCards: player.holeCards,
        equity,
        premium,
        insuredAmount: Math.round(insuredAmount * 100) / 100,
        status: 'offered',
      };

      offer.timeoutTimer = setTimeout(() => {
        if (offer.status === 'offered') {
          this.decline(tableId, player.playerId);
        }
      }, config.offerTimeoutSeconds * 1000);

      offers.push(offer);

      this.emitEvent({
        type: 'INSURANCE_OFFERED',
        tableId,
        handId,
        playerId: player.playerId,
        equity,
        premium,
        insuredAmount: offer.insuredAmount,
      });
    }

    this.activeOffers.set(tableId, offers);
    return offers;
  }

  accept(tableId: string, playerId: string): boolean {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return false;

    const offer = offers.find((o) => o.playerId === playerId && o.status === 'offered');
    if (!offer) return false;

    offer.status = 'accepted';
    if (offer.timeoutTimer) clearTimeout(offer.timeoutTimer);

    this.emitEvent({
      type: 'INSURANCE_ACCEPTED',
      tableId,
      handId: offer.handId,
      playerId,
      premium: offer.premium,
    });

    return true;
  }

  decline(tableId: string, playerId: string): void {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return;

    const offer = offers.find((o) => o.playerId === playerId && o.status === 'offered');
    if (!offer) return;

    offer.status = 'declined';
    if (offer.timeoutTimer) clearTimeout(offer.timeoutTimer);

    this.emitEvent({
      type: 'INSURANCE_DECLINED',
      tableId,
      handId: offer.handId,
      playerId,
    });
  }

  /**
   * Settle all accepted insurance offers based on hand outcome.
   */
  settle(tableId: string, winnerId: string): InsuranceSettlement[] {
    const offers = this.activeOffers.get(tableId);
    if (!offers) return [];

    const settlements: InsuranceSettlement[] = [];

    for (const offer of offers) {
      if (offer.status !== 'accepted') continue;

      const playerLost = offer.playerId !== winnerId;
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
        won: playerLost,
      });
    }

    this.activeOffers.delete(tableId);
    return settlements;
  }

  allResponded(tableId: string): boolean {
    const offers = this.activeOffers.get(tableId);
    if (!offers || offers.length === 0) return true;
    return offers.every((o) => o.status !== 'offered');
  }

  getOffers(tableId: string): InsuranceOffer[] {
    return this.activeOffers.get(tableId) || [];
  }

  dispose(tableId: string): void {
    const offers = this.activeOffers.get(tableId);
    if (offers) {
      for (const offer of offers) {
        if (offer.timeoutTimer) clearTimeout(offer.timeoutTimer);
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
        console.error('[InsuranceEngine] Event handler error:', err);
      }
    }
  }
}
