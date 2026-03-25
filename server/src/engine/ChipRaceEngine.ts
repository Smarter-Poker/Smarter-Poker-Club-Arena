/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP RACE ENGINE — Tournament Denomination Removal
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * When tournament blind levels increase, smaller chip denominations become
 * unnecessary. The chip race removes them fairly:
 * 1. Count each player's chips of the small denomination
 * 2. Convert as many as possible into the next denomination
 * 3. Award remaining fractional chips via card-deal lottery
 * 4. No player can be eliminated by a chip race (minimum 1 chip guarantee)
 *
 * Ported from client: src/engine/ChipRaceEngine.ts (183 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

import { secureRandomInt } from './CryptoRandom.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChipRacePlayer {
  playerId: string;
  stack: number;
  fractionalChips: number;
  lotteryValue: number;
  chipsAwarded: number;
}

export interface ChipRaceResult {
  tournamentId: string;
  removedDenomination: number;
  newSmallestDenomination: number;
  players: ChipRacePlayer[];
  totalFractionalCollected: number;
  totalNewChipsDistributed: number;
}

export type ChipRaceEventType = 'CHIP_RACE_COMPLETED';

export interface ChipRaceEvent {
  type: ChipRaceEventType;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHIP RACE ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class ChipRaceEngine {
  private onEvent?: (event: ChipRaceEvent) => void;

  constructor(onEvent?: (event: ChipRaceEvent) => void) {
    this.onEvent = onEvent;
  }

  executeChipRace(
    tournamentId: string,
    playerStacks: Map<string, number>,
    oldDenomination: number,
    newDenomination: number
  ): ChipRaceResult {
    if (newDenomination <= oldDenomination) {
      throw new Error(
        `Invalid chip race: new denomination (${newDenomination}) must be greater than old (${oldDenomination})`
      );
    }

    if (playerStacks.size === 0) {
      throw new Error('Cannot execute chip race with no players');
    }

    if (playerStacks.size === 1) {
      const [playerId, stack] = playerStacks.entries().next().value!;
      const fractionalChips = stack % newDenomination;
      const newStack = stack - fractionalChips;
      playerStacks.set(playerId, newStack);

      return {
        tournamentId,
        removedDenomination: oldDenomination,
        newSmallestDenomination: newDenomination,
        players: [{
          playerId,
          stack: newStack,
          fractionalChips,
          lotteryValue: 0,
          chipsAwarded: 0,
        }],
        totalFractionalCollected: fractionalChips,
        totalNewChipsDistributed: 0,
      };
    }

    const players: ChipRacePlayer[] = [];
    let totalFractionalCollected = 0;

    for (const [playerId, stack] of playerStacks) {
      const fractionalChips = stack % newDenomination;
      totalFractionalCollected += fractionalChips;
      players.push({ playerId, stack, fractionalChips, lotteryValue: 0, chipsAwarded: 0 });
    }

    const totalNewChips = Math.floor(totalFractionalCollected / newDenomination);
    let remainingChips = totalNewChips;

    const playersWithFractions = players.filter((p) => p.fractionalChips > 0);
    for (const player of playersWithFractions) {
      player.lotteryValue = player.fractionalChips * 1000 + secureRandomInt(1000);
    }

    playersWithFractions.sort((a, b) => b.lotteryValue - a.lotteryValue);

    for (const player of playersWithFractions) {
      if (remainingChips <= 0) break;
      player.chipsAwarded = newDenomination;
      remainingChips--;
    }

    for (const player of players) {
      let newStack = player.stack - player.fractionalChips + player.chipsAwarded;
      if (newStack <= 0) newStack = newDenomination;
      playerStacks.set(player.playerId, newStack);
      player.stack = newStack;
    }

    const result: ChipRaceResult = {
      tournamentId,
      removedDenomination: oldDenomination,
      newSmallestDenomination: newDenomination,
      players,
      totalFractionalCollected,
      totalNewChipsDistributed: totalNewChips,
    };

    this.emitEvent({
      type: 'CHIP_RACE_COMPLETED',
      tournamentId,
      playersAffected: playersWithFractions.length,
      smallestDenomination: oldDenomination,
      newSmallestDenomination: newDenomination,
    });

    return result;
  }

  private emitEvent(event: ChipRaceEvent): void {
    if (this.onEvent) {
      try { this.onEvent(event); } catch (err) { console.error('[ChipRaceEngine] Event handler error:', err); }
    }
  }
}
