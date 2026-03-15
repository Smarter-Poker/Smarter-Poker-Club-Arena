/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE LIFECYCLE MANAGER — Status Tracking + Tournament Cleanup
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the complete lifecycle of horses:
 * - Tracks status transitions (available → seated → tournament → leaving → available)
 * - Cleans up after tournaments complete (reset horse status)
 * - Detects stuck/orphaned horses and resets them
 * - Provides health dashboard data
 * - Maintains horse fleet integrity
 */

import { supabase } from '../lib/supabase';
import { horseBugReporter } from './HorseBugReporter';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface FleetHealth {
  total: number;
  available: number;
  seated: number;
  inTournament: number;
  leaving: number;
  stuck: number;
  busted: number;
}

export interface LifecycleConfig {
  monitoringInterval: number; // ms between checks (default: 60000)
  stuckHorseThreshold: number; // hours - consider horse stuck if in non-available state > this (default: 2)
  staleSngThreshold: number; // hours - cancel SNGs older than this that never started (default: 2)
  staleSeatThreshold: number; // hours - cleanup table_seats older than this (default: 4)
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class HorseLifecycleManagerCore {
  private isRunning = false;
  private monitoringInterval: number;
  private stuckHorseThreshold: number;
  private staleSngThreshold: number;
  private staleSeatThreshold: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<LifecycleConfig> = {}) {
    this.monitoringInterval = config.monitoringInterval ?? 60000;
    this.stuckHorseThreshold = config.stuckHorseThreshold ?? 2;
    this.staleSngThreshold = config.staleSngThreshold ?? 2;
    this.staleSeatThreshold = config.staleSeatThreshold ?? 4;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Start lifecycle monitoring
   */
  start(): void {
    if (this.isRunning) {
      console.error('[LifecycleManager] Already running');
      return;
    }

    this.isRunning = true;
    console.debug(
      '[LifecycleManager] Starting monitoring (interval: ' + this.monitoringInterval + 'ms)'
    );

    // Initial check
    this.performMaintenanceCycle();

    // Recurring checks
    this.intervalHandle = setInterval(() => {
      this.performMaintenanceCycle();
    }, this.monitoringInterval);
  }

  /**
   * Stop lifecycle monitoring
   */
  stop(): void {
    if (!this.isRunning) {
      console.error('[LifecycleManager] Not running');
      return;
    }

    this.isRunning = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    console.debug('[LifecycleManager] Stopped monitoring');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // MAIN MAINTENANCE CYCLE
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run full maintenance cycle
   */
  private async performMaintenanceCycle(): Promise<void> {
    try {
      console.debug('[LifecycleManager] Starting maintenance cycle');

      // Run all cleanup tasks in parallel
      await Promise.all([
        this.cleanupFinishedTournaments(),
        this.detectStuckHorses(),
        this.cleanupStaleSNGs(),
        this.cleanupStaleSeats(),
      ]);

      console.debug('[LifecycleManager] Maintenance cycle completed');
    } catch (err: unknown) {
      console.error('[LifecycleManager] Fatal error in maintenance cycle:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TOURNAMENT CLEANUP
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Clean up horses from finished tournaments
   */
  async cleanupFinishedTournaments(): Promise<void> {
    try {
      // Find all finished tournaments
      const { data: tournaments, error: tourError } = await supabase
        .from('tournaments')
        .select('id, name')
        .in('status', ['FINISHED', 'CANCELLED']);

      if (tourError) {
        console.error('[LifecycleManager] Failed to fetch finished tournaments:', tourError);
        return;
      }

      if (!tournaments || tournaments.length === 0) {
        return;
      }

      let horsesReset = 0;

      // Process each tournament
      for (const tournament of tournaments) {
        try {
          // Get all horses registered in this tournament
          const { data: players, error: playerError } = await supabase
            .from('tournament_players')
            .select('user_id')
            .eq('tournament_id', tournament.id);

          if (playerError) {
            console.error(
              '[LifecycleManager] Failed to fetch tournament players for ' + tournament.id + ':',
              playerError
            );
            continue;
          }

          if (!players || players.length === 0) {
            continue;
          }

          // Filter for horses only
          const playerIds = players.map((p) => p.user_id);
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id')
            .in('id', playerIds)
            .eq('is_horse', true);

          if (!profiles || profiles.length === 0) {
            continue;
          }

          // Reset each horse to available
          for (const profile of profiles) {
            const reset = await this.resetHorse(profile.id);
            if (reset) {
              horsesReset++;
            }
          }

          // Delete stale tournament_players entries for these horses
          await supabase
            .from('tournament_players')
            .delete()
            .eq('tournament_id', tournament.id)
            .in(
              'user_id',
              profiles.map((p) => p.id)
            );
        } catch (err: unknown) {
          console.error(
            '[LifecycleManager] Error processing tournament ' + tournament.id + ':',
            err
          );
        }
      }

      if (horsesReset > 0) {
        horseBugReporter.report({
          horseName: 'LifecycleManager',
          horseId: 'system',
          tableId: 'system',
          tableName: 'System',
          handNumber: 0,
          category: 'tournament_bug',
          severity: 'info',
          title: 'Tournament cleanup completed',
          description:
            'Reset ' + horsesReset + ' horses from ' + tournaments.length + ' finished tournaments',
          context: { tournamentCount: tournaments.length, horsesReset },
        });

        console.debug(
          '[LifecycleManager] Reset ' + horsesReset + ' horses from finished tournaments'
        );
      }
    } catch (err: unknown) {
      console.error('[LifecycleManager] Error in cleanupFinishedTournaments:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STUCK HORSE DETECTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Detect and reset horses stuck in non-available state
   */
  async detectStuckHorses(): Promise<void> {
    try {
      const thresholdMs = this.stuckHorseThreshold * 60 * 60 * 1000;
      const thresholdTime = new Date(Date.now() - thresholdMs).toISOString();

      // Find horses stuck in 'leaving' or 'seated' status for too long
      const { data: stuckHorses, error: stuckError } = await supabase
        .from('profiles')
        .select('id, display_name, horse_status, updated_at')
        .eq('is_horse', true)
        .neq('horse_status', 'available')
        .lt('updated_at', thresholdTime);

      if (stuckError) {
        console.error('[LifecycleManager] Failed to fetch stuck horses:', stuckError);
        return;
      }

      if (!stuckHorses || stuckHorses.length === 0) {
        return;
      }

      let forcedResets = 0;

      // Check each stuck horse for active table seats or tournaments
      for (const horse of stuckHorses) {
        try {
          // Check if horse still has active table seat (table_seats uses joined_at, not created_at)
          const { data: activeSeat } = await supabase
            .from('table_seats')
            .select('table_id')
            .eq('user_id', horse.id)
            .is('left_at', null)
            .maybeSingle();

          if (activeSeat) {
            // Has active seat — don't force reset
            continue;
          }

          // Check if horse is in active tournament (use maybeSingle — horse could be in 0 or 1+)
          const { data: activeTournament } = await supabase
            .from('tournament_players')
            .select('tournament_id')
            .eq('user_id', horse.id)
            .eq('status', 'in_progress')
            .limit(1)
            .maybeSingle();

          if (activeTournament) {
            // In active tournament - don't force reset
            continue;
          }

          // No active seat or tournament - force reset
          const reset = await this.resetHorse(horse.id);
          if (reset) {
            forcedResets++;

            horseBugReporter.report({
              horseName: horse.display_name || 'Horse',
              horseId: horse.id,
              tableId: 'system',
              tableName: 'System',
              handNumber: 0,
              category: 'state_desync',
              severity: 'low',
              title: 'Stuck horse force-reset',
              description:
                'Horse was stuck in ' +
                horse.horse_status +
                ' state for ' +
                this.stuckHorseThreshold +
                ' hours. Force-reset to available.',
              context: {
                horseId: horse.id,
                previousStatus: horse.horse_status,
                updatedAt: horse.updated_at,
              },
            });
          }
        } catch (err: unknown) {
          console.error('[LifecycleManager] Error processing stuck horse ' + horse.id + ':', err);
        }
      }

      if (forcedResets > 0) {
        console.debug('[LifecycleManager] Force-reset ' + forcedResets + ' stuck horses');
      }
    } catch (err: unknown) {
      console.error('[LifecycleManager] Error in detectStuckHorses:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HORSE RESET
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Force reset a horse to available status
   */
  async resetHorse(horseId: string): Promise<boolean> {
    try {
      // Step 1: Find which tables this horse is currently seated at
      const { data: activeSeats } = await supabase
        .from('table_seats')
        .select('table_id')
        .eq('user_id', horseId)
        .is('left_at', null);

      const affectedTableIds = new Set(activeSeats?.map((s) => s.table_id) || []);

      // Step 2: Clear any stale seat records
      await supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('user_id', horseId)
        .is('left_at', null);

      // Step 3: Update profile status to available
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ horse_status: 'available', updated_at: new Date().toISOString() })
        .eq('id', horseId);

      if (updateError) {
        console.error('[LifecycleManager] Failed to reset horse ' + horseId + ':', updateError);
        return false;
      }

      // Step 4: Recount current_players for each affected table
      for (const tableId of affectedTableIds) {
        try {
          const { count, error: countErr } = await supabase
            .from('table_seats')
            .select('*', { count: 'exact', head: true })
            .eq('table_id', tableId)
            .is('left_at', null);

          if (!countErr) {
            await supabase
              .from('tables')
              .update({ current_players: count ?? 0 })
              .eq('id', tableId);
          }
        } catch (err) {

          console.error("[HorseLifecycleManager] Error:", err);
          /* non-critical */
        }
      }

      console.debug('[LifecycleManager] Reset horse ' + horseId + ' to available');
      return true;
    } catch (err: unknown) {
      console.error('[LifecycleManager] Error in resetHorse:', err);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WINNINGS & ELIMINATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Process tournament winnings for a horse
   */
  async processWinnings(horseId: string, amount: number, tournamentId: string): Promise<boolean> {
    try {
      // Credit wallet and log ATOMICALLY via RPC
      const { error: creditError } = await retryAsync(
        () =>
          supabase.rpc('atomic_credit_wallet_and_log', {
            p_user_id: horseId,
            p_amount: amount,
            p_category: 'prize',
            p_description: 'Tournament winnings: ' + amount + ' credits',
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: tournamentId,
          }),
        3
      );

      if (creditError) {
        console.error(
          '[LifecycleManager] Failed to atomically credit winnings to horse ' + horseId + ':',
          creditError
        );
        horseBugReporter.report({
          horseName: 'LifecycleManager',
          horseId,
          tableId: 'tournament',
          tableName: 'Tournament',
          handNumber: 0,
          category: 'wallet_sync',
          severity: 'high',
          title: 'Tournament winnings credit failed',
          description: 'Could not credit ' + amount + ' tournament winnings to horse wallet',
          context: { horseId, amount, tournamentId },
        });
        return false;
      }
      masterBus.emit('BALANCE_UPDATED', { source: 'horse_tournament_winnings', userId: horseId });

      console.debug(
        '[LifecycleManager] Credited ' + amount + ' tournament winnings to horse ' + horseId
      );
      return true;
    } catch (err: unknown) {
      console.error('[LifecycleManager] Error in processWinnings:', err);
      return false;
    }
  }

  /**
   * Process horse elimination from tournament
   */
  async processElimination(horseId: string, tournamentId: string): Promise<boolean> {
    try {
      // Update tournament_players status
      const { error: elimError } = await supabase
        .from('tournament_players')
        .update({ status: 'eliminated', updated_at: new Date().toISOString() })
        .eq('user_id', horseId)
        .eq('tournament_id', tournamentId);

      if (elimError) {
        console.error('[LifecycleManager] Failed to mark horse as eliminated:', elimError);
        return false;
      }

      // Reset horse to available
      const reset = await this.resetHorse(horseId);

      horseBugReporter.report({
        horseName: 'LifecycleManager',
        horseId,
        tableId: 'tournament',
        tableName: 'Tournament',
        handNumber: 0,
        category: 'tournament_bug',
        severity: 'info',
        title: 'Horse eliminated from tournament',
        description: 'Horse marked as eliminated and reset to available',
        context: { horseId, tournamentId },
      });

      console.debug('[LifecycleManager] Processed elimination for horse ' + horseId);
      return reset;
    } catch (err: unknown) {
      console.error('[LifecycleManager] Error in processElimination:', err);
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // STALE DATA CLEANUP
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Clean up stale SNGs that never started
   */
  async cleanupStaleSNGs(): Promise<void> {
    try {
      const thresholdMs = this.staleSngThreshold * 60 * 60 * 1000;
      const thresholdTime = new Date(Date.now() - thresholdMs).toISOString();

      // Find SNGs older than threshold that never started
      const { data: staleSNGs, error: sngError } = await supabase
        .from('tournaments')
        .select('id, name, created_at')
        .eq('variant', 'sng')
        .neq('status', 'RUNNING')
        .neq('status', 'FINISHED')
        .neq('status', 'CANCELLED')
        .lt('created_at', thresholdTime);

      if (sngError) {
        console.error('[LifecycleManager] Failed to fetch stale SNGs:', sngError);
        return;
      }

      if (!staleSNGs || staleSNGs.length === 0) {
        return;
      }

      let cancelled = 0;

      // Cancel and refund each stale SNG
      for (const sng of staleSNGs) {
        try {
          // Get tournament buy-in amount
          const { data: tournamentData } = await supabase
            .from('tournaments')
            .select('buy_in_amount')
            .eq('id', sng.id)
            .maybeSingle();

          // Get all registered players
          const { data: players } = await supabase
            .from('tournament_players')
            .select('user_id')
            .eq('tournament_id', sng.id);

          const buyInAmount = tournamentData?.buy_in_amount || 0;

          if (players && players.length > 0) {
            // Refund each player
            for (const player of players) {
              if (buyInAmount > 0) {
                const { error: refundErr } = await retryAsync(
                  () =>
                    supabase.rpc('atomic_credit_wallet_and_log', {
                      p_user_id: player.user_id,
                      p_amount: buyInAmount,
                      p_category: 'refund',
                      p_description: 'SNG cancelled refund: ' + buyInAmount + ' chips',
                      p_table_id: null,
                      p_hand_id: null,
                      p_related_entity_id: sng.id,
                    }),
                  3
                );
                if (refundErr)
                  console.error(
                    `[HorseLifecycle] SNG cancel atomic refund FAILED for ${player.user_id.slice(0, 8)}: ${refundErr.message}`
                  );
                else
                  masterBus.emit('BALANCE_UPDATED', {
                    source: 'horse_sng_refund',
                    userId: player.user_id,
                  });
              }
            }
          }

          // Update SNG status to CANCELLED
          await supabase
            .from('tournaments')
            .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
            .eq('id', sng.id);

          cancelled++;

          console.debug('[LifecycleManager] Cancelled stale SNG ' + sng.name);
        } catch (err: unknown) {
          console.error('[LifecycleManager] Error cancelling SNG ' + sng.id + ':', err);
        }
      }

      if (cancelled > 0) {
        horseBugReporter.report({
          horseName: 'LifecycleManager',
          horseId: 'system',
          tableId: 'system',
          tableName: 'System',
          handNumber: 0,
          category: 'tournament_bug',
          severity: 'info',
          title: 'Stale SNGs cancelled',
          description:
            'Cancelled ' +
            cancelled +
            ' SNGs that never started and were older than ' +
            this.staleSngThreshold +
            ' hours',
          context: { cancelledCount: cancelled },
        });

        console.debug('[LifecycleManager] Cancelled ' + cancelled + ' stale SNGs');
      }
    } catch (err: unknown) {
      console.error('[LifecycleManager] Error in cleanupStaleSNGs:', err);
    }
  }

  /**
   * Clean up stale table_seats records
   * NOTE: table_seats is managed in-memory by HeadlessTableEngine, no DB table exists
   */
  async cleanupStaleSeats(): Promise<void> {
    try {
      const thresholdMs = this.staleSeatThreshold * 60 * 60 * 1000;
      const thresholdTime = new Date(Date.now() - thresholdMs).toISOString();

      // Find stale seats — still active (left_at is null) but joined long ago
      // Column is 'joined_at' (not 'created_at')
      const { data: staleSeats, error: seatError } = await supabase
        .from('table_seats')
        .select('id, table_id, user_id, joined_at')
        .is('left_at', null)
        .lt('joined_at', thresholdTime);

      if (seatError || !staleSeats || staleSeats.length === 0) return;

      // Track affected table IDs for recount
      const affectedTableIds = new Set<string>();
      let cleaned = 0;
      for (const seat of staleSeats) {
        try {
          await supabase
            .from('table_seats')
            .update({ left_at: new Date().toISOString(), status: 'left' })
            .eq('id', seat.id);
          cleaned++;
          affectedTableIds.add(seat.table_id);

          // If user is a horse, reset to available
          const { data: profile } = await supabase
            .from('profiles')
            .select('is_horse')
            .eq('id', seat.user_id)
            .maybeSingle();
          if (profile?.is_horse) {
            await this.resetHorse(seat.user_id);
          }
        } catch (err) {

          console.error("[HorseLifecycleManager] Error:", err);
          /* skip individual errors */
        }
      }

      // Recount current_players for each affected table (prevents ghost player counts)
      for (const tableId of affectedTableIds) {
        try {
          const { count, error: countErr } = await supabase
            .from('table_seats')
            .select('*', { count: 'exact', head: true })
            .eq('table_id', tableId)
            .is('left_at', null);

          if (!countErr) {
            await supabase
              .from('tables')
              .update({ current_players: count ?? 0 })
              .eq('id', tableId);
          }
        } catch (err) {

          console.error("[HorseLifecycleManager] Error:", err);
          /* non-critical */
        }
      }

      if (cleaned > 0) {
        console.debug('[LifecycleManager] Cleaned up ' + cleaned + ' stale table seats');
      }
    } catch (err) {

      console.error("[HorseLifecycleManager] Error:", err);
      /* non-critical cleanup */
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FLEET HEALTH MONITORING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get fleet health statistics
   */
  async getFleetHealth(): Promise<FleetHealth> {
    try {
      // Get all horses with their statuses
      const { data: horses, error: horseError } = await supabase
        .from('profiles')
        .select('id, horse_status, updated_at')
        .eq('is_horse', true);

      if (horseError) {
        console.error('[LifecycleManager] Failed to fetch fleet health:', horseError);
        return {
          total: 0,
          available: 0,
          seated: 0,
          inTournament: 0,
          leaving: 0,
          stuck: 0,
          busted: 0,
        };
      }

      if (!horses || horses.length === 0) {
        return {
          total: 0,
          available: 0,
          seated: 0,
          inTournament: 0,
          leaving: 0,
          stuck: 0,
          busted: 0,
        };
      }

      const thresholdMs = this.stuckHorseThreshold * 60 * 60 * 1000;
      const thresholdTime = new Date(Date.now() - thresholdMs);

      // Batch query for tournament registrations
      const horseIds = horses.map((h) => h.id);
      const { data: tournamentRegs } = await supabase
        .from('tournament_players')
        .select('user_id')
        .in('user_id', horseIds)
        .eq('status', 'in_progress');

      const horsesInTournament = new Set(tournamentRegs?.map((r) => r.user_id) || []);

      let available = 0;
      let seated = 0;
      let leaving = 0;
      let stuck = 0;
      let inTournament = 0;
      let busted = 0;

      for (const horse of horses) {
        if (horse.horse_status === 'available') {
          available++;
        } else if (horse.horse_status === 'seated') {
          seated++;
        } else if (horse.horse_status === 'leaving') {
          leaving++;
        } else if (horse.horse_status === 'disabled') {
          busted++;
        }

        // Check if stuck (non-available for too long)
        if (horse.horse_status !== 'available' && new Date(horse.updated_at) < thresholdTime) {
          stuck++;
        }

        // Check if in tournament (using batched results)
        if (horsesInTournament.has(horse.id)) {
          inTournament++;
        }
      }

      return {
        total: horses.length,
        available,
        seated,
        inTournament,
        leaving,
        stuck,
        busted,
      };
    } catch (err: unknown) {
      console.error('[LifecycleManager] Error in getFleetHealth:', err);
      return {
        total: 0,
        available: 0,
        seated: 0,
        inTournament: 0,
        leaving: 0,
        stuck: 0,
        busted: 0,
      };
    }
  }

  /**
   * Get status information
   */
  getStatus(): {
    isRunning: boolean;
    config: {
      monitoringInterval: number;
      stuckHorseThreshold: number;
      staleSngThreshold: number;
      staleSeatThreshold: number;
    };
  } {
    return {
      isRunning: this.isRunning,
      config: {
        monitoringInterval: this.monitoringInterval,
        stuckHorseThreshold: this.stuckHorseThreshold,
        staleSngThreshold: this.staleSngThreshold,
        staleSeatThreshold: this.staleSeatThreshold,
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export const HorseLifecycleManager = new HorseLifecycleManagerCore();

export default HorseLifecycleManager;
