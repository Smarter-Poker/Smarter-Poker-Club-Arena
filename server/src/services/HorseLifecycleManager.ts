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
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { fetchAllRows } from './supabase/pagination.js';
import { reportError } from './errorReporter.js';
import { selectInChunks } from './supabase/chunkedIn.js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const MONITORING_INTERVAL = 60000; // 60 seconds between checks
const STUCK_HORSE_THRESHOLD_HOURS = 2; // Consider horse stuck after 2 hours
const STALE_SNG_THRESHOLD_HOURS = 2; // Cancel SNGs older than 2 hours that never started
const STALE_SEAT_THRESHOLD_HOURS = 4; // Cleanup table_seats older than 4 hours
// SWEEP #4: a table that has not produced a hand in this many minutes is treated as
// dead/abandoned; only then may a >4h seat be force-cashed. Guards against reaping
// active cash players and against converting live tournament chips to wallet chips.
const STALE_SEAT_TABLE_IDLE_MINUTES = 30;

// ═══════════════════════════════════════════════════════════════════════════════
// HORSE LIFECYCLE MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class HorseLifecycleManager {
  private isRunning = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  /** Prevents overlapping maintenance cycles when the DB is slow. */
  private cycleRunning: boolean = false;
  /**
   * Clearing an interval does not join a callback which already crossed the
   * timer boundary. Lifecycle passes cash seats out and rewrite horse state,
   * so the old leader must retain ownership until every admitted pass (and any
   * continuation it creates) has settled.
   */
  private readonly lifecycleJobs = new Set<Promise<unknown>>();
  private lifecycleGeneration = 0;
  private stopOperation: Promise<void> | null = null;

  // ─────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────

  private lifecycleIsCurrent(generation: number): boolean {
    return this.isRunning && this.lifecycleGeneration === generation;
  }

  private trackLifecycleJob<T>(job: Promise<T>): Promise<T> {
    const tracked = job.finally(() => this.lifecycleJobs.delete(tracked));
    this.lifecycleJobs.add(tracked);
    return tracked;
  }

  private launchMaintenanceCycle(generation: number): void {
    if (!this.lifecycleIsCurrent(generation) || this.cycleRunning) return;
    this.cycleRunning = true;
    const cycle = this.performMaintenanceCycle().finally(() => {
      this.cycleRunning = false;
    });
    void this.trackLifecycleJob(cycle).catch((error) =>
      reportError(error, 'Lifecycle.detached_maintenance_cycle')
    );
  }

  private async drainLifecycleJobs(): Promise<void> {
    // A finishing pass may register child work before its finalizer runs. A
    // single Promise.all snapshot can miss that child, so drain to a fixed
    // point before allowing leadership to move elsewhere.
    while (this.lifecycleJobs.size > 0) {
      await Promise.allSettled([...this.lifecycleJobs]);
    }
  }

  start(): void {
    if (this.stopOperation) {
      console.warn('[Lifecycle] Start refused while the prior generation is stopping');
      return;
    }
    if (this.isRunning) {
      console.log('[Lifecycle] Already running');
      return;
    }

    this.isRunning = true;
    const generation = ++this.lifecycleGeneration;
    console.log(`[Lifecycle] Starting monitoring (interval: ${MONITORING_INTERVAL}ms)`);

    /* Initial check - BEHIND THE SAME FREEZE GATE as the recurring one
       (2026-09-09). The engine boots inside the :55 break more often than
       not (the deploy cuts over during it), and this first pass stands
       horses up and reaps seats: exactly what "EVERYTHING JUST FREEZES,
       THEN PICKS BACK UP EXACTLY AS IT WAS" forbids. The interval below has
       carried the gate since 2026-09-01; the boot call never did. */
    if (!isMaintenanceFrozen()) this.launchMaintenanceCycle(generation);

    // Recurring checks
    // 2026-08-15: async setInterval callbacks with no overlap guard stack up
    // under DB slowness — each cycle issues hundreds of queries, which slows
    // the DB further. Classic amplification, and it fires precisely during a
    // freeze event. (This module's own comment at the double-refund fix
    // records the same hazard.)
    this.intervalHandle = setInterval(() => {
      // THE FREEZE (Dan 2026-09-01): the lifecycle pass stands horses up and
      // reaps seats. Nothing it does cannot wait out the break.
      if (isMaintenanceFrozen()) return;
      this.launchMaintenanceCycle(generation);
    }, MONITORING_INTERVAL);
  }

  stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;

    // Synchronous ownership fence: no new callback may be admitted after
    // this point. The asynchronous half only joins work already owned.
    this.isRunning = false;
    this.lifecycleGeneration++;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    const drain = (async () => {
      await this.drainLifecycleJobs();
      console.log('[Lifecycle] Stopped');
    })();
    const trackedStop = drain.finally(() => {
      if (this.stopOperation === trackedStop) this.stopOperation = null;
    });
    this.stopOperation = trackedStop;
    return trackedStop;
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
        .in('status', ['COMPLETED', 'CANCELLED']);

      if (!tournaments || tournaments.length === 0) return;

      let horsesReset = 0;

      for (const tournament of tournaments) {
        try {
          const { data: players } = await supabase
            .from('tournament_players')
            .select('user_id')
            .eq('tournament_id', tournament.id);

          if (!players || players.length === 0) continue;

          /* CHUNKED, AND AN UNREADABLE FIELD IS NOT AN EMPTY ONE (2026-09-03).
             `playerIds` is every registration in a finished event and this
             platform runs 500- and 1,000-seat fields (a 497-entrant freeroll
             is on record), so one `.in()` here goes past the ~675-id ceiling
             PostgREST accepts in a URL and answers HTTP 400. The error was
             discarded and an empty result `continue`d - which is exactly what
             "no horses in this field" looks like, so the lifecycle reset and
             the cleanup below simply stopped happening after big events, and
             tournament_players rows accumulated for good. */
          const profileRead = await selectInChunks<{ id: string }>(
            players.map((p) => p.user_id),
            (batch) => supabase.from('profiles').select('id').in('id', batch).eq('is_horse', true),
            `HorseLifecycle.horsesInField(${String(tournament.id).slice(0, 8)})`
          );
          if (!profileRead.complete) continue; // try again next pass, do not half-clean
          const profiles = profileRead.rows;

          if (profiles.length === 0) continue;

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

          // Tournament rows are settlement provenance. Availability changes
          // on the horse profile; a lifecycle pass never deletes a finish,
          // satellite source, payout place, ticket source or chip history.
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

      const stuckPage = await fetchAllRows<{
        id: string;
        display_name: string | null;
        horse_status: string | null;
        updated_at: string;
      }>(
        (cursor, want) => {
          let q = supabase
            .from('profiles')
            .select('id, display_name, horse_status, updated_at')
            .eq('is_horse', true)
            .neq('horse_status', 'available')
            .lt('updated_at', thresholdTime)
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseLifecycle.stuckHorses', maxRows: 50_000 }
      );
      // Under-reading here just means fewer horses are unstuck this pass, which
      // is harmless and self-correcting — but say so rather than treating a
      // partial read as "nothing is stuck".
      if (!stuckPage.complete) {
        console.warn('[HorseLifecycle] stuck-horse sweep read incompletely - retrying next pass');
        return;
      }
      const stuckHorses = stuckPage.rows;

      if (stuckHorses.length === 0) return;

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
            .in('status', ['registered', 'playing'])
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
      `[HorseLifecycle] horse=${horseId.slice(0, 8)} event=${event} ` + JSON.stringify(details)
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
        .in('status', ['registered', 'playing'])
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

      // A force reset is a cash-session recovery only. A tournament manager
      // owns tournament life, chips and seat exits; a race that seats this
      // horse after the detector read must make this reset stand down.
      if (activeSeats && activeSeats.length > 0) {
        const tableIds = Array.from(new Set(activeSeats.map((seat) => seat.table_id)));
        const tableRead = await selectInChunks<{ id: string; tournament_id: string | null }>(
          tableIds,
          (batch) => supabase.from('tables').select('id, tournament_id').in('id', batch),
          `HorseLifecycle.forceResetTables(${horseId.slice(0, 8)})`
        );
        if (
          !tableRead.complete ||
          tableRead.rows.length !== tableIds.length ||
          tableRead.rows.some((table) => table.tournament_id !== null)
        ) {
          return false;
        }
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

      // SWEEP #4 P0-2 FIX (2026-07-23): this used a DENYLIST
      // (.neq RUNNING/FINISHED/CANCELLED). The terminal status in this codebase
      // is 'COMPLETED' (set by finishTournament), and 'FINISHED' is never
      // written by anything — so every COMPLETED SNG older than 2h matched and
      // got its buy-ins REFUNDED AGAIN (winner included) and the record flipped
      // to CANCELLED. That is exactly why the live DB has 329 CANCELLED SNGs and
      // ZERO COMPLETED ones. Replaced with an ALLOWLIST of genuine pre-start
      // states so only SNGs that never began are cancellable here.
      const { data: staleSNGs } = await supabase
        .from('tournaments')
        .select('id, name, buy_in_amount')
        .eq('variant', 'sng')
        .in('status', ['ANNOUNCED', 'REGISTERING'])
        .lt('created_at', thresholdTime);

      if (!staleSNGs || staleSNGs.length === 0) return;

      /**
       * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
       *
       * This swept SNGs that had sat in ANNOUNCED/REGISTERING for hours,
       * refunded every entrant and flipped the tournament to CANCELLED. It was
       * the third of three cancel-on-underfill paths (the others were the
       * discovery-loop 30-minute timer and the boot sweep). All three are gone:
       * a game that has not filled is a game waiting for players, not a game to
       * delete. The discovery loop tops the field up with horses and starts it.
       *
       * The sweep is kept as pure OBSERVABILITY so a genuinely wedged SNG is
       * still visible in the lifecycle log — it just no longer destroys it.
       */
      await this.persistLifecycleLog('system', 'stale_sng_observed', {
        count: staleSNGs.length,
        sngIds: staleSNGs.slice(0, 20).map((s: { id: string }) => s.id),
        note: 'left REGISTERING for the fill-and-start path - never cancelled',
      });
      console.log(
        `[Lifecycle] ${staleSNGs.length} slow-filling SNG(s) left open for the fill-and-start path (never cancelled)`
      );
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

      // 2026-08-20: paged. This is a whole-table read across every open seat on
      // the platform (1,428 today, mostly tournament seats). PostgREST caps a
      // response at db-max-rows (1,000) WITHOUT erroring, so the sweep that
      // exists to reap orphaned seats was capable of never seeing the orphans.
      const stalePage = await fetchAllRows<{
        id: string;
        table_id: string;
        user_id: string;
        seat_number: number;
        stack: number;
        joined_at: string;
      }>(
        (cursor, want) => {
          let q = supabase
            .from('table_seats')
            .select('id, table_id, user_id, seat_number, stack, joined_at')
            .is('left_at', null)
            .lt('joined_at', thresholdTime)
            .order('id', { ascending: true })
            .limit(want);
          if (cursor) q = q.gt('id', cursor);
          return q;
        },
        { label: 'HorseLifecycle.staleSeats', maxRows: 50_000 }
      );
      // This sweep force-cashes-out seats. Acting on a partial read cannot
      // reap a seat it never saw (safe), but it also cannot be trusted to have
      // finished — and it runs every 4 hours, so skipping one pass is free.
      if (!stalePage.complete) {
        console.warn('[HorseLifecycle] stale-seat sweep read incompletely - retrying next pass');
        return;
      }
      const staleSeats = stalePage.rows;
      if (staleSeats.length === 0) return;

      let cleaned = 0;
      // SWEEP #4 P0-1 FIX (2026-07-23): this loop previously force-cashed-out
      // EVERY seat older than 4h with no filter on table status, tournament, or
      // hand activity. `joined_at` is written once at seat insert and never
      // refreshed, so a real cash player on a long session — or every seat at an
      // MTT that has run >4h — was force-cashed-out: for tournaments this credits
      // tournament chips 1:1 into real PLAYER wallets, and for cash it can mint
      // or vaporize the in-flight pot. This sweep must only reap GENUINELY
      // ORPHANED seats (disconnect leftovers on dead tables). Guard added:
      //   - never touch a seat on a tournament table (tournament lifecycle owns those)
      //   - never touch a seat on a table that produced a hand in the last 30 min (active)
      const HAND_ACTIVITY_WINDOW_MS = 30 * 60 * 1000;
      const recentHandCutoff = new Date(Date.now() - HAND_ACTIVITY_WINDOW_MS).toISOString();
      for (const seat of staleSeats) {
        try {
          // Skip tournament seats entirely — never cash tournament chips to wallets here.
          const { data: tableRow } = await supabase
            .from('tables')
            .select('tournament_id, cluster_id')
            .eq('id', seat.table_id)
            .maybeSingle();
          if (tableRow?.tournament_id) continue;
          // A CLUSTER TABLE'S SEATS ARE THE CONTROLLER'S (2026-09-05). A
          // must-move carries `joined_at` with the player (seniority travels,
          // OPORD 1.3 s9.8), so a four-hour player moved onto a quiet feeder
          // looked, to this sweep, like a four-hour orphan on a dead table
          // and was cashed out mid-session. The game moves its own players
          // and breaks its own tables; nothing here is orphaned.
          if (tableRow?.cluster_id) continue;

          // Skip tables with recent hand activity — those are live sessions, not orphans.
          const { data: recentHand } = await supabase
            .from('hand_history')
            .select('id')
            .eq('table_id', seat.table_id)
            .gte('created_at', recentHandCutoff)
            .limit(1)
            .maybeSingle();
          if (recentHand) continue;

          /* FIX 208: Use direct atomicCashout instead of RPC.
             AND A FAILED CASH-OUT IS REPORTED (2026-09-09). Without
             `onFailed`, `atomicCashout` THROWS - straight into the bare
             `catch {}` below - so a stale seat whose chips could not be
             returned produced no reportError, no metric and no financial
             alert, and `cleaned` still counted it. That is chips left on a
             felt nobody is watching, invisible. The callback exists for
             precisely this; every other caller passes one. */
          let cashedOut = true;
          await atomicCashout(seat.user_id, seat.table_id, seat.seat_number, {
            onFailed: (message) => {
              cashedOut = false;
              reportError(
                new Error(`stale-seat cashout refused: ${message}`),
                'HorseLifecycleManager.stale_seat_cashout_failed',
                { userId: seat.user_id, tableId: seat.table_id, seatNumber: seat.seat_number }
              );
            },
          });
          if (!cashedOut) continue;
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
        } catch (err) {
          /* One seat's failure must not stop the sweep - but it is no longer
             silent either. A bare `catch {}` here is how the cash-out above
             lost its only failure signal. */
          reportError(err, 'HorseLifecycleManager.stale_seat_cleanup_failed', {
            userId: seat.user_id,
            tableId: seat.table_id,
          });
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
  // TOURNAMENT WINNINGS / ELIMINATION PROCESSING — removed, see below
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * REMOVED 2026-08-22 — `processWinnings` and `processElimination`.
   *
   * Neither had a single caller anywhere in the repo, and `processWinnings`
   * was a loaded gun on a money path for whoever wired it up next:
   *
   *   - it called `credit_player_wallet` with NO idempotency key, so any
   *     retry above it paid the prize again;
   *   - it took `tournamentId` and never used it, so its ledger rows carried
   *     no `related_entity_id` and could not be tied back to the event that
   *     produced them — invisible to fn_tournament_payout_reconcile, which
   *     matches on exactly that column;
   *   - it wrote category `tournament_winnings`, a value that appears nowhere
   *     else on the platform, so every prize report would have missed it.
   *
   * Tournament prizes are paid by TournamentManagerEliminations and
   * tournamentRecovery through `fn_credit_and_log`, keyed
   * `tourney:{id}:prize:{user}:{place}`. If a horse-specific prize path is
   * ever genuinely needed, start from those.
   */
}
