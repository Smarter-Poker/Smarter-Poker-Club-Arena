import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { HeadlessTableEngine } from './HeadlessTableEngine';
import { HydraService } from '../services/HydraService';

/**
 * CASH GAME ORCHESTRATOR
 * Master service that watches for active cash tables, spins up headless engines,
 * and manages the global horse fleet via HydraService.
 * Designed to be run from an active Admin / Node context.
 */
export class CashGameOrchestrator {
  private activeEngines: Map<string, HeadlessTableEngine> = new Map();
  private isRunning: boolean = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private hydraInterval: ReturnType<typeof setInterval> | null = null;
  private realtimeChannel: RealtimeChannel | null = null;

  // Singleton instance
  private static instance: CashGameOrchestrator;

  private constructor() {}

  static getInstance(): CashGameOrchestrator {
    if (!CashGameOrchestrator.instance) {
      CashGameOrchestrator.instance = new CashGameOrchestrator();
    }
    return CashGameOrchestrator.instance;
  }

  /**
   * Start the global orchestrator
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    // 1. Initial spin up of all existing active tables
    await this.syncActiveTables();

    // 2. Set up Supabase Realtime subscription on tables (replaces 30s polling)
    try {
      this.realtimeChannel = supabase
        .channel('cash-game-orchestrator-tables')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tables',
            filter: 'tournament_id=is.null',
          },

          (payload: any) => {
            // React to table changes in real-time
            const { eventType, new: newRow, old: oldRow } = payload;
            if (eventType === 'INSERT' || eventType === 'UPDATE') {
              const tableId = newRow?.id;
              const status = newRow?.status;
              const isDeleted = newRow?.is_deleted;
              if (
                tableId &&
                status !== 'closed' &&
                !isDeleted &&
                !this.activeEngines.has(tableId)
              ) {
                const engine = new HeadlessTableEngine(tableId, supabase);
                this.activeEngines.set(tableId, engine);
                engine.start().catch((err) => {
                  console.error(
                    `[CashGameOrchestrator] Engine failed to start for ${tableId}:`,
                    err
                  );
                  this.activeEngines.delete(tableId);
                });
              } else if (
                tableId &&
                (status === 'closed' || isDeleted) &&
                this.activeEngines.has(tableId)
              ) {
                const engine = this.activeEngines.get(tableId)!;
                engine
                  .stop()
                  .catch((e) =>
                    console.warn(
                      `[CashGameOrchestrator] Failed to stop closed table engine ${tableId}:`,
                      e
                    )
                  );
                this.activeEngines.delete(tableId);
              }
            } else if (eventType === 'DELETE') {
              const tableId = oldRow?.id;
              if (tableId && this.activeEngines.has(tableId)) {
                const engine = this.activeEngines.get(tableId)!;
                engine
                  .stop()
                  .catch((e) =>
                    console.warn(
                      `[CashGameOrchestrator] Failed to stop deleted table engine ${tableId}:`,
                      e
                    )
                  );
                this.activeEngines.delete(tableId);
              }
            }
          }
        )
        .subscribe();
    } catch (err: unknown) {
      console.error(
        '[CashGameOrchestrator] Realtime subscription failed, relying on polling:',
        err
      );
    }

    // 3. Keep 60s polling as fallback (resilience against Realtime drops)
    this.pollInterval = setInterval(() => {
      this.syncActiveTables();
    }, 60_000);

    // 4. Start Hydra Fleet management
    this.hydraInterval = setInterval(() => {
      this.manageLiquidity();
    }, 45_000);
  }

  /**
   * Stop the orchestrator and all engines gracefully
   */
  async stop() {
    this.isRunning = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    if (this.hydraInterval) clearInterval(this.hydraInterval);

    // Unsubscribe from Realtime channel
    if (this.realtimeChannel) {
      supabase.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
    for (const [tableId, engine] of this.activeEngines.entries()) {
      await engine.stop();
      this.activeEngines.delete(tableId);
    }
  }

  /**
   * Check stats
   */
  getStats() {
    return {
      running: this.isRunning,
      activeTables: this.activeEngines.size,
      totalHandsDealt: Array.from(this.activeEngines.values()).reduce(
        (acc, e) => acc + e.getHandCount(),
        0
      ),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // PRIVATE METHODS
  // ═══════════════════════════════════════════════════════════════════════════════

  private async syncActiveTables() {
    if (!this.isRunning) return;

    try {
      // Find all active cash tables
      const { data, error } = await supabase
        .from('tables')
        .select('id, status')
        .is('is_deleted', false)
        .neq('status', 'closed')
        .is('tournament_id', null);

      if (error) throw error;

      const currentTableIds = new Set((data || []).map((t) => t.id));

      // 1. Start engines for new tables
      for (const tableId of currentTableIds) {
        if (!this.activeEngines.has(tableId)) {
          const engine = new HeadlessTableEngine(tableId, supabase);
          this.activeEngines.set(tableId, engine);

          // Fire and forget start
          engine.start().catch((err) => {
            console.error(`[CashGameOrchestrator] Engine failed to start for ${tableId}:`, err);
            this.activeEngines.delete(tableId);
          });
        }
      }

      // 2. Stop and remove engines for closed tables
      for (const [tableId, engine] of Array.from(this.activeEngines.entries())) {
        if (!currentTableIds.has(tableId)) {
          await engine.stop();
          this.activeEngines.delete(tableId);
        } else if (!engine.isRunning()) {
          // Engine crashed or stopped internally, restart it
          engine.start().catch((err) => console.error(err));
        }
      }
    } catch (err: unknown) {
      console.error('[CashGameOrchestrator] Error syncing active tables:', err);
    }
  }

  /**
   * Hydra Service: Seed/Recede tables
   */
  private async manageLiquidity() {
    if (!this.isRunning) return;

    for (const tableId of this.activeEngines.keys()) {
      try {
        const status = await HydraService.getTableLiquidityStatus(tableId);

        // 1. Need more horses (3 Horses to Start rule)
        if (status.needsMoreHorses) {
          const { data: tableData } = await supabase
            .from('tables')
            .select('big_blind')
            .eq('id', tableId)
            .maybeSingle();

          if (tableData?.big_blind) {
            await HydraService.seedTable(tableId, tableData.big_blind);
          }
        }

        // 2. Need fewer horses (Organic Recede rule)
        // If real players arrived, schedule a horse to leave
        if (status.needsFewerHorses && status.horsePlayers > 0) {
          const horses = await HydraService.getActiveHorses(tableId);
          const horseToRemove = horses.find((h) => !h.leavingAfterOrbit);

          if (horseToRemove) {
            await HydraService.scheduleHorseRemoval(tableId, horseToRemove.id);
          }
        }
      } catch (err: unknown) {
        console.error(`[CashGameOrchestrator] Error managing liquidity for table ${tableId}:`, err);
      }
    }
  }
}

export const cashGameOrchestrator = CashGameOrchestrator.getInstance();
