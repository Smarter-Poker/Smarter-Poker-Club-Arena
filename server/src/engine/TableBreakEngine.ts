/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE BREAK ENGINE — Balanced Player Redistribution for Tournaments
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages table breaks during tournaments:
 * - Detects when a table qualifies for breaking (too few players)
 * - Calculates optimal player redistribution to balance remaining tables
 * - Minimizes total player movements
 * - Seat lottery for fair positioning at new tables
 * - Countdown warning before break
 * - Optional event callbacks for all phases
 *
 * Ported from client: src/engine/TableBreakEngine.ts (265 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

// FIX 163: Use crypto-secure random for seat lottery fairness
import { secureRandomInt } from './CryptoRandom.js';
import { reportError } from '../services/errorReporter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface TableBreakConfig {
  minPlayersToBreak: number; // Break table when below this count
  warningSeconds: number; // Countdown warning before break
  balanceThreshold: number; // Max imbalance (e.g., 2 = no table has 2+ more than another)
}

export interface TableSnapshot {
  tableId: string;
  playerCount: number;
  maxPlayers: number;
  occupiedSeats: number[];
  players: Array<{
    playerId: string;
    seat: number;
    stack: number;
  }>;
}

export interface PlayerMovement {
  playerId: string;
  fromTableId: string;
  fromSeat: number;
  toTableId: string;
  toSeat: number;
  stack: number;
}

export interface BreakResult {
  brokenTableId: string;
  movements: PlayerMovement[];
  remainingTables: string[];
  totalMoved: number;
}

export type TableBreakEventType =
  | 'TABLE_BREAK_WARNING'
  | 'TABLE_BREAK_STARTED'
  | 'PLAYER_MOVED'
  | 'TABLE_BREAK_COMPLETED';

export interface TableBreakEvent {
  type: TableBreakEventType;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE BREAK ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class TableBreakEngine {
  private config: TableBreakConfig = {
    minPlayersToBreak: 3,
    warningSeconds: 30,
    balanceThreshold: 2,
  };
  private onEvent?: (event: TableBreakEvent) => void;

  constructor(onEvent?: (event: TableBreakEvent) => void) {
    this.onEvent = onEvent;
  }

  /**
   * Update configuration
   */
  configure(config: Partial<TableBreakConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Check if a table should be broken based on player count
   */
  shouldBreak(playerCount: number): boolean {
    return playerCount > 0 && playerCount < this.config.minPlayersToBreak;
  }

  /**
   * Start a table break with countdown warning.
   * Emits TABLE_BREAK_WARNING immediately, then TABLE_BREAK_STARTED after countdown.
   *
   * @returns Promise that resolves with the break result after countdown
   */
  async initiateBreak(
    brokenTable: TableSnapshot,
    remainingTables: TableSnapshot[],
    tournamentId: string
  ): Promise<BreakResult> {
    // Phase 1: Warning countdown
    this.emitEvent({
      type: 'TABLE_BREAK_WARNING',
      tableId: brokenTable.tableId,
      tournamentId,
      secondsRemaining: this.config.warningSeconds,
      playerCount: brokenTable.playerCount,
    });

    // Wait for countdown
    await new Promise<void>((resolve) => {
      setTimeout(resolve, this.config.warningSeconds * 1000);
    });

    // Phase 2: Execute break
    this.emitEvent({
      type: 'TABLE_BREAK_STARTED',
      tableId: brokenTable.tableId,
      tournamentId,
      playerCount: brokenTable.playerCount,
    });

    // Calculate optimal redistribution
    const movements = this.calculateRedistribution(brokenTable, remainingTables);
    const result: BreakResult = {
      brokenTableId: brokenTable.tableId,
      movements,
      remainingTables: remainingTables.map((t) => t.tableId),
      totalMoved: movements.length,
    };

    // Emit individual player movements
    for (const move of movements) {
      this.emitEvent({
        type: 'PLAYER_MOVED',
        tournamentId,
        playerId: move.playerId,
        fromTableId: move.fromTableId,
        fromSeat: move.fromSeat,
        toTableId: move.toTableId,
        toSeat: move.toSeat,
        stack: move.stack,
      });
    }

    // Phase 3: Break completed
    this.emitEvent({
      type: 'TABLE_BREAK_COMPLETED',
      tableId: brokenTable.tableId,
      tournamentId,
      totalMoved: movements.length,
      remainingTableCount: remainingTables.length,
    });

    return result;
  }

  /**
   * Calculate optimal redistribution using balanced distribution.
   * Minimizes total player movements while keeping tables balanced.
   */
  calculateRedistribution(
    brokenTable: TableSnapshot,
    remainingTables: TableSnapshot[]
  ): PlayerMovement[] {
    if (remainingTables.length === 0 || brokenTable.players.length === 0) {
      return [];
    }

    const movements: PlayerMovement[] = [];
    const playersToMove = [...brokenTable.players];

    // Sort remaining tables by player count (ascending) — fill emptiest first
    const sortedTables = [...remainingTables].sort((a, b) => a.playerCount - b.playerCount);

    // Distribute players round-robin to maintain balance
    let tableIndex = 0;
    for (const player of playersToMove) {
      const targetTable = sortedTables[tableIndex % sortedTables.length];

      // Skip if target table is full
      if (targetTable.playerCount >= targetTable.maxPlayers) {
        tableIndex++;
        // Try next table
        const nextTable = sortedTables[tableIndex % sortedTables.length];
        if (nextTable.playerCount >= nextTable.maxPlayers) continue;
        // Use next table instead
        const seat = this.findOptimalSeat(nextTable);
        movements.push({
          playerId: player.playerId,
          fromTableId: brokenTable.tableId,
          fromSeat: player.seat,
          toTableId: nextTable.tableId,
          toSeat: seat,
          stack: player.stack,
        });
        nextTable.playerCount++;
        nextTable.occupiedSeats.push(seat);
      } else {
        // Seat lottery: pick a random empty seat
        const seat = this.findOptimalSeat(targetTable);
        movements.push({
          playerId: player.playerId,
          fromTableId: brokenTable.tableId,
          fromSeat: player.seat,
          toTableId: targetTable.tableId,
          toSeat: seat,
          stack: player.stack,
        });
        targetTable.playerCount++;
        targetTable.occupiedSeats.push(seat);
      }

      tableIndex++;
    }

    return movements;
  }

  /**
   * Find optimal seat at a table using seat lottery.
   * Picks a random empty seat for fair positioning.
   */
  private findOptimalSeat(table: TableSnapshot): number {
    const occupied = new Set(table.occupiedSeats);
    const emptySeats: number[] = [];

    for (let s = 1; s <= table.maxPlayers; s++) {
      if (!occupied.has(s)) emptySeats.push(s);
    }

    if (emptySeats.length === 0) return 1; // Shouldn't happen

    // FIX 163: Random seat from available (seat lottery) — crypto-secure for fairness
    return emptySeats[secureRandomInt(emptySeats.length)];
  }

  /**
   * Check if tables need rebalancing (without breaking any table).
   * Returns movements to rebalance if the imbalance exceeds threshold.
   */
  checkRebalance(tables: TableSnapshot[]): PlayerMovement[] {
    if (tables.length < 2) return [];

    const counts = tables.map((t) => t.playerCount);
    const maxCount = Math.max(...counts);
    const minCount = Math.min(...counts);

    if (maxCount - minCount <= this.config.balanceThreshold) {
      return []; // Tables are balanced enough
    }

    // Move 1 player from the largest to the smallest table
    const movements: PlayerMovement[] = [];
    const largestTable = tables.find((t) => t.playerCount === maxCount);
    const smallestTable = tables.find((t) => t.playerCount === minCount);

    if (!largestTable || !smallestTable) return [];

    const playerToMove = largestTable.players[largestTable.players.length - 1]; // Last seated
    if (!playerToMove) return [];

    const seat = this.findOptimalSeat(smallestTable);
    movements.push({
      playerId: playerToMove.playerId,
      fromTableId: largestTable.tableId,
      fromSeat: playerToMove.seat,
      toTableId: smallestTable.tableId,
      toSeat: seat,
      stack: playerToMove.stack,
    });

    return movements;
  }

  private emitEvent(event: TableBreakEvent): void {
    if (this.onEvent) {
      try { this.onEvent(event); } catch (err) { reportError(err, 'TableBreakEngine.eventHandler'); }
    }
  }
}
