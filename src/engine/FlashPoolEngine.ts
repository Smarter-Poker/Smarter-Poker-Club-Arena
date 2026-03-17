/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FLASH POOL ENGINE — Fast-Fold Player Pool System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages a pool of tables for fast-fold poker (a.k.a. Zoom/Rush/Snap):
 * - Players fold → instantly moved to a new table with new cards
 * - Shared player pool across multiple tables
 * - Zero wait time between hands
 * - Bus emissions for seamless UI transitions
 *
 * Flow:
 *   1. Player joins pool at a given stake level
 *   2. Engine assigns player to a table when a seat opens
 *   3. Player folds (or hand ends) → instantly reassigned
 *   4. Transition animation plays via FlashTransition.tsx
 */

import { masterBus } from '../core/MasterBus';
import { HeadlessTableEngine } from './HeadlessTableEngine';
import { supabase } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface FlashPoolConfig {
  poolId: string;
  stakes: string; // e.g., '0.25/0.50'
  smallBlind: number;
  bigBlind: number;
  maxPlayersPerTable: number; // Usually 6 or 9
  minTablesActive: number;
  maxTablesActive: number;
  buyInMin: number;
  buyInMax: number;
}

export type FlashPlayerStatus =
  | 'in_pool' // Waiting for assignment
  | 'at_table' // Seated and playing
  | 'folding' // Fold animation, about to be reassigned
  | 'transitioning' // Moving between tables
  | 'sitting_out'; // In pool but not active

export interface FlashPlayer {
  playerId: string;
  status: FlashPlayerStatus;
  currentTableId: string | null;
  stack: number;
  handsPlayed: number;
  joinedAt: number; // timestamp
}

export interface FlashTable {
  tableId: string;
  players: Set<string>;
  isActive: boolean;
  handInProgress: boolean;
}

export interface FlashPoolState {
  poolId: string;
  config: FlashPoolConfig;
  players: Map<string, FlashPlayer>;
  tables: Map<string, FlashTable>;
  totalHandsDealt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FLASH POOL ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class FlashPoolEngineClass {
  private pools: Map<string, FlashPoolState> = new Map();
  private dealingEngines: Map<string, HeadlessTableEngine> = new Map();

  /**
   * Create a new flash pool at a given stake level
   */
  createPool(config: FlashPoolConfig): FlashPoolState {
    const state: FlashPoolState = {
      poolId: config.poolId,
      config,
      players: new Map(),
      tables: new Map(),
      totalHandsDealt: 0,
    };

    // Pre-create minimum tables
    for (let i = 0; i < config.minTablesActive; i++) {
      const tableId = `${config.poolId}_table_${i + 1}`;
      state.tables.set(tableId, {
        tableId,
        players: new Set(),
        isActive: true,
        handInProgress: false,
      });

      // Spin up a HeadlessTableEngine per flash table
      const engine = new HeadlessTableEngine(tableId, supabase);
      this.dealingEngines.set(tableId, engine);
      engine.start().catch((err) => {
        console.error(`[FlashPoolEngine] Engine start failed for ${tableId}:`, err);
      });
    }

    this.pools.set(config.poolId, state);

    masterBus.emit('GAME_CREATED', {
      type: 'flash-pool',
      poolId: config.poolId,
      stakes: config.stakes,
    });

    return state;
  }

  /**
   * Player joins the fast-fold pool
   */
  joinPool(poolId: string, playerId: string, buyIn: number): boolean {
    const pool = this.pools.get(poolId);
    if (!pool) return false;

    if (buyIn < pool.config.buyInMin || buyIn > pool.config.buyInMax) return false;
    if (pool.players.has(playerId)) return false;

    const player: FlashPlayer = {
      playerId,
      status: 'in_pool',
      currentTableId: null,
      stack: buyIn,
      handsPlayed: 0,
      joinedAt: Date.now(),
    };

    pool.players.set(playerId, player);

    masterBus.emit('FLASH_PLAYER_JOINED', {
      poolId,
      playerId,
      poolSize: pool.players.size,
    });

    // Try to immediately seat the player
    this.assignToTable(poolId, playerId);

    return true;
  }

  /**
   * Assign a player to an available table
   */
  private assignToTable(poolId: string, playerId: string): void {
    const pool = this.pools.get(poolId);
    if (!pool) return;

    const player = pool.players.get(playerId);
    if (!player || player.status === 'at_table') return;

    // Find a table with an open seat
    let targetTable: FlashTable | null = null;

    for (const table of pool.tables.values()) {
      if (table.isActive && table.players.size < pool.config.maxPlayersPerTable) {
        targetTable = table;
        break;
      }
    }

    // If no table available, try to create one
    if (!targetTable && pool.tables.size < pool.config.maxTablesActive) {
      const tableId = `${poolId}_table_${pool.tables.size + 1}`;
      targetTable = {
        tableId,
        players: new Set(),
        isActive: true,
        handInProgress: false,
      };
      pool.tables.set(tableId, targetTable);

      // Spin up a dealing engine for the new table
      const engine = new HeadlessTableEngine(tableId, supabase);
      this.dealingEngines.set(tableId, engine);
      engine.start().catch((err) => {
        console.error(`[FlashPoolEngine] Engine start failed for ${tableId}:`, err);
      });
    }

    if (!targetTable) return; // Pool is full

    // Seat the player
    player.status = 'at_table';
    player.currentTableId = targetTable.tableId;
    targetTable.players.add(playerId);

    masterBus.emit('FLASH_PLAYER_SEATED', {
      poolId,
      playerId,
      tableId: targetTable.tableId,
      seatCount: targetTable.players.size,
    });
  }

  /**
   * Player folds — immediately reassign to a new table
   * This is the core fast-fold mechanic
   */
  playerFolded(poolId: string, playerId: string): void {
    const pool = this.pools.get(poolId);
    if (!pool) return;

    const player = pool.players.get(playerId);
    if (!player || !player.currentTableId) return;

    const oldTableId = player.currentTableId;

    // Remove from current table
    const currentTable = pool.tables.get(player.currentTableId);
    if (currentTable) {
      currentTable.players.delete(playerId);
    }

    player.status = 'transitioning';
    player.currentTableId = null;
    player.handsPlayed++;

    masterBus.emit('FLASH_TRANSITION', {
      poolId,
      playerId,
      fromTableId: oldTableId,
      direction: 'fold',
    });

    // Immediately reassign after brief transition delay
    setTimeout(() => {
      if (pool.players.has(playerId)) {
        player.status = 'in_pool';
        this.assignToTable(poolId, playerId);
      }
    }, 400); // 400ms transition animation
  }

  /**
   * Hand completed at a table — reassign all players who didn't win
   */
  handCompleted(poolId: string, tableId: string, winnerId: string): void {
    const pool = this.pools.get(poolId);
    if (!pool) return;

    const table = pool.tables.get(tableId);
    if (!table) return;

    pool.totalHandsDealt++;

    // All players except the winner get reassigned
    for (const playerId of table.players) {
      const player = pool.players.get(playerId);
      if (!player) continue;

      player.handsPlayed++;

      if (playerId !== winnerId) {
        table.players.delete(playerId);
        player.status = 'transitioning';
        player.currentTableId = null;

        masterBus.emit('FLASH_TRANSITION', {
          poolId,
          playerId,
          fromTableId: tableId,
          direction: 'hand_complete',
        });

        // Reassign after transition
        setTimeout(() => {
          if (pool.players.has(playerId)) {
            player.status = 'in_pool';
            this.assignToTable(poolId, playerId);
          }
        }, 400);
      }
    }
  }

  /**
   * Player sits out (stays in pool but not assigned)
   */
  sitOut(poolId: string, playerId: string): void {
    const pool = this.pools.get(poolId);
    if (!pool) return;

    const player = pool.players.get(playerId);
    if (!player) return;

    // Remove from current table
    if (player.currentTableId) {
      const table = pool.tables.get(player.currentTableId);
      if (table) table.players.delete(playerId);
    }

    player.status = 'sitting_out';
    player.currentTableId = null;

    masterBus.emit('FLASH_SIT_OUT', { poolId, playerId });
  }

  /**
   * Player sits back in
   */
  sitBack(poolId: string, playerId: string): void {
    const pool = this.pools.get(poolId);
    if (!pool) return;

    const player = pool.players.get(playerId);
    if (!player || player.status !== 'sitting_out') return;

    player.status = 'in_pool';
    this.assignToTable(poolId, playerId);

    masterBus.emit('FLASH_SIT_BACK', { poolId, playerId });
  }

  /**
   * Player leaves the pool entirely
   */
  leavePool(poolId: string, playerId: string): number {
    const pool = this.pools.get(poolId);
    if (!pool) return 0;

    const player = pool.players.get(playerId);
    if (!player) return 0;

    const cashout = player.stack;

    // Remove from current table
    if (player.currentTableId) {
      const table = pool.tables.get(player.currentTableId);
      if (table) table.players.delete(playerId);
    }

    pool.players.delete(playerId);

    masterBus.emit('FLASH_PLAYER_LEFT', {
      poolId,
      playerId,
      cashout,
      handsPlayed: player.handsPlayed,
    });

    // Clean up empty tables above minimum
    this.cleanupTables(poolId);

    return cashout;
  }

  /**
   * Remove empty tables above minimum count
   */
  private cleanupTables(poolId: string): void {
    const pool = this.pools.get(poolId);
    if (!pool) return;

    const emptyTables = [...pool.tables.values()].filter((t) => t.players.size === 0);
    const excessCount = pool.tables.size - pool.config.minTablesActive;

    for (let i = 0; i < Math.min(emptyTables.length, excessCount); i++) {
      const tableId = emptyTables[i].tableId;
      pool.tables.delete(tableId);

      // Stop and cleanup the dealing engine for removed tables
      const engine = this.dealingEngines.get(tableId);
      if (engine) {
        engine
          .stop()
          .catch((e) =>
            console.warn(`[FlashPoolEngine] Failed to stop engine for table ${tableId}:`, e)
          );
        this.dealingEngines.delete(tableId);
      }
    }
  }

  /**
   * Get pool state
   */
  getState(poolId: string): FlashPoolState | null {
    return this.pools.get(poolId) ?? null;
  }

  /**
   * Get player count in pool
   */
  getPlayerCount(poolId: string): number {
    return this.pools.get(poolId)?.players.size ?? 0;
  }

  /**
   * Cleanup entire pool
   */
  dispose(poolId: string): void {
    const pool = this.pools.get(poolId);
    if (pool) {
      // Stop all dealing engines for this pool's tables
      for (const table of pool.tables.values()) {
        const engine = this.dealingEngines.get(table.tableId);
        if (engine) {
          engine
            .stop()
            .catch((e) =>
              console.warn(
                `[FlashPoolEngine] Failed to stop pool engine for table ${table.tableId}:`,
                e
              )
            );
          this.dealingEngines.delete(table.tableId);
        }
      }
    }
    this.pools.delete(poolId);
  }

  /**
   * Get the dealing engine for a specific flash table
   */
  getEngine(tableId: string): HeadlessTableEngine | null {
    return this.dealingEngines.get(tableId) ?? null;
  }
}

export const flashPoolEngine = new FlashPoolEngineClass();
export default flashPoolEngine;
