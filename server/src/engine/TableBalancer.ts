import { reportError } from '../services/errorReporter.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE BALANCER — MTT Table Balancing Optimizer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Optimizes player distribution across tournament tables:
 * - Minimize max-min player count gap across tables
 * - Generate optimal move list with minimum total moves
 * - Respect seat-availability constraints
 * - Called by TournamentEngine after each elimination
 *
 * Ported from client: src/engine/TableBalancer.ts (239 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BalancerTable {
  tableId: string;
  playerCount: number;
  maxSeats: number;
  players: BalancerPlayer[];
}

export interface BalancerPlayer {
  userId: string;
  stack: number;
  seat: number;
}

export interface MoveInstruction {
  playerId: string;
  fromTableId: string;
  fromSeat: number;
  toTableId: string;
  toSeat: number;
  reason: string;
}

export interface BalanceScore {
  score: number; // 0 = perfect, higher = worse
  maxPlayers: number;
  minPlayers: number;
  gap: number;
  avgPlayers: number;
}

export type TableBalancerEventType = 'TABLE_BALANCE_EXECUTED';

export interface TableBalancerEvent {
  type: TableBalancerEventType;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TABLE BALANCER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class TableBalancer {
  private onEvent?: (event: TableBalancerEvent) => void;

  constructor(onEvent?: (event: TableBalancerEvent) => void) {
    this.onEvent = onEvent;
  }

  /**
   * Calculate balance score for current table distribution.
   * Score 0 = perfectly balanced.
   */
  evaluateBalance(tables: BalancerTable[]): BalanceScore {
    if (tables.length <= 1) {
      return {
        score: 0,
        maxPlayers: tables[0]?.playerCount || 0,
        minPlayers: tables[0]?.playerCount || 0,
        gap: 0,
        avgPlayers: tables[0]?.playerCount || 0,
      };
    }

    const counts = tables.map((t) => t.playerCount);
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    const avg = counts.reduce((s, c) => s + c, 0) / counts.length;
    const gap = max - min;

    // Score = sum of squared deviations from ideal
    const ideal = avg;
    const score = counts.reduce((s, c) => s + Math.pow(c - ideal, 2), 0);

    return {
      score: Math.round(score * 100) / 100,
      maxPlayers: max,
      minPlayers: min,
      gap,
      avgPlayers: Math.round(avg * 10) / 10,
    };
  }

  /**
   * Should we rebalance? Triggered when gap > 1 player.
   * Standard poker tournament rule: tables should differ by at most 1 player.
   */
  shouldRebalance(tables: BalancerTable[]): boolean {
    if (tables.length <= 1) return false;
    const { gap } = this.evaluateBalance(tables);
    return gap > 1;
  }

  /**
   * Calculate the optimal set of moves to balance tables.
   * Moves players from over-seated to under-seated tables.
   * Minimizes total moves while achieving gap <= 1.
   */
  calculateMoves(tables: BalancerTable[]): MoveInstruction[] {
    if (tables.length <= 1) return [];

    const totalPlayers = tables.reduce((s, t) => s + t.playerCount, 0);
    const idealPerTable = Math.floor(totalPlayers / tables.length);
    const remainder = totalPlayers % tables.length;

    // Sort tables by player count descending — most populated get the +1 targets
    const sortedByCount = tables
      .map((t) => ({
        ...t,
        target: 0,
      }))
      .sort((a, b) => b.playerCount - a.playerCount);

    for (let i = 0; i < sortedByCount.length; i++) {
      sortedByCount[i].target = i < remainder ? idealPerTable + 1 : idealPerTable;
    }

    // Identify over-seated and under-seated tables
    const overSeated = sortedByCount.filter((t) => t.playerCount > t.target);
    const underSeated = sortedByCount.filter((t) => t.playerCount < t.target);

    const moves: MoveInstruction[] = [];

    for (const over of overSeated) {
      let excess = over.playerCount - over.target;

      // Pick players with smallest stacks to move (least disruptive)
      const movablePlayers = [...over.players].sort((a, b) => a.stack - b.stack);

      for (const under of underSeated) {
        if (excess <= 0) break;
        let deficit = under.target - under.playerCount;

        while (excess > 0 && deficit > 0 && movablePlayers.length > 0) {
          const player = movablePlayers.shift()!;
          const toSeat = this.findOpenSeat(under);

          if (toSeat === -1) break; // No open seats

          moves.push({
            playerId: player.userId,
            fromTableId: over.tableId,
            fromSeat: player.seat,
            toTableId: under.tableId,
            toSeat,
            reason: `Balance: ${over.tableId.slice(0, 8)} (${over.playerCount}) → ${under.tableId.slice(0, 8)} (${under.playerCount})`,
          });

          // Update counts for subsequent calculations
          over.playerCount--;
          under.playerCount++;
          under.players.push({ ...player, seat: toSeat });
          excess--;
          deficit--;
        }
      }
    }

    if (moves.length > 0) {
      this.emitEvent({
        type: 'TABLE_BALANCE_EXECUTED',
        moveCount: moves.length,
        tableCount: tables.length,
        totalPlayers,
      });
    }

    return moves;
  }

  /**
   * Check if a table should be broken (merged into others).
   * A table should break when it has too few players and others can absorb them.
   */
  shouldBreakTable(table: BalancerTable, allTables: BalancerTable[]): boolean {
    if (allTables.length <= 1) return false;
    if (table.playerCount === 0) return true;

    // Break if this table has <= 3 players and other tables have room
    const otherTables = allTables.filter((t) => t.tableId !== table.tableId);
    const totalCapacity = otherTables.reduce((s, t) => s + (t.maxSeats - t.playerCount), 0);

    return table.playerCount <= 3 && totalCapacity >= table.playerCount;
  }

  /**
   * Generate moves to break a table and distribute its players to other tables.
   */
  breakTable(table: BalancerTable, otherTables: BalancerTable[]): MoveInstruction[] {
    const moves: MoveInstruction[] = [];
    const targets = [...otherTables].sort((a, b) => a.playerCount - b.playerCount);

    for (const player of table.players) {
      // FIX-B7 2026-07-19: spread broken-table players to the LEAST-full target
      // each iteration, and REFLECT each placement. The old code never updated
      // the chosen target's playerCount/players, so it (a) dumped everyone onto
      // targets[0] until full instead of balancing, and (b) called findOpenSeat
      // against a stale player list — returning the SAME seat for every player →
      // seat collisions. Re-sort by occupancy, then increment + record the seat.
      targets.sort((a, b) => a.playerCount - b.playerCount);
      const target = targets.find((t) => t.playerCount < t.maxSeats);
      if (!target) break;

      const toSeat = this.findOpenSeat(target);
      if (toSeat === -1) continue;

      moves.push({
        playerId: player.userId,
        fromTableId: table.tableId,
        fromSeat: player.seat,
        toTableId: target.tableId,
        toSeat,
        reason: `Table break: ${table.tableId.slice(0, 8)} dissolved`,
      });

      // Reflect the placement so the next player spreads + gets a distinct seat.
      target.playerCount++;
      target.players.push({ ...player, seat: toSeat });
    }

    return moves;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  private findOpenSeat(table: BalancerTable): number {
    const occupiedSeats = new Set(table.players.map((p) => p.seat));
    for (let seat = 1; seat <= table.maxSeats; seat++) {
      if (!occupiedSeats.has(seat)) return seat;
    }
    return -1;
  }

  private emitEvent(event: TableBalancerEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'TableBalancer.eventHandler');
      }
    }
  }
}
