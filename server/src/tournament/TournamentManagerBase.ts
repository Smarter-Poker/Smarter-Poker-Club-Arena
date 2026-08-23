/**
 * TournamentManager, layer 1/3 — state, lifecycle, blinds, breaks.
 *
 * Split out of the 4,096-line `src/GameServer.ts` monolith on 2026-07-28
 * (engine audit D21 — god-class decomposition). Behavior is preserved
 * line-for-line: the only edits are module boundaries, `private` widened to
 * `protected` where a member is reached across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import nodeCrypto from 'node:crypto';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { supabase } from '../services/supabase.js';
import { ChipRaceEngine } from '../engine/ChipRaceEngine.js';
import { TableBalancer } from '../engine/TableBalancer.js';
import {
  SPIN_TIERS,
  SPIN_REVEAL,
  spinRevealToDealMs,
  spinRevealTotalMs,
  SPIN_SEATS as SPEC_SPIN_SEATS,
  spinTier,
  spinRakeRate,
  spinBlindsForLevel,
} from '../config/spinSpec.js';
import { reportError } from '../services/errorReporter.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import { refundAndCloseCancelledTournament } from './tournamentRecovery.js';
import { acceleratedLevelMs } from './acceleratedLevels.js';
import type { GameServer } from '../GameServer.js';

export abstract class TournamentManagerBase {
  protected tournamentId: string;
  protected gameServer: GameServer;
  /** Guard so two revival sweeps never overlap. */
  private revivingTables: boolean = false;
  /** Drives reviveDeadTableEngines — the tournament-side freeze recovery. */
  protected tableLivenessInterval: NodeJS.Timeout | null = null;
  protected running: boolean = false;
  protected blindTimer: NodeJS.Timeout | null = null;
  protected eliminationTimer: NodeJS.Timeout | null = null;
  protected tableEngines: Map<string, ServerTableEngine> = new Map();
  protected currentLevel: number = 0;
  // Add-on period
  protected addOnPeriodTriggered: boolean = false;
  /**
   * When the add-on was last offered to the field. The window is offered
   * REPEATEDLY, not once, so a player who was between seats at the moment it
   * opened still gets theirs -- see tryTournamentAddOns.
   */
  protected lastAddOnOfferAt: number = 0;
  protected pendingAddOnPeriod: boolean = false;
  // Hand-for-hand bubble
  protected handForHandActive: boolean = false;
  protected handForHandAnnounced: boolean = false;
  // Final table detection
  protected isFinalTable: boolean = false;
  // Synchronized break state
  protected onBreak: boolean = false;
  /**
   * How long the last hand is allowed to take after :55 before the break
   * countdown starts regardless. Sized so a slow all-in-with-runouts hand still
   * finishes, while a genuinely wedged table cannot stall the break forever.
   */
  static readonly LAST_HAND_GRACE_MS = 2 * 60 * 1000;
  /**
   * Longest a table may sit paused ON PURPOSE before the liveness sweep stops
   * believing it. Comfortably above the worst legitimate case (5 min break +
   * 2 min last-hand grace), so a real break is never disturbed, while a table
   * wedged in a pause is still rebuilt instead of freezing forever.
   */
  static readonly MAX_HEALTHY_PAUSE_MS = 10 * 60 * 1000;
  protected savedBlindTimerRemaining: number = 0;
  protected blindTimerStartedAt: number = 0;
  // Hand-for-hand sync
  protected handForHandSyncInterval: NodeJS.Timeout | null = null;
  protected handForHandRePauseTimer: NodeJS.Timeout | null = null;
  // Late reg finalization
  protected prizePoolFinalized: boolean = false;
  // Tournament metadata cache
  protected tournamentCache: any = null;
  // FIX 151: ChipRaceEngine for denomination removal on level-up
  protected chipRaceEngine: ChipRaceEngine = new ChipRaceEngine((event) => {
    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] ChipRace: ${event.type}`);
  });
  // FIX 154: TableBalancer for proper gap-1 rebalancing across tournament tables
  protected tableBalancer: TableBalancer = new TableBalancer((event) => {
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] TableBalance: ${event.type} — ${(event as any).moveCount || 0} moves`
    );
  });
  // Reusable broadcast channel (prevents memory leak from creating per-event)
  protected broadcastChannel: any = null;
  protected broadcastReady: boolean = false;

  constructor(tournamentId: string, gameServer: GameServer) {
    this.tournamentId = tournamentId;
    this.gameServer = gameServer;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Reusable broadcast — single channel per tournament lifecycle */
  protected async broadcast(eventType: string, payload: any): Promise<void> {
    try {
      if (!this.broadcastChannel) {
        this.broadcastChannel = supabase.channel(`t-break-${this.tournamentId}`);
        await this.broadcastChannel.subscribe();
        this.broadcastReady = true;
      }
      await this.broadcastChannel.send({
        type: 'broadcast',
        event: 'tournament_event',
        payload: { type: eventType, payload },
      });
    } catch (e) {
      reportError(e, 'TournamentthistournamentIdslic.Broadcast_eventType_failed');
      // Reset channel on error so next call re-creates
      this.broadcastChannel = null;
      this.broadcastReady = false;
    }
  }

  /** Clean up broadcast channel when tournament ends */
  protected async cleanupBroadcastChannel(): Promise<void> {
    if (this.broadcastChannel) {
      try {
        await this.broadcastChannel.unsubscribe();
      } catch {}
      this.broadcastChannel = null;
      this.broadcastReady = false;
    }
  }

  /** Synchronized break: pause blind timer and broadcast break event */
  async pauseForBreak(breakDurationMs: number): Promise<void> {
    if (!this.running || this.onBreak) return;
    this.onBreak = true;

    // Save remaining blind timer time
    // TOURNEY-AUDIT 2026-07-24 (sweep 4): the empty-structure guard used to
    // `return` AFTER setting onBreak=true but BEFORE clearing the timer —
    // leaving the level clock running through the "break" with onBreak stuck
    // true. The timer is now always cleared once the break begins.
    if (this.blindTimer) {
      const elapsed = Date.now() - this.blindTimerStartedAt;
      clearTimeout(this.blindTimer);
      this.blindTimer = null;
      const blindStructure = this.tournamentCache?.blind_structure || [];
      if (blindStructure && blindStructure.length > 0) {
        const currentLevelData =
          blindStructure[Math.min(this.currentLevel, blindStructure.length - 1)];
        const totalMs = this.levelDurationMs(currentLevelData);
        this.savedBlindTimerRemaining = Math.max(totalMs - elapsed, 1000);
      } else {
        this.savedBlindTimerRemaining = 0;
      }
    }

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] SYNCHRONIZED BREAK — ${Math.round(breakDurationMs / 60000)} minutes`
    );

    /**
     * Dan 2026-08-19: persist the break. It used to live only on this instance,
     * so a break was invisible to the database, unverifiable after the fact,
     * and lost entirely if the engine restarted mid-break.
     *
     * break_ends_at is deliberately NULL here. At :55 we only announce the LAST
     * HAND — the five minutes do not start until every table has finished it.
     * beginBreakCountdown() fills in the end time once that happens, which is
     * why a break runs a little over five minutes end to end.
     */
    try {
      await supabase
        .from('tournaments')
        .update({
          on_break: true,
          break_started_at: new Date().toISOString(),
          break_ends_at: null,
        })
        .eq('id', this.tournamentId);
    } catch (err) {
      reportError(err, 'TournamentManagerBase.pauseForBreak_persist');
    }

    const blindStructure = this.tournamentCache?.blind_structure || [];
    const nextLevel = blindStructure[Math.min(this.currentLevel, blindStructure.length - 1)];
    await this.broadcast('tournament_break', {
      level: this.currentLevel,
      breakDurationMinutes: Math.round(breakDurationMs / 60000),
      breakEndsAt: new Date(Date.now() + breakDurationMs).toISOString(),
      synchronized: true,
      nextLevel: nextLevel
        ? {
            smallBlind: nextLevel.smallBlind,
            bigBlind: nextLevel.bigBlind,
            ante: nextLevel.ante || 0,
          }
        : null,
    });

    // 2026-08-18: the break screen is a full-screen opaque overlay
    // (TournamentBreakScreen.css: position fixed, inset 0, z-index 700), and
    // until now NOTHING stopped the tables underneath it. Every player sat
    // behind the overlay while hands were dealt: they auto-folded every hand
    // and paid blinds and antes for the whole five minutes. In a turbo that is
    // roughly a level and a half, enough to blind a short stack out "during
    // the break". Worse, the overlay is minimizable, so a player who knew to
    // close it kept playing against players who did not.
    //
    // pauseAfterHand() is the same mechanism hand-for-hand already uses: the
    // current hand is played to the end and no new hand is dealt.
    for (const engine of this.tableEngines.values()) {
      try {
        // Budget the pause for the WHOLE break: the last hand still has to
        // finish, then five minutes run on top of that. The engine's default
        // 120s safety timeout would otherwise resume dealing mid-break.
        engine.pauseAfterHand(breakDurationMs + TournamentManagerBase.LAST_HAND_GRACE_MS);
      } catch (err) {
        reportError(err, 'TournamentManagerBase.pauseForBreak_pause_engine');
      }
    }
  }

  /**
   * Dan 2026-08-19: "ONCE THE LAST HAND ON EVERY TABLE IS COMPLETED, THE 5
   * MINUTE BREAK STARTS."
   *
   * True once every table of this tournament has finished the hand that was in
   * progress at :55 and is parked between hands. A tournament with no tables
   * counts as parked so it can never hold the whole platform's break hostage.
   */
  areAllTablesParked(): boolean {
    const engines = Array.from(this.tableEngines.values());
    if (engines.length === 0) return true;
    return engines.every((e) => {
      try {
        return e.isWaitingForHandForHand();
      } catch {
        // An engine we cannot interrogate must not block the break.
        return true;
      }
    });
  }

  /**
   * Called once the last hand has landed on every table across every
   * tournament. Writes the real end time so the countdown players see reflects
   * when the break ACTUALLY started, not when the last hand was announced.
   */
  async beginBreakCountdown(breakDurationMs: number): Promise<void> {
    if (!this.onBreak) return;
    const endsAt = new Date(Date.now() + breakDurationMs).toISOString();
    try {
      await supabase
        .from('tournaments')
        .update({ break_ends_at: endsAt })
        .eq('id', this.tournamentId);
    } catch (err) {
      reportError(err, 'TournamentManagerBase.beginBreakCountdown_persist');
    }
    await this.broadcast('tournament_break_started', {
      level: this.currentLevel,
      breakEndsAt: endsAt,
      synchronized: true,
    });
  }

  /** Resume from synchronized break: restart blind timer with remaining time */
  async resumeFromBreak(): Promise<void> {
    if (!this.running || !this.onBreak) return;
    this.onBreak = false;

    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] BREAK ENDED — resuming play`);

    // Clear the persisted break state (see pauseForBreak).
    try {
      await supabase
        .from('tournaments')
        .update({ on_break: false, break_ends_at: null })
        .eq('id', this.tournamentId);
    } catch (err) {
      reportError(err, 'TournamentManagerBase.resumeFromBreak_persist');
    }

    await this.broadcast('break_ended', { level: this.currentLevel });

    // Undo the pause taken in pauseForBreak. Hand-for-hand owns the pause state
    // when it is running (it pauses and resumes every engine in lockstep on the
    // money bubble), so resuming here would let one table run away from the
    // others — leave those engines alone and let the bubble sync resume them.
    if (!this.handForHandActive) {
      for (const engine of this.tableEngines.values()) {
        try {
          engine.resumeDealing();
        } catch (err) {
          reportError(err, 'TournamentManagerBase.resumeFromBreak_resume_engine');
        }
      }
    }

    // Restart blind timer with saved remaining time. AUDIT FIX 2026-07-19: on
    // fire, run the SAME full level transition as the normal timer (writes
    // blinds to tables, emits level_up, chip race, late-reg/add-on) instead of
    // a bare currentLevel++ that left table blinds unchanged and could freeze
    // escalation.
    if (this.savedBlindTimerRemaining > 0) {
      const blindStructure = this.tournamentCache?.blind_structure || [];
      this.blindTimerStartedAt = Date.now();
      this.blindTimer = setTimeout(() => {
        void this.advanceBlindLevel(blindStructure);
      }, this.savedBlindTimerRemaining);
    }

    // If add-on period was deferred due to break, trigger it now
    if (this.pendingAddOnPeriod && !this.addOnPeriodTriggered) {
      this.pendingAddOnPeriod = false;
      await this.triggerAddOnPeriod();
    }
  }

  /**
   * synchronized_breaks=false (2026-08-22 parity): this tournament opts OUT of
   * the platform-wide :55 synchronized break and keeps dealing through it.
   *
   * Per-structure breaks are NOT implemented server-side — advanceBlindLevel
   * deliberately SKIPS `isBreak` rows in blind_structure (see the "Skip any
   * break entries" branch) — so for an opted-out tournament, skipping the
   * global break is the whole behavior; there is no per-structure break to
   * honor instead.
   */
  synchronizedBreaksEnabled(): boolean {
    return this.tournamentCache?.synchronized_breaks !== false;
  }

  /**
   * Late registration is closed once the level cap has been reached (or the
   * prize pool finalized, which start() does immediately for tournaments with
   * no late-reg window at all). Shared by the accelerated-MTT level halving.
   */
  protected isLateRegClosed(): boolean {
    if (this.prizePoolFinalized) return true;
    const cap = this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 0;
    return cap > 0 && this.currentLevel >= cap;
  }

  /** Check if this is an MTT or XMTT (eligible for synchronized breaks) */
  isMttOrXmtt(): boolean {
    const type = this.tournamentCache?.tournament_type;
    const variant = this.tournamentCache?.variant;
    if (type === 'SNG' || type === 'SPIN' || variant === 'sng' || variant === 'spin') return false;
    return true;
  }

  /** Start hand-for-hand sync: check every 500ms if all tables finished their hand */
  protected startHandForHandSync(): void {
    if (this.handForHandSyncInterval) return;

    this.handForHandSyncInterval = setInterval(() => {
      if (!this.handForHandActive || !this.running) {
        this.stopHandForHandSync();
        return;
      }

      // Check if ALL table engines are waiting for hand-for-hand resume
      const engines = Array.from(this.tableEngines.values());
      if (engines.length === 0) return;

      const allWaiting = engines.every((e) => e.isWaitingForHandForHand());
      if (allWaiting) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Hand-for-hand: all ${engines.length} tables done — resuming for next hand`
        );
        // Resume all engines together for the next hand, then immediately re-pause
        for (const engine of engines) {
          engine.resumeDealing();
        }
        // Re-pause for next hand-for-hand cycle (if still active)
        if (this.handForHandActive) {
          if (this.handForHandRePauseTimer) clearTimeout(this.handForHandRePauseTimer);
          this.handForHandRePauseTimer = setTimeout(() => {
            // Guard: tournament ended, or the bubble already burst (hand-for-hand
            // no longer active) — do NOT re-pause engines that were resumed for
            // normal post-bubble play, or the tournament freezes.
            if (!this.running || !this.handForHandActive) return;
            this.handForHandRePauseTimer = null;
            for (const engine of this.tableEngines.values()) {
              engine.pauseAfterHand();
            }
          }, 500); // Small delay to let dealing start
        }
      }
    }, 500);
  }

  /** Stop hand-for-hand sync check */
  protected stopHandForHandSync(): void {
    if (this.handForHandSyncInterval) {
      clearInterval(this.handForHandSyncInterval);
      this.handForHandSyncInterval = null;
    }
    // Also cancel any pending re-pause. Bubble burst calls this and then resumes
    // engines permanently; a surviving re-pause timer would immediately freeze
    // them again for a hand-for-hand cycle that is over.
    if (this.handForHandRePauseTimer) {
      clearTimeout(this.handForHandRePauseTimer);
      this.handForHandRePauseTimer = null;
    }
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] Starting...`);

    try {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', this.tournamentId)
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

      if (!tournament) throw new Error('Tournament not found');

      if (typeof tournament.blind_structure === 'string') {
        try {
          tournament.blind_structure = JSON.parse(tournament.blind_structure);
        } catch {
          tournament.blind_structure = [];
        }
      }
      if (!Array.isArray(tournament.blind_structure)) {
        tournament.blind_structure = [];
      }

      this.tournamentCache = tournament;
      this.prizePoolFinalized = tournament.prize_pool_finalized || false;

      /**
       * Enforce a minimum field of three -- OR EVERY SEAT, WHEN THERE ARE
       * FEWER THAN THREE OF THEM.
       *
       * FIX 2026-08-23 [P0]: the floor was the literal 3, which a HEADS-UP
       * game (max_players = 2) can never reach. It is not short of players --
       * it is FULL. Every heads-up game on the platform therefore stood down
       * on every discovery pass and never dealt a hand: 17 of them sat
       * REGISTERING for FIFTY HOURS with two paid entrants each and zero
       * tables ever created, while the top-up loop was asked, every five
       * seconds, to find a third player for a two-seat game.
       *
       * The rule Dan set is about a Spin ("spins can NEVER START until 3
       * players are registered AND HAVE PAID") and a Spin has three seats, so
       * capping the floor at max_players leaves that rule bit-for-bit intact
       * and changes behaviour ONLY for the formats the literal broke -- the
       * ones with fewer than three seats. An MTT is unaffected: its floor is
       * min(3, 50) = 3, exactly as before.
       *
       * FIX 2026-08-20 [P0]: this counted `status = 'registered'` ONLY, which
       * made any tournament that got PART WAY through starting permanently
       * unstartable. start() migrates every registration registered -> playing
       * further down, then creates tables and seats players, and only then
       * flips the tournament to RUNNING. If anything throws between the
       * migration and that flip, the tournament stays REGISTERING with a field
       * full of 'playing' rows — and from then on this count reads 0, so every
       * retry stood down before reaching the migration. Nothing ever recovered
       * it, because the stand-down IS the thing preventing recovery.
       *
       * Seen in production: "Union Grand Championship" sat REGISTERING for over
       * nine hours with 182 players and their buy-ins committed, and "Night Owl
       * Special" for nearly six with 77, both looping through this branch every
       * few seconds. Once the rows were flipped back to 'registered' by hand
       * both started immediately and built 42 and 18 tables respectively — so
       * the seating path was never the problem, this count was.
       *
       * A player marked 'playing' is by definition IN the field, so both
       * statuses count. The migration below is already idempotent (it only
       * touches 'registered' rows), and createTablesAndSeatPlayers skips
       * players who are already seated.
       */
      const { count: regCount } = await supabase
        .from('tournament_players')
        .select('*', { count: 'exact', head: true })
        .eq('tournament_id', this.tournamentId)
        .in('status', ['registered', 'playing']);

      /**
       * Never more than the table holds, never fewer than two -- a game of
       * one is not a game. `max_players` is read defensively because a null
       * or 0 here must not silently lower the Spin floor.
       */
      const seatsAvailable = Number(tournament.max_players) || 0;
      const requiredField = seatsAvailable > 0 ? Math.max(2, Math.min(3, seatsAvailable)) : 3;

      if ((regCount || 0) < requiredField) {
        /**
         * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
         *
         * This used to CANCEL the tournament outright when fewer than three
         * players were registered at start time. It now stands down instead:
         * the tournament stays REGISTERING, the discovery loop tops the field
         * up with horses on its next pass, and start() is called again with a
         * full field. Nobody's buy-in is refunded out from under them and no
         * scheduled game disappears from the lobby.
         */
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Only ${regCount} of ${requiredField} player(s) — standing down so the field can be filled (NOT cancelling)`
        );
        this.running = false;
        return;
      }

      // ═══════════════════════════════════════════════════════════════
      // Dan 2026-08-20: "spins can NEVER START until 3 players are
      // registered AND HAVE PAID."
      //
      // Headcount alone is forgeable: the legacy 3-arg
      // register_for_tournament RPC created tournament_players rows WITHOUT
      // debiting anyone — proven the hard way when an agent-seated entry
      // played two full spins for free (kingfish, 2026-08-20; charged
      // retroactively, RPC since dropped). Every legitimate path
      // (fn_register_for_tournament for humans,
      // fn_register_horse_for_tournament for horses) writes a
      // 'tournament_buyin' DEBIT to wallet_transactions in the same
      // transaction as the registration, so a paid seat always has its
      // ledger row — that row is the evidence this gate demands.
      //
      // An unpaid registration is REMOVED (loudly), the head-count is
      // corrected, and the start stands down: the discovery loop refills the
      // seat with a paying horse on its next pass. Removing rather than
      // refusing forever is what keeps "never start unpaid" from becoming
      // "never start at all" — the freeloading row cannot pay, so waiting on
      // it would deadlock the game.
      if (tournament.variant === 'spin' || tournament.tournament_type === 'SPIN') {
        const buyIn = Number(tournament.buy_in_amount || 0);
        if (buyIn > 0) {
          const { data: regs } = await supabase
            .from('tournament_players')
            .select('user_id')
            .eq('tournament_id', this.tournamentId)
            .in('status', ['registered', 'playing']);
          const regIds = (regs ?? []).map((r: any) => r.user_id).filter(Boolean);

          const { data: debits, error: debitErr } = await supabase
            .from('wallet_transactions')
            .select('user_id, amount')
            .eq('related_entity_id', this.tournamentId)
            .eq('category', 'tournament_buyin')
            .eq('type', 'debit')
            .in('user_id', regIds.length > 0 ? regIds : ['00000000-0000-0000-0000-000000000000']);

          if (debitErr) {
            // Evidence unreadable ≠ evidence of non-payment. Stand down and
            // try again next pass rather than kicking players over a blip.
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Paid-entry check unreadable (${debitErr.message}) — standing down, will retry`
              ),
              'Tournament.spin_paid_check_unreadable'
            );
            this.running = false;
            return;
          }

          const paidBy = new Map<string, number>();
          for (const d of debits ?? []) {
            paidBy.set(d.user_id, (paidBy.get(d.user_id) || 0) + Number(d.amount || 0));
          }
          const unpaid = regIds.filter((id) => (paidBy.get(id) || 0) + 1e-9 < buyIn);

          if (unpaid.length > 0) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] SPIN PAID-GATE: ${unpaid.length} registration(s) with no ${buyIn}-chip buy-in ledger row (${unpaid
                  .map((u) => u.slice(0, 8))
                  .join(', ')}) — removing them; a spin NEVER starts until 3 players have paid`
              ),
              'Tournament.spin_unpaid_registration_removed'
            );
            await supabase
              .from('tournament_players')
              .delete()
              .eq('tournament_id', this.tournamentId)
              .in('user_id', unpaid);
            await supabase
              .from('tournaments')
              .update({ current_players: Math.max(0, (regCount || 0) - unpaid.length) })
              .eq('id', this.tournamentId);
            this.running = false;
            return; // discovery refills with PAYING horses and restarts
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // SPIN & GO — settle the money through the Reserve Pool
      // ═══════════════════════════════════════════════════════════════
      // This block used to carry TWO hardcoded multiplier tables (EV 2.2415
      // and 2.3288) which disagreed with the two other tables elsewhere in the
      // codebase, and it OVERWROTE prize_pool with buy_in x multiplier — so
      // whenever the multiplier was under 3.0 (~93% of games) the difference
      // between what players contributed and what the pool held simply stopped
      // existing. No debit, no credit, no row. Measured across 2,091 completed
      // spins: ~1,160 in no ledger at all.
      //
      // The tables are gone, and as of the second 2026-08-20 pass THIS is
      // where the draw itself lives. Creation used to draw and stamp the row
      // a minute early, which leaked the answer no matter how carefully the
      // labels were hidden — prize_pool = buy_in x multiplier IS the
      // multiplier, readable by any lobby client doing division. The only
      // draw a client cannot read early is one that has not happened yet, so
      // the multiplier is decided HERE, at start, and settled in the same
      // breath by fn_spin_settle_game:
      //   collected  = seats x buy_in      (no fee on top — a Spin is not 10+1)
      //   house_rake = rake_rate x collected, FIXED, to rake_records
      //   reserve_in = the remainder, into the pool
      //   prize_pool = buy_in x multiplier, drawn FROM the pool
      if (tournament.variant === 'spin' || tournament.tournament_type === 'SPIN') {
        let spinMultiplier = tournament.spin_multiplier || 0;
        // Set when THIS path draws — the normal case. A row that already
        // carries a multiplier (created before the draw moved to start, or a
        // restart re-entering this block after the draw committed) also
        // already carries the locked tiers recorded with that draw, and
        // overwriting them with a gate evaluated now — against a pool balance
        // that has moved since — would make the wheel show a restriction that
        // never applied.
        let redrawnLockedTiers: Array<{
          multiplier: number;
          reason?: string;
          unlocksAt?: number;
        }> | null = null;

        if (!spinMultiplier || spinMultiplier <= 0) {
          // THE DRAW. Through fn_spin_draw_multiplier, so a high multiplier
          // is only ever SELECTED when the Reserve Pool can pay it — an
          // unfundable tier is excluded from the draw rather than drawn and
          // refused, which is what makes an unpayable jackpot structurally
          // impossible.
          try {
            const { data: draw } = await supabase.rpc('fn_spin_draw_multiplier', {
              p_club_id: tournament.club_id,
              p_buy_in: tournament.buy_in_amount || 0,
              p_tiers: SPIN_TIERS.map((t) => ({
                multiplier: t.multiplier,
                freq: t.freq,
                reserveThresholdX: t.reserveThresholdX,
              })),
              p_rake_rate: spinRakeRate(tournament.buy_in_amount || 0),
              p_seats: tournament.current_players || SPEC_SPIN_SEATS,
            });
            spinMultiplier = Number(draw?.multiplier) || 0;
            if (Array.isArray(draw?.locked)) {
              redrawnLockedTiers = draw.locked
                .map((l: any) => ({
                  multiplier: Number(l?.multiplier),
                  reason: l?.reason ? String(l.reason) : undefined,
                  unlocksAt: Number.isFinite(Number(l?.unlocksAt))
                    ? Number(l.unlocksAt)
                    : undefined,
                }))
                .filter((l: { multiplier: number }) => Number.isFinite(l.multiplier));
            }
          } catch {
            /* handled below */
          }
          if (!spinMultiplier || spinMultiplier <= 0) {
            // Draw RPC unreachable. Resolve DOWN to the SMALLEST tier, never
            // up and never a local roll: a database hiccup must not be able
            // to hand out a jackpot the pool was never asked about, and a 2x
            // is the one prize every funded pool can always cover.
            spinMultiplier = SPIN_TIERS[0].multiplier;
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw RPC unreachable at start — resolved down to ${spinMultiplier}x`
              ),
              'Tournament.spin_draw_rpc_down'
            );
          } else {
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw: ${spinMultiplier}x through the reserve gate`
            );
          }
        }

        const buyIn = tournament.buy_in_amount || 0;
        const seats = tournament.current_players || SPEC_SPIN_SEATS;
        const tier = spinTier(spinMultiplier);
        const prizePool = Math.round(buyIn * spinMultiplier * 100) / 100;

        // Book it. This is the row that did not exist before the cutover.
        //
        // RETRIED. Settlement is idempotent (it returns already_settled on a
        // second call), so retrying is free, and a single attempt proved
        // insufficient in production: three spins ran unbooked within twenty
        // minutes of the cutover because one transient failure was enough to
        // lose the row permanently. Lock contention on a busy club's pool is
        // the expected cause; a couple of short retries covers it.
        let settled = false;
        for (let attempt = 1; attempt <= 3 && !settled; attempt++) {
          try {
            const { data: settle, error: settleErr } = await supabase.rpc('fn_spin_settle_game', {
              p_tournament_id: this.tournamentId,
              p_club_id: tournament.club_id,
              p_buy_in: buyIn,
              p_seats: seats,
              p_multiplier: spinMultiplier,
              p_rake_rate: spinRakeRate(buyIn),
            });
            if (settleErr || !settle?.ok) {
              throw new Error(settleErr?.message || settle?.reason || 'settle_failed');
            }
            settled = true;
            if (Number(settle.operator_shortfall) > 0) {
              // The pool was too thin to cover the prize. Players are paid in
              // full regardless; this says the club needs seeding.
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Spin pool SHORTFALL ${settle.operator_shortfall} on a ${spinMultiplier}x — club ${tournament.club_id} needs a larger reserve seed`
                ),
                'Tournament.spin_pool_shortfall'
              );
            }
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] SPIN ${spinMultiplier}x — pool ${prizePool}, rake ${settle.house_rake}, reserve ${settle.balance}`
            );
          } catch (settleErr: any) {
            if (attempt === 3) {
              // The game still runs and players are still paid; what is lost is
              // the ledger row, so it is reported loudly rather than swallowed.
              // fn_spin_sweep_unbooked() will catch it on the next pass.
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Spin reserve settlement FAILED after 3 attempts (${settleErr?.message}) — prize pool is correct but this game is unbooked`
                ),
                'Tournament.spin_settle_failed'
              );
            } else {
              await new Promise((r) => setTimeout(r, 250 * attempt));
            }
          }
        }

        // Structure scales with the drawn tier: 300 chips and 1-minute
        // levels at 2x, 500 chips and 5-minute levels at 500x. Since the
        // draw moved to start, creation writes only a smallest-tier
        // placeholder, so the blinds MUST be rewritten here — before
        // createTablesAndSeatPlayers below reads them — or a 500x would run
        // on 1-minute levels.
        const spinBlinds = Array.from({ length: 12 }, (_, i) => {
          const b = spinBlindsForLevel(i + 1);
          return {
            level: i + 1,
            smallBlind: b.small,
            bigBlind: b.big,
            ante: 0,
            duration: (tier?.levelMinutes ?? 3) * 60,
          };
        });

        // RETRIED AND CHECKED (2026-08-22). This single write carries the
        // whole result of the draw — the multiplier, the pool, the stack, the
        // blinds and the payout shape. It used to be fire-and-forget, so if it
        // did not land the game went on to RUNNING carrying only what
        // registration had accumulated: `prize_pool` = seats x buy-in and
        // `spin_multiplier` NULL. That is exactly the state dea62e98, a374cdd3
        // and 78181713 were found in on 2026-08-21 — three games that ran with
        // no draw, which `fn_spin_sweep_unbooked` then skipped forever because
        // it required `spin_multiplier > 0`.
        let spinRowWritten = false;
        for (let attempt = 1; attempt <= 3 && !spinRowWritten; attempt++) {
          const { error: spinRowErr } = await supabase
            .from('tournaments')
            .update({
              prize_pool: prizePool,
              spin_multiplier: spinMultiplier,
              is_premium_spin: spinMultiplier >= 100,
              starting_chips: tier?.startingStack ?? tournament.starting_chips,
              blind_structure: spinBlinds,
              payout_structure: (tier?.payouts ?? [1]).map((pct, i) => ({
                place: i + 1,
                percentage: Math.round(pct * 10000) / 100,
              })),
              ...(redrawnLockedTiers ? { spin_locked_tiers: redrawnLockedTiers } : {}),
            })
            .eq('id', this.tournamentId);
          if (!spinRowErr) {
            spinRowWritten = true;
            break;
          }
          if (attempt === 3) {
            // The game still starts — Dan 2026-08-19, tournaments run, they do
            // not cancel — but it starts on the placeholder structure, so this
            // has to be loud. fn_spin_repair_missing_multiplier reconstructs
            // the multiplier from the prize actually paid on the next sweep.
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw row write FAILED after 3 attempts (${spinRowErr.message}) — ${spinMultiplier}x was drawn but the row still reads NULL; this game will run on the placeholder structure`
              ),
              'Tournament.spin_draw_row_write_failed'
            );
          } else {
            await new Promise((r) => setTimeout(r, 250 * attempt));
          }
        }

        tournament.prize_pool = prizePool;
        tournament.spin_multiplier = spinMultiplier;
        // The in-memory object drives table creation and the level timer, so
        // it must agree with what was just written — the DB write alone would
        // leave this start running on the placeholder structure.
        tournament.blind_structure = spinBlinds;
        if (tier?.startingStack) tournament.starting_chips = tier.startingStack;
        if (this.tournamentCache) {
          this.tournamentCache.blind_structure = spinBlinds;
          this.tournamentCache.spin_multiplier = spinMultiplier;
        }
      }

      // Migrate registrations (registered -> playing).
      //
      // EARLY BIRD (2026-08-22 parity): fn_register_for_tournament credits the
      // early-bird bonus into tournament_players.chips AT REGISTRATION, so a
      // 'registered' row's chips column is the pre-credited bonus (0 for
      // everyone else). Seating must therefore ADD the starting stack to that
      // bonus — the old single-statement UPDATE overwrote it with
      // starting_chips and silently destroyed every bonus ever granted.
      {
        const { data: regRows } = await supabase
          .from('tournament_players')
          .select('user_id, chips')
          .eq('tournament_id', this.tournamentId)
          .eq('status', 'registered');
        await Promise.allSettled(
          (regRows ?? []).map((row: { user_id: string; chips: number | null }) => {
            const bonus = Math.max(0, Math.floor(Number(row.chips) || 0));
            return supabase
              .from('tournament_players')
              .update({ status: 'playing', chips: tournament.starting_chips + bonus })
              .eq('tournament_id', this.tournamentId)
              .eq('user_id', row.user_id)
              .eq('status', 'registered');
          })
        );
      }

      /**
       * SEAT-FIRST STACK SYNC — but NOT yet, if a wheel is about to turn.
       *
       * A player who sat down before the game started holds a RESERVATION at
       * zero chips: stack depth is a property of the tier, and spin tiers run
       * 300/400/500, so there is no honest number to seat them with until the
       * draw lands.
       *
       * Dan 2026-08-21: "AFTER THE SPIN COMPLETES, CHIP STACKS GET ADDED,
       * BUTTON RANDOMLY ASSIGNED AND THE SPIN STARTS." Crediting here — which
       * is what used to happen — put the stacks on the felt while the wheel
       * was still turning, so the table had already answered the question the
       * wheel was in the middle of asking. For a Spin the credit is scheduled
       * after the reveal instead; everything else is credited now.
       */
      if (!(await this.deferStacksForSpinReveal(tournament))) {
        await this.creditSeatStacks(tournament);
      }

      // Create tables and seat players
      await this.createTablesAndSeatPlayers(tournament);

      /**
       * THE SHARED REVEAL (Dan 2026-08-21).
       *
       * "THE WHEEL STARTS SPINNING THE MOMENT THE 3RD PLAYER PAYS FOR HIS
       *  SEAT... ONE SECOND LATER, A 3...2...1... COUNT DOWN CLOCK MUST BEGIN
       *  WITH A WHEEL SPIN."
       *
       * The engine names the moment ONCE, here, and every seat renders
       * against that same timestamp. Before this each client started its own
       * wheel whenever it finished loading, so three players watched three
       * different wheels and anyone arriving late missed the reveal for good.
       *
       * The tables are HELD for the whole sequence, so cards can never be
       * dealt underneath a spinning wheel. Until now nothing reserved the
       * moment — the wheel merely escaped being dealt over because engine
       * start-up happened to take about 22 seconds, which is luck, not a
       * contract.
       */
      const revealVariant = String(tournament.variant ?? '').toLowerCase();
      const revealIsSpin =
        revealVariant === 'spin' ||
        String(tournament.tournament_type ?? '').toUpperCase() === 'SPIN';
      // The draw wrote this onto the in-memory row above; it is the value the
      // wheel must land on.
      const revealMultiplier = Number(tournament.spin_multiplier) || 0;
      if (revealIsSpin && revealMultiplier > 0) {
        const revealAt = Date.now();
        /**
         * Held until the first CARD may legally be dealt — which is later than
         * the wheel stopping. The hold has to cover the chip drop and the
         * button draw too, or the engine is free to deal in the same instant
         * the stacks are still being written, and the deal wins that race.
         */
        const holdUntil = revealAt + spinRevealToDealMs();
        for (const [tableId, engine] of this.tableEngines) {
          try {
            engine.holdDealingUntil(holdUntil);
            tableStateHub.emitEvent(tableId, {
              type: 'spin_reveal',
              table_id: tableId,
              tournament_id: this.tournamentId,
              multiplier: revealMultiplier,
              buy_in: Number(tournament.buy_in_amount) || 0,
              locked_tiers: tournament.spin_locked_tiers ?? null,
              // Clients animate against THIS instant, not their own load time.
              reveal_at: revealAt,
              prize_pool: Number(tournament.prize_pool) || 0,
              timestamp: revealAt,
            });
          } catch (err) {
            // The reveal is theatre; it must never stop a game from starting.
            reportError(err, 'Tournament.' + this.tournamentId.slice(0, 8) + '.spin_reveal_emit');
          }
        }
        this.scheduleSpinPostReveal(tournament, revealAt);
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Spin reveal broadcast — ${revealMultiplier}x, dealing held ${spinRevealToDealMs()}ms`
        );
      }

      // Set tournament to RUNNING
      // Guard: only transition REGISTERING → RUNNING (prevents re-starting)
      await supabase
        .from('tournaments')
        .update({ status: 'RUNNING', started_at: new Date().toISOString() })
        .eq('id', this.tournamentId)
        .eq('status', 'REGISTERING');

      // LIVE E2E FIX 2026-08-15: tournamentCache was captured while status was
      // still REGISTERING and never refreshed after this transition — so
      // ensureLateRegSeated's `status !== 'RUNNING'` guard made the every-5s
      // seat self-heal a permanent no-op for every tournament started (not
      // resumed) by this process. Live evidence: 3 RUNNING tournaments frozen
      // for hours with 'playing' players holding chips but no active seat.
      if (this.tournamentCache) this.tournamentCache.status = 'RUNNING';

      // Validate payout structure sums to 100% (or close enough to prevent chip leak)
      if (this.tournamentCache?.payout_structure) {
        let payouts = this.tournamentCache.payout_structure;
        if (typeof payouts === 'string') {
          try {
            payouts = JSON.parse(payouts);
          } catch {
            payouts = [];
          }
        }
        if (Array.isArray(payouts) && payouts.length > 0) {
          const totalPct = payouts.reduce((sum: number, p: any) => sum + (p.percentage || 0), 0);
          if (totalPct > 0 && Math.abs(totalPct - 100) > 0.01) {
            console.warn(
              `[Tournament:${this.tournamentId.slice(0, 8)}] WARNING: Payout percentages sum to ${totalPct}% (expected 100%). Normalizing.`
            );
            // Normalize percentages proportionally using exact truncation
            // Distribute remainder to 1st place to ensure sum = exactly 100
            let sumNormalized = 0;
            payouts = payouts.map((p: any, idx: number) => {
              const normalized = Math.trunc((p.percentage / totalPct) * 100 * 100) / 100;
              sumNormalized += normalized;
              return { ...p, percentage: normalized };
            });
            // Fix rounding remainder — assign to 1st place
            let remainder = 100 - sumNormalized;
            if (Math.abs(remainder) > 0.01 && payouts.length > 0) {
              payouts[0].percentage = Math.trunc((payouts[0].percentage + remainder) * 100) / 100;
            }
            await supabase
              .from('tournaments')
              .update({ payout_structure: payouts })
              .eq('id', this.tournamentId);
            // TOURNEY-AUDIT 2026-07-24: refresh the in-memory cache too —
            // recalculateEliminatedPrizes reads tournamentCache.payout_structure,
            // and before this line it kept the UN-normalized version, so
            // late-reg prize top-ups were computed off inflated percentages
            // (overpayment) whenever the configured structure didn't sum to 100.
            if (this.tournamentCache) this.tournamentCache.payout_structure = payouts;
          }
        }
      }

      // Start table engines
      for (const [tableId, engine] of this.tableEngines) {
        this.gameServer.registerTableEngine(tableId, engine);
        engine
          .start()
          .catch((err) => reportError(err, 'TournamentthistournamentIdslic.Table_engine_error'));
      }
      // Tournament tables are invisible to the cash-side zombie reaper — this
      // sweep is their only freeze recovery.
      this.startTableLivenessSweep();

      // Start blind timer
      this.startBlindTimer(tournament.blind_structure || []);

      // TOURNEY-AUDIT 2026-07-24 (sweep 4): with NO late-reg/rebuy window
      // configured (cap <= 0), the prize pool is final from the first hand —
      // but the finalization gate only fired when cap > 0, so prizePoolFinalized
      // stayed false forever and eliminated-prize top-ups never ran for these
      // tournaments (under-payment when the pool later moved, e.g. guarantees).
      {
        const lateRegCap = tournament.late_reg_levels ?? tournament.rebuy_levels ?? 8;
        if (!lateRegCap || lateRegCap <= 0) {
          this.prizePoolFinalized = true;
          const { error: fpErr } = await supabase
            .from('tournaments')
            .update({ prize_pool_finalized: true })
            .eq('id', this.tournamentId);
          if (fpErr && !/column|schema/i.test(fpErr.message || '')) {
            console.warn(
              `[Tournament:${this.tournamentId.slice(0, 8)}] prize_pool_finalized persist failed: ${fpErr.message}`
            );
          }
        }
      }

      // Start elimination checker
      this.startEliminationChecker();

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] RUNNING — ${this.tableEngines.size} tables`
      );
    } catch (err) {
      reportError(err, 'TournamentthistournamentIdslic.Start_failed');
      this.running = false;
    }
  }

  async resume(): Promise<void> {
    this.running = true;
    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] Resuming...`);

    try {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', this.tournamentId)
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

      if (!tournament) throw new Error('Tournament not found');

      if (typeof tournament.blind_structure === 'string') {
        try {
          tournament.blind_structure = JSON.parse(tournament.blind_structure);
        } catch {
          tournament.blind_structure = [];
        }
      }
      if (!Array.isArray(tournament.blind_structure)) {
        tournament.blind_structure = [];
      }

      this.tournamentCache = tournament;
      this.prizePoolFinalized = tournament.prize_pool_finalized || false;

      // Find existing tables
      const { data: tables } = await supabase
        .from('tables')
        .select('id')
        .eq('tournament_id', this.tournamentId)
        .in('status', ['running', 'waiting']);

      /**
       * Dan 2026-08-19: TOURNAMENTS RUN. THEY DO NOT CANCEL.
       *
       * A RUNNING tournament whose tables had all been closed used to be the
       * one case with no way back, which is why the boot sweep cancelled it.
       * There IS a way back: the entrants are still on the roster, so rebuild
       * the tables and seat them — exactly what start() does. A room that lost
       * a table redeals it; it does not void the tournament.
       */
      if (!tables || tables.length === 0) {
        const { count: liveEntrants } = await supabase
          .from('tournament_players')
          .select('id', { count: 'exact', head: true })
          .eq('tournament_id', this.tournamentId)
          .in('status', ['registered', 'playing']);

        if ((liveEntrants || 0) > 0) {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Resuming with NO open tables — rebuilding for ${liveEntrants} entrant(s) instead of abandoning the tournament`
          );
          await this.createTablesAndSeatPlayers(tournament);
        }
      } else {
        for (const table of tables) {
          const engine = new ServerTableEngine(table.id);
          engine.setHub(tableStateHub); // Phase 1.1 PR-2
          this.tableEngines.set(table.id, engine);
          this.gameServer.registerTableEngine(table.id, engine);
          engine
            .start()
            .catch((err) => reportError(err, 'TournamentthistournamentIdslic.Resume_table_error'));
        }
      }

      // Restore blind level
      this.currentLevel = tournament.current_level || 0;
      // Reset hand-for-hand state on resume so it can be triggered again
      this.handForHandActive = false;
      this.handForHandAnnounced = false;
      // TOURNEY-AUDIT 2026-07-24: restore add-on/finalization flags so a
      // restart mid-add-on doesn't re-broadcast ADDON_PERIOD_START or skip
      // finalizeAfterAddOn forever (they previously reset to defaults).
      this.addOnPeriodTriggered = !!tournament.addon_period_triggered;
      // Initialize broadcast channel on resume
      this.broadcastChannel = null;
      this.broadcastReady = false;
      // TOURNEY-AUDIT 2026-07-24: resume the level clock MID-LEVEL using the
      // persisted level_started_at instead of granting a fresh full level on
      // every restart (which nearly froze blind escalation across restarts).
      {
        const levelData =
          (tournament.blind_structure || [])[this.currentLevel] ||
          (tournament.blind_structure || [])[0];
        const durationMs = this.levelDurationMs(levelData);
        let remainingMs: number | undefined;
        if (tournament.level_started_at) {
          const elapsed = Date.now() - new Date(tournament.level_started_at).getTime();
          if (elapsed >= 0 && elapsed < durationMs * 4) {
            remainingMs = Math.max(1000, durationMs - elapsed);
          }
        }
        this.startBlindTimer(tournament.blind_structure || [], remainingMs);
      }
      this.startEliminationChecker();
      // Same contract on the resume path as on the start path: a resumed
      // tournament's tables must be rebuildable when their engine dies.
      this.startTableLivenessSweep();

      /**
       * Dan 2026-08-19: A RESTART MID-BREAK MUST NOT RESUME PLAY.
       *
       * The break pause lives on the engine instances. A redeploy throws those
       * away and resume() builds brand-new ones — which are NOT paused — while
       * `on_break` is still true in the database. The tournament then deals
       * straight through the rest of its own break. Observed live: the engine
       * restarted inside the 04:55 window (platform-wide hand volume dipped to
       * 89 and recovered the next minute) and both MTTs resumed dealing 13
       * seconds into a break the database still showed as running.
       *
       * Re-pause for whatever is left of the break and re-arm the resume, so
       * the break survives a deploy the same way its persisted state does.
       */
      if (tournament.on_break && tournament.break_ends_at) {
        const remainingMs = new Date(tournament.break_ends_at).getTime() - Date.now();
        if (remainingMs > 1000) {
          this.onBreak = true;
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Resumed DURING a break — re-pausing for the remaining ${Math.round(remainingMs / 1000)}s`
          );
          for (const engine of this.tableEngines.values()) {
            try {
              engine.pauseAfterHand(remainingMs + TournamentManagerBase.LAST_HAND_GRACE_MS);
            } catch (err) {
              reportError(err, 'TournamentManagerBase.resume_rebreak_pause');
            }
          }
          setTimeout(() => {
            void this.resumeFromBreak();
          }, remainingMs);
        } else {
          // The break already expired while we were down — clear the flag so
          // the lobby does not show a phantom break.
          this.onBreak = false;
          try {
            await supabase
              .from('tournaments')
              .update({ on_break: false, break_ends_at: null })
              .eq('id', this.tournamentId);
          } catch (err) {
            reportError(err, 'TournamentManagerBase.resume_clear_stale_break');
          }
        }
      }

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Resumed — ${this.tableEngines.size} tables, level ${this.currentLevel}`
      );
    } catch (err) {
      reportError(err, 'TournamentthistournamentIdslic.Resume_failed');
      this.running = false;
    }
  }

  stop(): void {
    // Clear intervals FIRST to prevent them firing during teardown
    if (this.blindTimer) {
      clearTimeout(this.blindTimer);
      this.blindTimer = null;
    }
    if (this.eliminationTimer) {
      clearInterval(this.eliminationTimer);
      this.eliminationTimer = null;
    }
    this.running = false;
    this.stopTableLivenessSweep();
    for (const engine of this.tableEngines.values()) {
      engine.stop();
    }
    this.tableEngines.clear();
    // Cleanup hand-for-hand sync
    this.stopHandForHandSync();
    if (this.handForHandRePauseTimer) {
      clearTimeout(this.handForHandRePauseTimer);
      this.handForHandRePauseTimer = null;
    }
    // Best-effort cleanup of broadcast channel (non-async in sync stop)
    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.unsubscribe();
      } catch {}
      this.broadcastChannel = null;
      this.broadcastReady = false;
    }
  }

  /**
   * IDEMPOTENT SEATING 2026-08-20.
   *
   * This used to INSERT a fresh set of tables every time it was called, and
   * seat the whole field into them, with no regard for tables the tournament
   * already had. start() calls it BEFORE the "only REGISTERING -> RUNNING"
   * status guard, so calling start() on a tournament that was already RUNNING
   * built a complete SECOND set of tables and re-seated everybody, leaving the
   * original tables live and seated.
   *
   * Measured in production 2026-08-20: "5 Chip Turbo SNG 6-Max NLH" held THREE
   * tables all named "Table 1" -- the real one from 20:20:53 (22 hands, dead
   * after the restart) plus duplicates at 20:33:58 and 20:34:04, each with six
   * live seats. Six players were seated twice, at tables dealing hands
   * concurrently with diverging stacks, so the field held 18,000 chips against
   * 9,000 issued. fn_tournament_chip_conservation_check flagged it at exactly
   * 2x.
   *
   * The duplicate seats also poison every "find this player's seat" lookup --
   * the chip sync and process_tournament_rebuy both have to choose one row.
   *
   * So the function now adopts what already exists:
   *   - tables the tournament already has are registered, not recreated;
   *   - only the SHORTFALL is created;
   *   - players who already hold a live seat are not re-seated;
   *   - new seats take the lowest free seat number on their table rather than
   *     a computed one that could collide with an occupied seat.
   *
   * Calling it twice is now a no-op, which is the property the boot path
   * needed all along.
   */
  /**
   * Is this a Spin whose stacks must wait for the wheel?
   *
   * Only true when there is actually going to BE a reveal — a spin with a
   * drawn multiplier. A spin that somehow reached start without one still gets
   * credited immediately, because the alternative is a table of players
   * holding zero chips forever waiting on a wheel that will never turn.
   */
  private async deferStacksForSpinReveal(tournament: any): Promise<boolean> {
    const variant = String(tournament?.variant ?? '').toLowerCase();
    const isSpin =
      variant === 'spin' || String(tournament?.tournament_type ?? '').toUpperCase() === 'SPIN';
    return isSpin && Number(tournament?.spin_multiplier) > 0;
  }

  /**
   * Write the tier's starting stack onto every occupied seat.
   *
   * Idempotent by construction: it only writes the value start already decided,
   * and only to seats that disagree. That matters because it runs from a timer
   * — a restart between the reveal and the credit must be recoverable by
   * simply calling it again.
   */
  protected async creditSeatStacks(tournament: any): Promise<number> {
    const target = Number(tournament?.starting_chips) || 0;
    if (target <= 0) return 0;
    const { data: seatRows } = await supabase
      .from('table_seats')
      .select('id, stack, tables!inner(tournament_id)')
      .is('left_at', null)
      .eq('tables.tournament_id', this.tournamentId);
    // Strictly RAISE, never lower: the legitimate case is a reservation seat
    // holding 0 (or a smaller placeholder tier) waiting on the drawn stack.
    // An early-bird seat (starting chips + bonus, 2026-08-22) sits ABOVE the
    // plain starting stack, and flattening it here would destroy the bonus.
    const stale = (seatRows ?? []).filter((r: any) => Number(r.stack) < target);
    if (stale.length === 0) return 0;
    const { error } = await supabase
      .from('table_seats')
      .update({ stack: target })
      .in(
        'id',
        stale.map((r: any) => r.id)
      );
    if (error) {
      reportError(
        new Error(`seat stack credit failed: ${error.message}`),
        'Tournament.' + this.tournamentId.slice(0, 8) + '.seat_stack_credit_failed'
      );
      return 0;
    }
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] Credited ${stale.length} seat(s) to ${target}`
    );
    return stale.length;
  }

  /**
   * THE ORDER AFTER THE WHEEL (Dan 2026-08-21).
   *
   *   "AFTER THE SPIN COMPLETES, CHIP STACKS GET ADDED, BUTTON RANDOMLY
   *    ASSIGNED AND THE SPIN STARTS!"
   *
   * Three beats, each with its own broadcast so the client can animate them
   * rather than discovering them in a state diff:
   *
   *   reveal ends  ->  spin_chips   stacks land on the felt
   *   +CHIP_DROP   ->  spin_button  the button is drawn, at random
   *   +BUTTON_DRAW ->  the hold expires and the engine deals
   *
   * The timers are fire-and-forget but every one of them re-checks that the
   * tournament is still live, because a cancelled or completed game must not
   * have chips written into it seconds later.
   */
  private scheduleSpinPostReveal(tournament: any, revealAt: number): void {
    const chipsAt = revealAt + spinRevealTotalMs();
    const buttonAt = chipsAt + SPIN_REVEAL.CHIP_DROP_MS;
    const stillLive = () => this.isRunning() && this.tableEngines.size > 0;

    const later = (whenMs: number, fn: () => Promise<void>) => {
      const delay = Math.max(0, whenMs - Date.now());
      const timer = setTimeout(() => {
        if (!stillLive()) return;
        void fn().catch((err) =>
          reportError(err, 'Tournament.' + this.tournamentId.slice(0, 8) + '.spin_post_reveal')
        );
      }, delay);
      // Never hold the process open for theatre.
      if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
    };

    // ── Beat 1: the chips arrive. ──────────────────────────────────────────
    later(chipsAt, async () => {
      const credited = await this.creditSeatStacks(tournament);
      const stack = Number(tournament?.starting_chips) || 0;
      for (const [tableId] of this.tableEngines) {
        try {
          tableStateHub.emitEvent(tableId, {
            type: 'spin_chips',
            table_id: tableId,
            tournament_id: this.tournamentId,
            starting_stack: stack,
            seats_credited: credited,
            timestamp: Date.now(),
          });
        } catch {
          /* theatre */
        }
      }
    });

    // ── Beat 2: the button is DRAWN. ───────────────────────────────────────
    later(buttonAt, async () => {
      for (const [tableId, engine] of this.tableEngines) {
        try {
          const seats = engine.getOccupiedSeatNumbers();
          if (seats.length === 0) continue;
          /**
           * Random, not lowest-seat. The default first button was
           * `sortedSeats[0]`, which on a 3-handed Spin quietly hands a
           * positional edge to whoever took the low seat — and in a seat-first
           * format that is whoever clicked first.
           */
          const seat = seats[Math.floor(Math.random() * seats.length)];
          engine.setFirstButtonSeat(seat);
          tableStateHub.emitEvent(tableId, {
            type: 'spin_button',
            table_id: tableId,
            tournament_id: this.tournamentId,
            dealer_seat: seat,
            timestamp: Date.now(),
          });
        } catch (err) {
          // A missing button draw is survivable: the engine falls back to its
          // normal rotation. A throw here is not.
          reportError(err, 'Tournament.' + this.tournamentId.slice(0, 8) + '.spin_button_draw');
        }
      }
    });

    // ── Safety net. ────────────────────────────────────────────────────────
    // If beat 1 was missed (restart, transient DB error) the table would sit
    // with zero-chip seats and no hand could ever start. Re-credit shortly
    // after dealing is due; idempotent, so a healthy table writes nothing.
    later(buttonAt + SPIN_REVEAL.BUTTON_DRAW_MS + 1500, async () => {
      const healed = await this.creditSeatStacks(tournament);
      if (healed > 0) {
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Post-reveal safety net credited ${healed} seat(s)`
        );
      }
    });
  }

  protected async createTablesAndSeatPlayers(tournament: any): Promise<void> {
    const { data: players } = await supabase
      .from('tournament_players')
      .select('user_id, chips')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'playing');

    if (!players || players.length === 0) throw new Error('No players');

    // What this tournament ALREADY has.
    const { data: existingTables } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', this.tournamentId)
      .in('status', ['running', 'waiting'])
      .order('created_at', { ascending: true });

    const { data: liveSeatRows } = await supabase
      .from('table_seats')
      .select('user_id, table_id, seat_number, tables!inner(tournament_id)')
      .is('left_at', null)
      .eq('tables.tournament_id', this.tournamentId);

    const alreadySeated = new Set((liveSeatRows ?? []).map((r: any) => r.user_id));
    const occupiedSeats = new Map<string, Set<number>>();
    for (const r of liveSeatRows ?? []) {
      const row = r as any;
      if (!occupiedSeats.has(row.table_id)) occupiedSeats.set(row.table_id, new Set());
      occupiedSeats.get(row.table_id)!.add(row.seat_number);
    }

    for (const t of existingTables ?? []) {
      if (this.tableEngines.has(t.id)) continue;
      const engine = new ServerTableEngine(t.id);
      engine.setHub(tableStateHub);
      this.tableEngines.set(t.id, engine);
      this.gameServer.registerTableEngine(t.id, engine);
      engine
        .start()
        .catch((err) =>
          reportError(err, 'TournamentthistournamentIdslic.Adopted_table_engine_error')
        );
    }
    if ((existingTables ?? []).length > 0) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Adopted ${(existingTables ?? []).length} existing table(s) instead of creating duplicates`
      );
    }

    // Determine table size based on tournament type
    let maxPerTable = tournament.max_players || 9;
    const tType = (tournament.tournament_type || '').toUpperCase();
    const variant = (tournament.variant || '').toLowerCase();
    if (variant === 'spin' || tType === 'SPIN') {
      maxPerTable = 3;
    } else if (variant === 'sng' || tType === 'SNG') {
      maxPerTable = Math.min(tournament.max_players || 6, 9);
    } else {
      // table_size (2026-08-22 parity): seats per table INSIDE the MTT.
      // Clamped to the same 2-10 range fn_create_tournament enforces.
      maxPerTable = Math.min(10, Math.max(2, Number(tournament.table_size) || 9));
    }
    const numTables = Math.ceil(players.length / maxPerTable);
    const alreadyHave = (existingTables ?? []).length;
    const tablesToCreate = Math.max(0, numTables - alreadyHave);

    for (let i = alreadyHave; i < alreadyHave + tablesToCreate; i++) {
      const blindStructure = tournament.blind_structure || [];
      const firstLevel = blindStructure[0] || { smallBlind: 10, bigBlind: 20 };

      const { data: table, error } = await supabase
        .from('tables')
        .insert({
          club_id: tournament.club_id,
          tournament_id: this.tournamentId,
          name: `${tournament.name} - Table ${i + 1}`,
          game_type: 'tournament',
          game_variant: tournament.game_type?.toLowerCase() || 'nlh',
          stakes: `${firstLevel.smallBlind}/${firstLevel.bigBlind}`,
          small_blind: firstLevel.smallBlind,
          big_blind: firstLevel.bigBlind,
          ante: firstLevel.ante || 0,
          min_buy_in: 0,
          max_buy_in: 0,
          max_players: maxPerTable,
          current_players: 0,
          status: 'running',
          // 2026-08-22 parity: tournament tables inherit the tournament's
          // action clock, big-blind-ante mode and all-in-or-fold rule.
          // HandController already honors all three from the tables row.
          action_time_seconds: tournament.action_time_seconds || 15,
          big_blind_ante_enabled: tournament.big_blind_ante === true,
          all_in_or_fold: tournament.all_in_or_fold === true,
        })
        .select()
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single

      if (error || !table) {
        reportError(error, 'TournamentthistournamentIdslic.Failed_to_create_table');
        continue;
      }

      const engine = new ServerTableEngine(table.id);
      engine.setHub(tableStateHub); // Phase 1.1 PR-2
      this.tableEngines.set(table.id, engine);
    }

    // Round-robin seat ONLY the players who are not already sitting somewhere
    // in this tournament. Re-seating a seated player is what produced the
    // duplicate-seat rows described above.
    const tableIds = [...this.tableEngines.keys()];
    const toSeat = players.filter((p: any) => !alreadySeated.has(p.user_id));
    if (toSeat.length < players.length) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] ${players.length - toSeat.length} player(s) already seated — seating the remaining ${toSeat.length}`
      );
    }
    for (let i = 0; i < toSeat.length; i++) {
      const tableId = tableIds[i % tableIds.length];
      // Lowest free seat on that table, so a new seat can never collide with
      // one an adopted table is already using.
      const taken = occupiedSeats.get(tableId) ?? new Set<number>();
      let seatNumber = 1;
      while (taken.has(seatNumber)) seatNumber++;
      taken.add(seatNumber);
      occupiedSeats.set(tableId, taken);

      const { error: seatErr } = await supabase.from('table_seats').insert({
        table_id: tableId,
        user_id: toSeat[i].user_id,
        seat_number: seatNumber,
        stack: toSeat[i].chips || tournament.starting_chips,
        joined_at: new Date().toISOString(),
      });
      if (seatErr) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Failed to seat ${toSeat[i].user_id.slice(0, 8)}: ${seatErr.message}`
          ),
          'TournamentthistournamentIdslic.Failed_to_seat_playersiuser_id'
        );
      }
    }

    // Update player counts
    for (const tableId of tableIds) {
      const { count } = await supabase
        .from('table_seats')
        .select('*', { count: 'exact', head: true })
        .eq('table_id', tableId)
        .is('left_at', null);
      await supabase
        .from('tables')
        .update({ current_players: count || 0 })
        .eq('id', tableId);
    }
  }

  /**
   * TOURNEY-AUDIT 2026-07-24: `remainingOverrideMs` lets resume() arm the timer
   * with the level's REMAINING time (derived from the persisted
   * tournaments.level_started_at) instead of a fresh full duration. Previously
   * every crash/restart granted a brand-new full level at the current blinds —
   * restart-heavy windows nearly froze blind escalation.
   */
  /**
   * 2026-08-15 CRITICAL FIX — tournament tables had NO freeze recovery.
   *
   * GameServer.discoverCashTables is the only thing that rebuilds a dead engine,
   * and its readiness RPC (`cash_tables_with_players`) filters on
   * `tournament_id IS NULL`. So when a tournament table's engine died — its own
   * watchdog escalating to killForRestart, or a crashed dealing loop — the
   * reaper deleted it from the map and NOTHING recreated it. `getTableEngine`
   * then returned undefined, so POST /action answered 404 and reconnecting
   * clients were refused at the WS upgrade gate. Every seated player was frozen
   * permanently, with a RUNNING tournament above them.
   *
   * This sweep gives tournament tables the same liveness contract the cash side
   * has. It runs on the hand-for-hand interval that already ticks every cycle.
   */
  /** Start the tournament-side table liveness sweep (idempotent). */
  protected startTableLivenessSweep(): void {
    if (this.tableLivenessInterval) return;
    this.tableLivenessInterval = setInterval(() => {
      if (!this.running) {
        this.stopTableLivenessSweep();
        return;
      }
      void this.reviveDeadTableEngines();
    }, 20_000);
  }

  protected stopTableLivenessSweep(): void {
    if (this.tableLivenessInterval) {
      clearInterval(this.tableLivenessInterval);
      this.tableLivenessInterval = null;
    }
  }

  protected async reviveDeadTableEngines(): Promise<void> {
    if (this.revivingTables) return;
    /**
     * Dan 2026-08-19: NEVER revive during a synchronized break.
     *
     * A break is five minutes of deliberate silence, but this sweep rebuilt any
     * engine idle for more than 180 SECONDS. So three minutes into every break
     * it declared every paused table "dead", tore it down and replaced it with
     * a FRESH engine — and a fresh engine is not paused, so it started dealing
     * again. The sweep was fighting the break and winning.
     *
     * Paused is not dead. Skip the sweep entirely while on break; it resumes
     * its normal duty the moment play does.
     */
    if (this.onBreak) return;
    this.revivingTables = true;
    try {
      for (const [tableId, engine] of this.tableEngines) {
        // Belt and braces alongside the onBreak guard above: a table parked on
        // purpose (break OR hand-for-hand) is healthy — but only for as long as
        // a legitimate pause lasts. Past that ceiling it is wedged, and must be
        // rebuilt rather than left frozen forever.
        const parkedOnPurpose =
          engine.isPausedByDesign() &&
          engine.msPaused() <= TournamentManagerBase.MAX_HEALTHY_PAUSE_MS;
        const dead =
          !engine.isRunning() || (!parkedOnPurpose && engine.msSinceProgress() > 180_000);
        if (!dead) continue;
        reportError(
          new Error(
            'Tournament table engine dead for ' +
              Math.round(engine.msSinceProgress() / 1000) +
              's (running=' +
              engine.isRunning() +
              ') — rebuilding'
          ),
          'Tournament.' + this.tournamentId.slice(0, 8) + '.table_engine_rebuilt',
          { tableId }
        );
        try {
          // Await the stop: its tail cancels scheduler entries keyed by
          // (tableId, eventId), which the replacement engine reuses. Letting it
          // run late would cancel the NEW engine's heartbeat and turn timer.
          await engine.stop();
        } catch {
          /* already dead */
        }
        const fresh = new ServerTableEngine(tableId);
        fresh.setHub(tableStateHub);
        this.tableEngines.set(tableId, fresh);
        this.gameServer.registerTableEngine(tableId, fresh);
        fresh
          .start()
          .catch((err) => reportError(err, 'Tournament.table_engine_restart_failed', { tableId }));
      }
    } catch (err) {
      reportError(err, 'Tournament.' + this.tournamentId.slice(0, 8) + '.revive_sweep_threw');
    } finally {
      this.revivingTables = false;
    }
  }

  /**
   * SPIN LEVELS 2026-08-21: level length in ms, format-normalized. Blind
   * structures carry their length as `durationMinutes` (MTT/SNG configs),
   * `duration_minutes` (snake-case writers), or `duration` in SECONDS (the
   * spin spec, mirrored client/server). The timer arms read ONLY
   * `durationMinutes || 10`, so every spin level silently became 10 minutes
   * — observed live: spins started 02:27Z levelled up at exactly +10:00
   * against Dan's 3-minute spec. The client masthead already normalizes all
   * three formats; this is the engine-side twin.
   */
  protected levelDurationMs(levelData: any): number {
    const mins = Number(levelData?.durationMinutes ?? levelData?.duration_minutes);
    let baseMs = 10 * 60 * 1000;
    if (Number.isFinite(mins) && mins > 0) {
      baseMs = mins * 60 * 1000;
    } else {
      const secs = Number(levelData?.duration);
      if (Number.isFinite(secs) && secs > 0) baseMs = secs * 1000;
    }
    // ACCELERATED MTT (2026-08-22 parity): once late registration has closed,
    // an accelerated tournament halves every remaining level — ceil(min/2).
    if (this.tournamentCache?.accelerated_mtt === true && this.isLateRegClosed()) {
      return acceleratedLevelMs(baseMs);
    }
    return baseMs;
  }

  protected startBlindTimer(blindStructure: any[], remainingOverrideMs?: number): void {
    if (blindStructure.length === 0) return;
    const currentLevelData = blindStructure[this.currentLevel] || blindStructure[0];
    const durationMs = this.levelDurationMs(currentLevelData);
    const armMs =
      remainingOverrideMs !== undefined
        ? Math.min(Math.max(1000, remainingOverrideMs), durationMs)
        : durationMs;
    // Back-date the in-memory start so break pause/resume math stays correct
    this.blindTimerStartedAt = Date.now() - (durationMs - armMs);
    this.blindTimer = setTimeout(() => {
      // Without the catch, a throw inside advanceBlindLevel becomes an
      // unhandled rejection AND the level silently fails to advance with no
      // trace of why.
      void this.advanceBlindLevel(blindStructure).catch((err: unknown) => {
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] advanceBlindLevel threw: ${(err as Error)?.message ?? err}`
        );
      });
    }, armMs);
    // Persist the level clock (wall-clock start of THIS level's remaining
    // window) so a restart resumes the level mid-flight. Fire-and-forget; the
    // column is added by migration 20260724c (graceful if absent).
    void Promise.resolve(
      supabase
        .from('tournaments')
        .update({ level_started_at: new Date(this.blindTimerStartedAt).toISOString() })
        .eq('id', this.tournamentId)
    )
      .then(({ error }: { error: { message?: string } | null }) => {
        if (error && !/column|schema/i.test(error.message || '')) {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] level_started_at persist failed: ${error.message}`
          );
        }
      })
      .catch((err: unknown) => {
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] level_started_at persist threw: ${(err as Error)?.message ?? err}`
        );
      });
  }

  /**
   * AUDIT FIX 2026-07-19: the full level-transition (write blinds to every
   * table, persist current_level, emit level_up, chip race, late-reg / add-on
   * checks) extracted so BOTH the normal blind timer AND resumeFromBreak run it.
   * Previously resumeFromBreak hand-rolled a timer that only did currentLevel++
   * without touching table blinds — so the post-break level-up was swallowed and
   * escalation could freeze entirely.
   */
  protected async advanceBlindLevel(blindStructure: any[]): Promise<void> {
    {
      {
        if (!this.running) return;
        const prevLevel = this.currentLevel;
        this.currentLevel++;

        if (this.currentLevel >= blindStructure.length) {
          // Auto-escalate: double the last level's blinds
          // FIX: Cap at 10M to prevent numeric field overflow in DECIMAL(10,2) columns
          const MAX_BLIND_VALUE = 10_000_000;
          const lastLevel = blindStructure[blindStructure.length - 1];
          const escalationFactor = Math.pow(2, this.currentLevel - blindStructure.length + 1);
          const autoLevel = {
            level: this.currentLevel + 1,
            smallBlind: Math.min(lastLevel.smallBlind * escalationFactor, MAX_BLIND_VALUE),
            bigBlind: Math.min(lastLevel.bigBlind * escalationFactor, MAX_BLIND_VALUE),
            ante: Math.min((lastLevel.ante || 0) * escalationFactor, MAX_BLIND_VALUE),
            // Keep same duration (format-normalized), min 2 min
            durationMinutes: Math.max(this.levelDurationMs(lastLevel) / 60000, 2),
          };
          blindStructure.push(autoLevel);
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Auto-escalated blinds: ${autoLevel.smallBlind}/${autoLevel.bigBlind} ante ${autoLevel.ante}`
          );
        }

        const level = blindStructure[Math.min(this.currentLevel, blindStructure.length - 1)];

        // Skip any break entries that might still be in old blind structures
        if (level.isBreak) {
          this.startBlindTimer(blindStructure);
          return;
        }

        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Level ${this.currentLevel}: ${level.smallBlind}/${level.bigBlind} ante ${level.ante || 0}`
        );

        for (const tableId of this.tableEngines.keys()) {
          // FIX: Clamp values before DB write to prevent numeric field overflow
          const MAX_DB_BLIND = 10_000_000;
          const safeSmallBlind = Math.min(level.smallBlind || 0, MAX_DB_BLIND);
          const safeBigBlind = Math.min(level.bigBlind || 0, MAX_DB_BLIND);
          const safeAnte = Math.min(level.ante || 0, MAX_DB_BLIND);
          const { error: blindErr } = await supabase
            .from('tables')
            .update({
              small_blind: safeSmallBlind,
              big_blind: safeBigBlind,
              ante: safeAnte,
            })
            .eq('id', tableId);
          if (blindErr) {
            const blindMsg = blindErr.message?.includes('<!DOCTYPE html>')
              ? 'Cloudflare/Supabase HTML Error (502/504)'
              : blindErr.message || JSON.stringify(blindErr) || 'Unknown error';
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Blind update failed for table ${tableId.slice(0, 8)}: ${blindMsg}`
              ),
              'TournamentthistournamentIdslic.Blind_update_failed_for_table_'
            );
          }

          // Phase X5 (2026-04-28): emit level_up discrete event so clients
          // can trigger the level-up popup + sound + haptic per Bible V8 §5
          // (UI/Popup/Animation/Sound/Haptic Doctrine). Without this, clients
          // must infer level escalation from a state-snapshot diff, which
          // violates Law 1.16 Real-Time Delivery.
          try {
            tableStateHub.emitEvent(tableId, {
              type: 'level_up',
              table_id: tableId,
              tournament_id: this.tournamentId,
              new_level: this.currentLevel,
              previous_level: prevLevel,
              small_blind: level.smallBlind,
              big_blind: level.bigBlind,
              ante: level.ante || 0,
              duration_minutes: level.durationMinutes,
              timestamp: Date.now(),
            });
          } catch {
            /* hub broadcast failure is non-fatal */
          }
        }

        const { error: levelErr } = await supabase
          .from('tournaments')
          .update({ current_level: this.currentLevel })
          .eq('id', this.tournamentId);
        if (levelErr)
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Level persist failed: ${levelErr.message}`
            ),
            'TournamentthistournamentIdslic.Level_persist_failed'
          );

        // FIX-B (chip race) 2026-07-19 — DISABLED. Two independent audits found
        // this block actively corrupts chip integrity and it has no purpose in a
        // digital engine (stacks are exact integers; there are no physical chips
        // to "color up"). The prior logic (a) triggered on `smallBlind >
        // prevSmallBlind`, i.e. almost EVERY level, treating the small blind as a
        // chip denomination (it is not) and running `stack % smallBlind` which
        // mints/destroys chips each level; and (b) wrote the raced stack back
        // scoped ONLY by user_id (not table_id), overwriting the SAME user's
        // stack at any other cash/tournament table — cross-table chip corruption.
        // Re-enable only behind a real denomination-removal schedule + a
        // table-scoped write-back + a chips-in-play conservation assertion.
        const CHIP_RACE_ENABLED = false;
        const prevLevelData = blindStructure[prevLevel] || blindStructure[0];
        const prevSmallBlind = prevLevelData?.smallBlind || level.smallBlind;
        if (CHIP_RACE_ENABLED && level.smallBlind > prevSmallBlind) {
          try {
            // Gather all tournament player stacks across all tables
            const playerStacks = new Map<string, number>();
            for (const tableId of this.tableEngines.keys()) {
              const { data: seats } = await supabase
                .from('table_seats')
                .select('user_id, stack')
                .eq('table_id', tableId)
                .is('left_at', null);
              for (const seat of seats || []) {
                if (seat.stack > 0) playerStacks.set(seat.user_id, seat.stack);
              }
            }
            if (playerStacks.size >= 2) {
              const result = this.chipRaceEngine.executeChipRace(
                this.tournamentId,
                playerStacks,
                prevSmallBlind,
                level.smallBlind
              );
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Chip race: removed ${prevSmallBlind} denomination, ${result.totalNewChipsDistributed} chips redistributed to ${result.players.filter((p) => p.chipsAwarded > 0).length} players`
              );
              // Update table_seats with new stacks after chip race
              for (const [userId, newStack] of playerStacks) {
                await supabase
                  .from('table_seats')
                  .update({ stack: newStack })
                  .eq('user_id', userId)
                  .is('left_at', null);
              }
              await this.broadcast('chip_race', {
                removedDenomination: prevSmallBlind,
                newSmallestDenomination: level.smallBlind,
                playersAffected: result.players.filter((p) => p.chipsAwarded > 0).length,
              });
            }
          } catch (crErr) {
            reportError(crErr, 'TournamentthistournamentIdslic.Chip_race_error');
          }
        }

        // Broadcast level_up event to all table pages
        await this.broadcast('level_up', {
          level: this.currentLevel,
          blinds: `${level.smallBlind}/${level.bigBlind}`,
          smallBlind: level.smallBlind,
          bigBlind: level.bigBlind,
          ante: level.ante || 0,
        });

        // ── LATE REG / REBUY PERIOD FINALIZATION (level-based) ──
        // Late reg and rebuy share the same cutoff level
        const lateRegLevelCap =
          this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 0;
        if (
          !this.prizePoolFinalized &&
          lateRegLevelCap > 0 &&
          this.currentLevel >= lateRegLevelCap
        ) {
          // Check if add-on is available — if so, defer finalization until add-on period ends
          if (!this.tournamentCache?.add_on_available) {
            this.prizePoolFinalized = true;
            const { data: freshT } = await supabase
              .from('tournaments')
              .select('prize_pool')
              .eq('id', this.tournamentId)
              .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
            if (freshT) {
              await supabase
                .from('tournaments')
                .update({
                  prize_pool: freshT.prize_pool,
                  prize_pool_finalized: true,
                } as any)
                .eq('id', this.tournamentId);
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Late reg/rebuy closed at level ${this.currentLevel} — prize pool finalized: ${freshT.prize_pool}`
              );
            }
            await this.broadcast('late_reg_closed', { prizePool: freshT?.prize_pool || 0 });
            if (freshT) {
              await this.recalculateEliminatedPrizes(freshT.prize_pool);
            }
          }
        }

        // ── ADD-ON PERIOD TRIGGER (level-based) ──
        // When blind level passes the late reg/rebuy cutoff and add-on is available
        if (this.tournamentCache?.add_on_available && !this.addOnPeriodTriggered) {
          const rebuyLevelCap =
            this.tournamentCache.late_reg_levels ?? this.tournamentCache.rebuy_levels ?? 8;
          if (prevLevel < rebuyLevelCap && this.currentLevel >= rebuyLevelCap) {
            // Broadcast late_reg_closed first
            await this.broadcast('late_reg_closed', {});
            // If currently on break, defer the add-on trigger until break resumes
            if (this.onBreak) {
              this.pendingAddOnPeriod = true;
            } else {
              await this.triggerAddOnPeriod();
            }
          }
        }

        // ── ADD-ON PERIOD END (level-based) ──
        // Add-on window closes after addon_levels levels past the rebuy cutoff
        if (this.addOnPeriodTriggered && !this.prizePoolFinalized) {
          const rebuyLevelCap2 =
            this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 8;
          const addonWindow = this.tournamentCache?.addon_levels ?? 1;
          if (this.currentLevel >= rebuyLevelCap2 + addonWindow) {
            await this.finalizeAfterAddOn();
          }
        }

        // Schedule the next level (waits the new level's duration, then advances)
        this.startBlindTimer(blindStructure);
      }
    }
  }

  /**
   * Horses take their add-on when the add-on period opens.
   *
   * Add-ons had NEVER executed in production before this was wired up - the
   * 'addon' wallet_transactions category had no rows in the entire life of the
   * platform - because process_tournament_rebuy's only caller was the SPA and
   * there are no human players yet. The window opened, ADDON_PERIOD_START
   * fired, and nothing ever bought one.
   *
   * Only players holding a LIVE SEAT are offered it. A player between seats
   * during table consolidation has none, and process_tournament_rebuy refuses
   * those outright - because charging them used to grant chips that the seat
   * sync immediately erased (103 add-ons charged on the first window ever run,
   * ~91 of them delivering nothing). Filtering here keeps the refusals out of
   * the log instead of generating one per player.
   *
   * Add-ons are NOT raked, per Dan's rule, so the call books no rake row and
   * the whole amount reaches the prize pool. Horses only; a real player's
   * add-on stays their own decision.
   *
   * NOTE TO ANYONE REWRITING THIS FILE: this method has now been dropped three
   * times by whole-file rewrites built from a stale working copy. It is pinned
   * by TournamentFixes.guard.test.ts, which runs in the deploy gate - if it
   * disappears again the deploy fails rather than the feature silently dying.
   */
  protected async tryTournamentAddOns(): Promise<void> {
    if (!this.tournamentCache?.add_on_available) return;
    try {
      const { data: rows, error: rowsErr } = await supabase
        .from('tournament_players')
        .select('user_id, add_on')
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');
      if (rowsErr || !rows || rows.length === 0) return;

      const withoutAddOn = rows
        .filter((r: { add_on?: boolean | null }) => !r.add_on)
        .map((r: { user_id: string }) => r.user_id);
      if (withoutAddOn.length === 0) return;

      const { data: seatRows } = await supabase
        .from('table_seats')
        .select('user_id, tables!inner(tournament_id)')
        .is('left_at', null)
        .eq('tables.tournament_id', this.tournamentId);
      const seated = new Set((seatRows ?? []).map((r: { user_id: string }) => r.user_id));
      const candidates = withoutAddOn.filter((id) => seated.has(id));
      if (candidates.length === 0) return;

      const { data: horseRows } = await supabase
        .from('profiles')
        .select('id')
        .in('id', candidates)
        .eq('is_horse', true);
      if (!horseRows || horseRows.length === 0) return;

      let taken = 0;
      const declined = new Map<string, number>();
      for (const h of horseRows) {
        const { data, error } = await supabase.rpc('process_tournament_rebuy', {
          p_tournament_id: this.tournamentId,
          p_user_id: h.id,
          p_rebuy_type: 'addon',
          // null: let the server price it (add-ons are charged at face value).
          p_cost: null,
          p_chips: null,
          p_current_level: this.currentLevel,
        });
        if (error) {
          declined.set(error.message, (declined.get(error.message) || 0) + 1);
          continue;
        }
        if ((data as { success?: boolean } | null)?.success === true) taken++;
      }

      // Quiet when nothing happened: this is called repeatedly across the
      // window, so an unconditional line would be pure noise.
      if (taken > 0 || declined.size > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ADD-ONS: ${taken} taken` +
            (declined.size > 0
              ? ` — declined: ${[...declined.entries()].map(([m, n]) => `${m} x${n}`).join(', ')}`
              : '')
        );
      }
    } catch (err) {
      reportError(err, 'Tournament.tournament_addon_threw');
    }
  }

  protected async triggerAddOnPeriod(): Promise<void> {
    if (this.addOnPeriodTriggered) return;
    this.addOnPeriodTriggered = true;

    // TOURNEY-AUDIT 2026-07-24: persist the flag so a restart mid-add-on
    // restores it (resume() reads addon_period_triggered) instead of
    // re-broadcasting ADDON_PERIOD_START and losing finalizeAfterAddOn.
    void Promise.resolve(
      supabase
        .from('tournaments')
        .update({ addon_period_triggered: true })
        .eq('id', this.tournamentId)
    )
      .then(({ error }: { error: { message?: string } | null }) => {
        if (error && !/column|schema/i.test(error.message || '')) {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] addon_period_triggered persist failed: ${error.message}`
          );
        }
      })
      .catch((err: unknown) => {
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] addon_period_triggered persist threw: ${(err as Error)?.message ?? err}`
        );
      });

    const addonCost = this.tournamentCache?.addon_cost || this.tournamentCache?.buy_in_amount || 0;
    const addonChips =
      this.tournamentCache?.addon_chips || this.tournamentCache?.starting_chips || 0;
    const addonLevels = this.tournamentCache?.addon_levels ?? 1;
    const rebuyLevelCap =
      this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 8;

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] ADD-ON PERIOD START — ${addonLevels} level(s) (Level ${rebuyLevelCap} to ${rebuyLevelCap + addonLevels}), cost: ${addonCost}, chips: ${addonChips}`
    );

    // Broadcast ADDON_PERIOD_START via Supabase Realtime (no fixed duration — level-based)
    await this.broadcast('ADDON_PERIOD_START', {
      addOnCost: addonCost,
      addOnChips: addonChips,
      addonLevels,
      startLevel: rebuyLevelCap,
      endLevel: rebuyLevelCap + addonLevels,
    });

    // ADD-ON BREAK (2026-08-22 parity): the add-on window opens with a short
    // pause so the field can take its add-on between hands. Length comes from
    // tournaments.addon_break_minutes (clamped 1-10 at creation), never a
    // hardcoded value. A synchronized break or hand-for-hand already owns the
    // pause state when active, so this stands down rather than fighting them.
    const addonBreakMinutes = Math.min(
      10,
      Math.max(1, Number(this.tournamentCache?.addon_break_minutes) || 1)
    );
    if (!this.onBreak && !this.handForHandActive) {
      const breakMs = addonBreakMinutes * 60 * 1000;
      for (const engine of this.tableEngines.values()) {
        try {
          engine.pauseAfterHand(breakMs + TournamentManagerBase.LAST_HAND_GRACE_MS);
        } catch (err) {
          reportError(err, 'TournamentManagerBase.addon_break_pause');
        }
      }
      await this.broadcast('addon_break', {
        breakDurationMinutes: addonBreakMinutes,
        breakEndsAt: new Date(Date.now() + breakMs).toISOString(),
      });
      const resumeTimer = setTimeout(() => {
        // A synchronized break or the bubble sync may have taken over the
        // pause state during the add-on break — leave the pause to them.
        if (!this.running || this.onBreak || this.handForHandActive) return;
        for (const engine of this.tableEngines.values()) {
          try {
            engine.resumeDealing();
          } catch (err) {
            reportError(err, 'TournamentManagerBase.addon_break_resume');
          }
        }
      }, breakMs);
      if (typeof (resumeTimer as any)?.unref === 'function') (resumeTimer as any).unref();
    }

    // Offer the add-on to the field now that the window is open.
    await this.tryTournamentAddOns();

    // NOTE: Add-on period end is now handled by the level-up handler (finalizeAfterAddOn)
    // No more hardcoded 60-second timer!
  }

  protected async finalizeAfterAddOn(): Promise<void> {
    if (this.prizePoolFinalized) return;

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] ADD-ON PERIOD ENDED at level ${this.currentLevel} — finalizing prize pool`
    );

    this.prizePoolFinalized = true;
    const { data: freshT } = await supabase
      .from('tournaments')
      .select('prize_pool')
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
    if (freshT) {
      await supabase
        .from('tournaments')
        .update({
          prize_pool: freshT.prize_pool,
          prize_pool_finalized: true,
        } as any)
        .eq('id', this.tournamentId);

      await this.recalculateEliminatedPrizes(freshT.prize_pool);
    }

    await this.broadcast('ADDON_PERIOD_END', {});
  }

  protected isProcessingEliminations = false;

  // ── Implemented by TournamentManagerEliminations (layer 2/3) ──
  protected abstract startEliminationChecker(): void;
  protected abstract recalculateEliminatedPrizes(finalPrizePool: number): Promise<void>;
}
