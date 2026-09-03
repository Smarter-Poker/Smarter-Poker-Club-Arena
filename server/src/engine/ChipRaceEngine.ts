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
import { reportError } from '../services/errorReporter.js';

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

    // FIX 161 → TOURNEY-AUDIT 2026-07-24 (sweep 4): Single player — no race
    // needed. Round DOWN (floor) to the denomination: the old round-UP awarded
    // a free denomination whenever fractional chips existed, MINTING chips and
    // violating tournament chip conservation (flagged while the engine is
    // disabled so it is safe whenever chip race is re-enabled). The minimum
    // 1-denomination guarantee still protects a sub-denomination stack.
    if (playerStacks.size === 1) {
      const [playerId, stack] = playerStacks.entries().next().value!;
      const fractionalChips = stack % newDenomination;
      const newStack = Math.max(newDenomination, stack - fractionalChips);
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

    for (const [playerId, stack] of playerStacks) {
      const fractionalChips = stack % newDenomination;
      totalFractionalCollected += fractionalChips;
      players.push({ playerId, stack, fractionalChips, lotteryValue: 0, chipsAwarded: 0 });
    }

    const totalNewChips = Math.floor(totalFractionalCollected / newDenomination);
    let remainingChips = totalNewChips;

    /**
     * A9 FIX (2026-08-20): make the chip race an actual race.
     *
     * The lottery value was `fractionalChips * 1000 + secureRandomInt(1000)`.
     * The deterministic term dominates the random one by construction, so a
     * player holding 500 fractional chips scored 500,000-500,999 and one
     * holding 499 scored 499,000-499,999: the larger holding ALWAYS won. Chance
     * only ever broke ties between players with an identical fraction. A player
     * one chip short could never beat a player one chip ahead, in any race, ever
     * — which is a ranking, not a lottery, and not what a chip race is.
     *
     * The standard method deals one card per fractional chip and the highest
     * card wins: more chips means better ODDS, never a guarantee. That is
     * exactly "draw N uniforms, keep your highest", and the maximum of N
     * uniforms on (0,1) has CDF x^N — so drawing a single uniform u and taking
     * u^(1/N) is the identical distribution at one draw per player instead of
     * one per chip. Same fairness, no 9,000-syscall race.
     */
    const playersWithFractions = players.filter((p) => p.fractionalChips > 0);
    const LOTTERY_PRECISION = 1_000_000;
    for (const player of playersWithFractions) {
      // u in (0,1] — never 0, so a player can never be handed a guaranteed loss.
      const u = (secureRandomInt(LOTTERY_PRECISION) + 1) / LOTTERY_PRECISION;
      player.lotteryValue = Math.pow(u, 1 / player.fractionalChips);
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
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'ChipRaceEngine.eventHandler');
      }
    }
  }
}
