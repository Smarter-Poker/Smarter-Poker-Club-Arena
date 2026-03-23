/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP RACE ENGINE — Tournament Denomination Removal
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * When tournament blind levels increase, smaller chip denominations become
 * unnecessary. The chip race removes them fairly:
 *
 * 1. Count each player's chips of the small denomination
 * 2. Convert as many as possible into the next denomination
 * 3. Award remaining fractional chips via card-deal lottery
 * 4. No player can be eliminated by a chip race (minimum 1 chip guarantee)
 */

import { masterBus } from '../core/MasterBus';
import { secureRandomInt } from './CryptoRandom';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ChipRacePlayer {
  playerId: string;
  /** Total stack in current smallest denomination units */
  stack: number;
  /** Number of fractional chips (chips that don't divide evenly into new denomination) */
  fractionalChips: number;
  /** Random value for lottery (higher = better chance) */
  lotteryValue: number;
  /** Chips awarded from the race */
  chipsAwarded: number;
}

export interface ChipRaceResult {
  tournamentId: string;
  /** The denomination being removed */
  removedDenomination: number;
  /** The new smallest denomination */
  newSmallestDenomination: number;
  /** Players and their adjustments */
  players: ChipRacePlayer[];
  /** Total fractional chips collected */
  totalFractionalCollected: number;
  /** Total new chips distributed */
  totalNewChipsDistributed: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHIP RACE ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class ChipRaceEngineClass {
  /**
   * Execute a chip race for a tournament.
   *
   * @param tournamentId - The tournament ID
   * @param playerStacks - Map of playerId → current stack
   * @param oldDenomination - The denomination being removed (e.g., 25)
   * @param newDenomination - The next denomination up (e.g., 100)
   * @returns ChipRaceResult with adjusted stacks
   */
  executeChipRace(
    tournamentId: string,
    playerStacks: Map<string, number>,
    oldDenomination: number,
    newDenomination: number
  ): ChipRaceResult {
    // VALIDATION 1: Ensure blinds are increasing
    if (newDenomination <= oldDenomination) {
      throw new Error(
        `Invalid chip race: new denomination (${newDenomination}) must be greater than old (${oldDenomination})`
      );
    }

    // VALIDATION 2: Handle edge cases
    if (playerStacks.size === 0) {
      throw new Error('Cannot execute chip race with no players');
    }

    if (playerStacks.size === 1) {
      // Single player: no race needed, just remove fractional chips
      const [playerId, stack] = playerStacks.entries().next().value;
      const fractionalChips = stack % newDenomination;
      const newStack = stack - fractionalChips;
      playerStacks.set(playerId, newStack);

      return {
        tournamentId,
        removedDenomination: oldDenomination,
        newSmallestDenomination: newDenomination,
        players: [
          {
            playerId,
            stack: newStack,
            fractionalChips,
            lotteryValue: 0,
            chipsAwarded: 0,
          },
        ],
        totalFractionalCollected: fractionalChips,
        totalNewChipsDistributed: 0,
      };
    }

    const players: ChipRacePlayer[] = [];
    let totalFractionalCollected = 0;

    // Step 1: Calculate each player's fractional chips
    for (const [playerId, stack] of playerStacks) {
      const fractionalChips = stack % newDenomination;
      totalFractionalCollected += fractionalChips;

      players.push({
        playerId,
        stack,
        fractionalChips,
        lotteryValue: 0,
        chipsAwarded: 0,
      });
    }

    // Step 2: Convert fractional pool into whole chips of new denomination
    const totalNewChips = Math.floor(totalFractionalCollected / newDenomination);
    let remainingChips = totalNewChips;

    // Step 3: Lottery — assign random values to players with fractions
    const playersWithFractions = players.filter((p) => p.fractionalChips > 0);

    for (const player of playersWithFractions) {
      // Lottery value: combination of fraction size + random component
      // Players with more fractional chips get slightly better odds
      player.lotteryValue = player.fractionalChips * 1000 + secureRandomInt(1000);
    }

    // Sort by lottery value descending (highest wins first)
    playersWithFractions.sort((a, b) => b.lotteryValue - a.lotteryValue);

    // Step 4: Distribute new chips to lottery winners
    for (const player of playersWithFractions) {
      if (remainingChips <= 0) break;
      player.chipsAwarded = newDenomination;
      remainingChips--;
    }

    // Step 5: Calculate final stacks (guarantee no elimination)
    for (const player of players) {
      // Remove fractional chips, add any awarded chips
      let newStack = player.stack - player.fractionalChips + player.chipsAwarded;

      // CRITICAL: No player can be eliminated by chip race
      // If their stack would be 0, give them 1 chip of new denomination
      if (newStack <= 0) {
        newStack = newDenomination;
      }

      // Update the player stack in the map
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

    masterBus.emit('CHIP_RACE_COMPLETED', {
      tournamentId,
      playersAffected: playersWithFractions.length,
      smallestDenomination: oldDenomination,
      newSmallestDenomination: newDenomination,
    });

    return result;
  }
}

export const chipRaceEngine = new ChipRaceEngineClass();
export default chipRaceEngine;
