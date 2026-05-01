/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HORSE LIFECYCLE MANAGER — Server-Side Status Tracking + Cleanup
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the complete lifecycle of horses on the server:
 * - Tracks status transitions (available → seated → tournament → leaving → available)
 * - Cleans up after tournaments complete (reset horse status)
 * - Detects stuck/orphaned horses and resets them
 * - Cleans up stale table seats and cancelled tournaments
 * - Maintains horse fleet integrity 24/7
 *
 * ZERO browser dependency — this is the SERVER version.
 */

import { supabase, atomicCashout } from './supabase.js';
import { reportError } from './errorReporter.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const MONITORING_INTERVAL = 60000; // 60 seconds between checks
const STUCK_HORSE_THRESHOLD_HOURS = 2; // Consider horse stuck after 2 hours
const STALE_SNG_THRESHOLD_HOURS = 2; // Cancel SNGs older than 2 hours that never started
const STALE_SEAT_THRESHOLD_HOURS = 4; // Cleanup table_seats older than 4 hours

// ═══════════════════════════════════════════════════════════════════════════════
// HORSE LIFECYCLE MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class HorseLifecycleManager {
  private isRunning = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.isRunning) {
      console.log('[Lifecycle] Already running');
      return;
    }

    this.isRunning = true;
    console.log(`[Lifecycle] Starting monitoring (interval: ${MONITORING_INTERVAL}ms)`);

    // Initial check
    this.performMaintenanceCycle();

    // Recurring checks
    this.intervalHandle = setInterval(() => {
      this.performMaintenanceCycle();
    }, MONITORING_INTERVAL);
  }

  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    console.log('[Lifecycle] Stopped');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN MAINTENANCE CYCLE
  // ─────────────────────────────────────────────────────────────────────────

  private async performMaintenanceCycle(): Promise<void> {
    try {
      await Promise.all([
        this.cleanupFinishedTournaments(),
        this.detectStuckHorses(),
        this.cleanupStaleSNGs(),
        this.cleanupStaleSeats(),
      ]);
    } catch (err) {
      reportError(err, 'Lifecycle.Maintenance_cycle_error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TOURNAMENT CLEANUP
  // ─────────────────────────────────────────────────────────────────────────

  private async cleanupFinishedTournaments(): Promise<void> {
    try {
      const { data: tournaments } = await supabase
        .from('tournaments')
        .select('id, name')
        .in('status', ['FINISHED', 'CANCELLED']);

      if (!tournaments || tournaments.length === 0) return;

      let horsesReset = 0;

      for (const tournament of tournaments) {
        try {
          const { data: players } = await supabase
            .from('tournament_players')
            .select('user_id')
            .eq('tournament_id', tournament.id);

          if (!players || players.length === 0) continue;

          const playerIds = players.map((p) => p.user_id);
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id')
            .in('id', playerIds)
            .eq('is_horse', true);

          if (!profiles || profiles.length === 0) continue;

          for (const profile of profiles) {
            const reset = await this.evaluateHorseStatus(profile.id);
            if (reset) {
              horsesReset++;
              await this.persistLifecycleLog(profile.id, 'tournament_reset', {
                tournamentId: tournament.id,
                tournamentName: tournament.name,
              });
            }
          }

          // Clean up tournament_players for horses
          await supabase
            .from('tournament_players')
            .delete()
            .eq('tournament_id', tournament.id)
            .in(
              'user_id',
              profiles.map((p) => p.id)
            );
        } catch (err) {
          reportError(err, 'Lifecycle.Error_processing_tournament_to');
        }
      }

      if (horsesReset > 0) {
        console.log(
          `[Lifecycle] Reset ${horsesReset} horses from ${tournaments.length} finished tournaments`
        );
      }
    } catch (err) {
      reportError(err, 'Lifecycle.cleanupFinishedTournaments_err');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STUCK HORSE DETECTION
  // ─────────────────────────────────────────────────────────────────────────

  private async detectStuckHorses(): Promise<void> {
    try {
      const thresholdTime = new Date(
        Date.now() - STUCK_HORSE_THRESHOLD_HOURS * 60 * 60 * 1000
      ).toISOString();

      const { data: stuckHorses } = await supabase
        .from('profiles')
        .select('id, display_name, horse_status, updated_at')
        .eq('is_horse', true)
        .neq('horse_status', 'available')
        .lt('updated_at', thresholdTime);

      if (!stuckHorses || stuckHorses.length === 0) return;

      let forcedResets = 0;

      for (const horse of stuckHorses) {
        try {
          // Check if horse has active seat
          const { data: activeSeats } = await supabase
            .from('table_seats')
            .select('table_id')
            .eq('user_id', horse.id)
            .is('left_at', null)
            .limit(1);

          if (activeSeats && activeSeats.length > 0) continue; // Still has active seat

          // Check if in active tournament
          const { data: activeTournaments } = await supabase
            .from('tournament_players')
            .select('tournament_id')
            .eq('user_id', horse.id)
            .eq('status', 'in_progress')
            .limit(1);

          if (activeTournaments && activeTournaments.length > 0) continue; // Still in tournament

          // Calculate how long stuck
          const stuckSinceMs = Date.now() - new Date(horse.updated_at).getTime();
          const stuckSinceHours = stuckSinceMs / (60 * 60 * 1000);

          // Force reset
          const reset = await this.forceResetHorse(horse.id);
          if (reset) {
            forcedResets++;
            await this.persistLifecycleLog(horse.id, 'stuck_horse_reset', {
              previousStatus: horse.horse_status,
              stuckSinceHours: Math.round(stuckSinceHours * 10) / 10,
              lastUpdated: horse.updated_at,
            });
          }
        } catch {
          // Skip individual horse errors
        }
      }

      if (forcedResets > 0) {
        console.log(`[Lifecycle] Force-reset ${forcedResets} stuck horses`);
      }
    } catch (err) {
      reportError(err, 'Lifecycle.detectStuckHorses_error');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // LOGGING & PERSISTENCE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Phase J: lifecycle event logging changed from horse_bug_reports DB insert
   * to console.log only. Pre-fix, every horse rebuy / leave / profit-target
   * cashout fired a row to horse_bug_reports with category='lifecycle_event'
   * and severity='low'. Result: 61,627 happy-path rows polluted what is
   * supposed to be a bug-report queue. Real bug categories (wallet_sync,
   * runtime_error, state_desync) drowned in lifecycle noise.
   *
   * Lifecycle events are still emitted as console.log for runtime tail
   * visibility + Sentry breadcrumbs (Sentry ingests stdout in production).
   * Real bugs continue to write to horse_bug_reports via separate paths.
   */
  private async persistLifecycleLog(
    horseId: string,
    event: string,
    details: Record<string, unknown>
  ): Promise<void> {
    console.log(
      `[HorseLifecycle] horse=${horseId.slice(0, 8)} event=${event} ` +
        JSON.stringify(details)
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HORSE RESET
  // ─────────────────────────────────────────────────────────────────────────

  async evaluateHorseStatus(horseId: string): Promise<boolean> {
    try {
      // Check if horse has ANY active seats
      const { data: activeSeats } = await supabase
        .from('table_seats')
        .select('id')
        .eq('user_id', horseId)
        .is('left_at', null)
        .limit(1);

      // Check if in ANY active tournament
      const { data: activeTournaments } = await supabase
        .from('tournament_players')
        .select('id')
        .eq('user_id', horseId)
        .in('status', ['registered', 'in_progress'])
        .limit(1);

      const hasActiveGames =
        (activeSeats && activeSeats.length > 0) ||
        (activeTournaments && activeTournaments.length > 0);

      if (!hasActiveGames) {
        // Only reset if they have NO active games at all
        const { error } = await supabase
          .from('profiles')
          .update({ horse_status: 'available', updated_at: new Date().toISOString() })
          .eq('id', horseId);

        if (error) {
          reportError(error, 'Lifecycle.Failed_to_reset_horse_horseId');
          return false;
        }
        await this.persistLifecycleLog(horseId, 'natural_reset', {
          reason: 'tournament_completed_no_active_games',
        });
        return true; // Horse was reset to available
      }
      return false; // Horse remains seated/active
    } catch {
      return false;
    }
  }

  // FORCE RESET function for genuinely stuck horses (used by detectStuckHorses)
  async forceResetHorse(horseId: string): Promise<boolean> {
    try {
      // Get all active seats for this horse WITH their stacks
      const { data: activeSeats } = await supabase
        .from('table_seats')
        .select('table_id, seat_number, stack')
        .eq('user_id', horseId)
        .is('left_at', null);

      // FIX 208: Cash out each seat using direct queries (avoids PostgREST RPC cache issues)
      if (activeSeats && activeSeats.length > 0) {
        for (const seat of activeSeats) {
          await atomicCashout(horseId, seat.table_id, seat.seat_number);
        }
      }

      // Reset profile status
      const { error } = await supabase
        .from('profiles')
        .update({ horse_status: 'available', updated_at: new Date().toISOString() })
        .eq('id', horseId);

      if (!error) {
        await this.persistLifecycleLog(horseId, 'force_reset_stuck_horse', {
          seatsForceCleared: activeSeats?.length || 0,
          chipStack: activeSeats?.reduce((sum: number, s: any) => sum + (s.stack || 0), 0) || 0,
        });
      }

      return !error;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STALE SNG CLEANUP
  // ─────────────────────────────────────────────────────────────────────────

  private async cleanupStaleSNGs(): Promise<void> {
    try {
      const thresholdTime = new Date(
        Date.now() - STALE_SNG_THRESHOLD_HOURS * 60 * 60 * 1000
      ).toISOString();

      const { data: staleSNGs } = await supabase
        .from('tournaments')
        .select('id, name, buy_in_amount')
        .eq('variant', 'sng')
        .neq('status', 'RUNNING')
        .neq('status', 'FINISHED')
        .neq('status', 'CANCELLED')
        .lt('created_at', thresholdTime);

      if (!staleSNGs || staleSNGs.length === 0) return;

      let cancelled = 0;

      for (const sng of staleSNGs) {
        try {
          const buyInAmount = sng.buy_in_amount || 0;

          // Get registered players for refund
          const { data: players } = await supabase
            .from('tournament_players')
            .select('user_id')
            .eq('tournament_id', sng.id);

          if (players && players.length > 0 && buyInAmount > 0) {
            for (const player of players) {
              const { error: refundErr } = await supabase.rpc('credit_player_wallet', {
                p_user_id: player.user_id,
                p_amount: buyInAmount,
              });
              if (refundErr)
                reportError(new Error(`[HorseLifecycle] SNG cancel refund FAILED for ${player.user_id.slice(0, 8)}: ${refundErr.message}`), 'HorseLifecycle.SNG_cancel_refund_FAILED_for_p');
            }
          }

          await supabase
            .from('tournaments')
            .update({ status: 'CANCELLED', updated_at: new Date().toISOString() })
            .eq('id', sng.id);

          cancelled++;
          await this.persistLifecycleLog('system', 'stale_sng_cancelled', {
            sngId: sng.id,
            sngName: sng.name,
            refundsIssued: players?.length || 0,
            refundAmount: buyInAmount,
          });
        } catch {
          // Skip individual errors
        }
      }

      if (cancelled > 0) {
        console.log(`[Lifecycle] Cancelled ${cancelled} stale SNGs`);
      }
    } catch {
      // Non-critical
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STALE SEAT CLEANUP
  // ─────────────────────────────────────────────────────────────────────────

  private async cleanupStaleSeats(): Promise<void> {
    try {
      const thresholdTime = new Date(
        Date.now() - STALE_SEAT_THRESHOLD_HOURS * 60 * 60 * 1000
      ).toISOString();

      const { data: staleSeats } = await supabase
        .from('table_seats')
        .select('id, table_id, user_id, seat_number, stack, joined_at')
        .is('left_at', null)
        .lt('joined_at', thresholdTime);

      if (!staleSeats || staleSeats.length === 0) return;

      let cleaned = 0;
      for (const seat of staleSeats) {
        try {
          // FIX 208: Use direct atomicCashout instead of RPC
          await atomicCashout(seat.user_id, seat.table_id, seat.seat_number);
          cleaned++;

          // If horse, reset to available
          const { data: profile } = await supabase
            .from('profiles')
            .select('is_horse')
            .eq('id', seat.user_id)
            .maybeSingle(); // FIX 168

          if (profile?.is_horse) {
            await this.evaluateHorseStatus(seat.user_id);
            await this.persistLifecycleLog(seat.user_id, 'stale_seat_cleanup', {
              tableId: seat.table_id,
              seatNumber: seat.seat_number,
              stackCleared: seat.stack,
              joinedAt: seat.joined_at,
            });
          }
        } catch {
          // Skip individual errors
        }
      }

      if (cleaned > 0) {
        console.log(`[Lifecycle] Cleaned up ${cleaned} stale table seats (with atomic cashout)`);
      }
    } catch {
      // Non-critical
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TOURNAMENT WINNINGS / ELIMINATION PROCESSING
  // ─────────────────────────────────────────────────────────────────────────

  async processWinnings(horseId: string, amount: number, tournamentId: string): Promise<boolean> {
    try {
      const { error } = await supabase.rpc('credit_player_wallet', {
        p_user_id: horseId,
        p_amount: amount,
      });

      if (error) {
        reportError(error, 'Lifecycle.Failed_to_credit_winnings_to_h');
        return false;
      }

      const { error: txErr } = await supabase.from('wallet_transactions').insert({
        user_id: horseId,
        wallet_type: 'PLAYER',
        amount,
        type: 'credit',
        category: 'tournament_winnings',
        description: `Tournament winnings: ${amount} credits`,
      });
      if (txErr)
        console.warn(
          `[Lifecycle] Winnings tx log failed for horse ${horseId.slice(0, 8)}: ${txErr.message}`
        );

      return true;
    } catch {
      return false;
    }
  }

  async processElimination(horseId: string, tournamentId: string): Promise<boolean> {
    try {
      await supabase
        .from('tournament_players')
        .update({ status: 'eliminated', updated_at: new Date().toISOString() })
        .eq('user_id', horseId)
        .eq('tournament_id', tournamentId);

      return await this.evaluateHorseStatus(horseId);
    } catch {
      return false;
    }
  }
}
