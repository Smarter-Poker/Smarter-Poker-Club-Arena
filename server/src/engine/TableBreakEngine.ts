import {
  planOnlineGeometry,
  type BalancerTable,
  type OnlineGeometryProfile,
  type OnlineGeometryResult,
} from './TableBalancer.js';
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
import { deadlineScheduler, type DeadlineScheduler } from './DeadlineScheduler.js';

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
  /**
   * A6 FIX: players the break could NOT seat anywhere because every remaining
   * table was full. These players MUST be left seated at the broken table (or
   * the break must be deferred) — the old code silently dropped them, which
   * removed both their seat and their stack from the tournament.
   */
  unplaced: UnplacedPlayer[];
}

export interface UnplacedPlayer {
  playerId: string;
  seat: number;
  stack: number;
}

export interface RedistributionPlan {
  movements: PlayerMovement[];
  unplaced: UnplacedPlayer[];
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
  /** Explicit online-policy entry; no mutation, callbacks or accepted receipt. */
  planOnlineRedistribution(
    brokenTable: BalancerTable,
    remainingTables: readonly BalancerTable[],
    profile: OnlineGeometryProfile
  ): OnlineGeometryResult {
    return planOnlineGeometry([brokenTable, ...remainingTables], profile, brokenTable.tableId);
  }

  private config: TableBreakConfig = {
    minPlayersToBreak: 3,
    warningSeconds: 30,
    balanceThreshold: 2,
  };
  private onEvent?: (event: TableBreakEvent) => void;
  /**
   * Phase 1.2 PR-G-real: central scheduler used for the warning countdown.
   * Replaces the bare setTimeout in initiateBreak. The countdown deadline
   * persists with the scheduler so it survives a restart (rehydration is
   * trivial — fire any past-due deadlines on the next tick).
   */
  private scheduler: DeadlineScheduler;

  constructor(
    onEvent?: (event: TableBreakEvent) => void,
    scheduler: DeadlineScheduler = deadlineScheduler
  ) {
    this.onEvent = onEvent;
    this.scheduler = scheduler;
    this.scheduler.start();
  }

  /** Phase 1.2 PR-G-real: stable key for this engine's scheduler entries. */
  private breakCountdownEventId(): string {
    return 'table_break_countdown';
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

    // Phase 1.2 PR-G-real: countdown via DeadlineScheduler instead of setTimeout.
    // The scheduler fires the resolve callback on the next tick after the
    // deadline lands (≤100ms drift), keyed by the broken table's id so a
    // simultaneous break of another table doesn't collide.
    await new Promise<void>((resolve) => {
      this.scheduler.schedule({
        tableId: brokenTable.tableId,
        eventId: this.breakCountdownEventId(),
        deadlineMs: Date.now() + this.config.warningSeconds * 1000,
        callback: resolve,
      });
    });

    // Phase 2: Execute break
    this.emitEvent({
      type: 'TABLE_BREAK_STARTED',
      tableId: brokenTable.tableId,
      tournamentId,
      playerCount: brokenTable.playerCount,
    });

    // Calculate optimal redistribution
    const plan = this.planRedistribution(brokenTable, remainingTables);
    const movements = plan.movements;
    if (plan.unplaced.length > 0) {
      // A6 FIX: never let this pass silently. The caller must keep these
      // players seated at the broken table rather than deleting their seats.
      reportError(
        new Error(
          `[TableBreakEngine] Table break of ${brokenTable.tableId} left ${plan.unplaced.length} player(s) unplaced - every remaining table is full. Their seats MUST be preserved: ${plan.unplaced.map((u) => u.playerId).join(', ')}`
        ),
        'TableBreakEngine.unplaced_players'
      );
    }
    const result: BreakResult = {
      brokenTableId: brokenTable.tableId,
      movements,
      remainingTables: remainingTables.map((t) => t.tableId),
      totalMoved: movements.length,
      unplaced: plan.unplaced,
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
      unplacedCount: plan.unplaced.length,
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
    const plan = this.planRedistribution(brokenTable, remainingTables);
    if (plan.unplaced.length > 0) {
      reportError(
        new Error(
          `[TableBreakEngine] calculateRedistribution could not seat ${plan.unplaced.length} player(s) from ${brokenTable.tableId} - every remaining table is full. Use planRedistribution() to handle them; do NOT delete their seats.`
        ),
        'TableBreakEngine.unplaced_players'
      );
    }
    return plan.movements;
  }

  /**
   * A6 FIX (2026-07-28) — the version that cannot lose a player.
   *
   * The previous implementation walked a round-robin index across a list that
   * was sorted by player count exactly ONCE, and when the single table it
   * looked at *and* the single next table were both full it ran `continue` —
   * silently dropping that player. A dropped player loses their seat AND their
   * stack, i.e. they are removed from the tournament and their chips vanish,
   * even though other tables may still have had open seats.
   *
   * This version, for every player, recomputes the set of tables that actually
   * have BOTH a free slot and a free seat number, and picks the emptiest of
   * them (ties broken by table id, so the plan is deterministic). A player is
   * only ever reported as `unplaced` when there is genuinely nowhere to sit —
   * and even then they are returned to the caller instead of being discarded.
   *
   * It also no longer mutates the caller's snapshots: it plans against private
   * clones, so calling this twice gives the same answer.
   */
  planRedistribution(
    brokenTable: TableSnapshot,
    remainingTables: TableSnapshot[]
  ): RedistributionPlan {
    const movements: PlayerMovement[] = [];
    const unplaced: UnplacedPlayer[] = [];

    if (brokenTable.players.length === 0) {
      return { movements, unplaced };
    }
    if (remainingTables.length === 0) {
      // Nowhere to go at all — surface every player rather than returning an
      // empty movement list that reads like "nothing to do".
      for (const p of brokenTable.players) {
        unplaced.push({ playerId: p.playerId, seat: p.seat, stack: p.stack });
      }
      return { movements, unplaced };
    }

    // Plan against clones so repeated calls are idempotent and the caller's
    // snapshots are never corrupted by a plan that is later discarded.
    const tables: TableSnapshot[] = remainingTables.map((t) => ({
      ...t,
      occupiedSeats: [...t.occupiedSeats],
    }));

    for (const player of brokenTable.players) {
      const candidates = tables
        .filter((t) => t.playerCount < t.maxPlayers && this.openSeats(t).length > 0)
        .sort((a, b) => a.playerCount - b.playerCount || a.tableId.localeCompare(b.tableId));

      const target = candidates[0];
      const seat = target ? this.findOptimalSeat(target) : null;
      if (!target || seat === null) {
        unplaced.push({ playerId: player.playerId, seat: player.seat, stack: player.stack });
        continue;
      }

      movements.push({
        playerId: player.playerId,
        fromTableId: brokenTable.tableId,
        fromSeat: player.seat,
        toTableId: target.tableId,
        toSeat: seat,
        stack: player.stack,
      });
      target.playerCount++;
      target.occupiedSeats.push(seat);
    }

    return { movements, unplaced };
  }

  /** Seat numbers 1..maxPlayers that are not in `occupiedSeats`. */
  private openSeats(table: TableSnapshot): number[] {
    const occupied = new Set(table.occupiedSeats);
    const empty: number[] = [];
    for (let s = 1; s <= table.maxPlayers; s++) {
      if (!occupied.has(s)) empty.push(s);
    }
    return empty;
  }

  /**
   * Find optimal seat at a table using seat lottery.
   * Picks a random empty seat for fair positioning.
   *
   * A6 FIX: returns null when the table has no free seat. It used to return
   * seat 1 — a seat that by definition was already taken — which produced two
   * players on the same seat number instead of an honest failure.
   */
  private findOptimalSeat(table: TableSnapshot): number | null {
    const emptySeats = this.openSeats(table);
    if (emptySeats.length === 0) return null;

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
    // A6 FIX: findOptimalSeat now returns null instead of colliding on seat 1.
    if (seat === null) return [];
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
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'TableBreakEngine.eventHandler');
      }
    }
  }
}
