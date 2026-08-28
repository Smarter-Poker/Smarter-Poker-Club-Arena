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
import { clampSeatsForVariant } from '../config/tableSeating.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import { refundAndCloseCancelledTournament } from './tournamentRecovery.js';
import { acceleratedLevelMs } from './acceleratedLevels.js';
import { isShortFormat, mayTakeSynchronizedBreak } from './breakEligibility.js';
import { escalatedBlindLevel, lastPlayableIndex } from './blindEscalation.js';
import { secureRandomInt } from '../engine/CryptoRandom.js';
import {
  DEFAULT_TOP_BOUNTY_PERCENT,
  resolveMysteryBountyProfile,
} from '../config/mysteryBountySpec.js';
import { buildInventory, poolCentsFromNumeric } from './mysteryBountyPool.js';
import { shuffleChests } from './mysteryBountyDraw.js';
import {
  mysteryPoolCents,
  shouldActivateMysteryBounty,
  type MysteryBountyActivationMode,
  type MysteryBountyStage,
} from './mysteryBountyActivation.js';
import { mayTakeSeat } from './seatClaim.js';
import type { GameServer } from '../GameServer.js';

/** How many places this payout structure pays, whichever shape it arrived in. */
function countPaidPlaces(structure: unknown): number {
  if (Array.isArray(structure)) return structure.length;
  if (typeof structure === 'string') {
    try {
      const parsed = JSON.parse(structure);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

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
  /**
   * Latch so an unusable payout_structure is reported once per tournament
   * rather than on every elimination sweep. The condition is a stored column,
   * not a transient read, so it is true on every pass until somebody fixes it.
   */
  protected payoutStructureUnreadableReported: boolean = false;
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
  /**
   * The platform-wide break, MIRRORED from GameServer.BREAK_DURATION_MS.
   *
   * It cannot be imported: GameServer imports TournamentManager, so a value
   * import here would close a module cycle (the existing GameServer import in
   * this file is deliberately `import type`). TournamentFixes.guard.test.ts
   * asserts the two literals still agree, so the mirror cannot drift.
   *
   * Used by resume() to reconstruct how much of a break is left when the row
   * carries no end time yet -- see the break-recovery block there.
   */
  static readonly BREAK_DURATION_MS = 5 * 60 * 1000;
  protected savedBlindTimerRemaining: number = 0;
  protected blindTimerStartedAt: number = 0;
  /**
   * True once beginBreakCountdown has stamped an end time on THIS break.
   *
   * GameServer calls beginBreakCountdown from two places -- once per break in
   * triggerSynchronizedBreak, and again from holdIfBreakIsRunning for any
   * tournament that starts while a break is live. pauseForBreak already
   * no-ops for a tournament that is on break; this did not, so the second call
   * re-stamped break_ends_at further into the future and EXTENDED a break the
   * lobby had already told players would end. A countdown, once started, is
   * never restarted. Cleared by pauseForBreak (a new break) and by
   * resumeFromBreak (this one is over).
   */
  protected breakCountdownStarted: boolean = false;
  // Hand-for-hand sync
  protected handForHandSyncInterval: NodeJS.Timeout | null = null;
  protected handForHandRePauseTimer: NodeJS.Timeout | null = null;
  // Late reg finalization
  protected prizePoolFinalized: boolean = false;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  NOBODY BUSTS BEFORE THE CHIPS ARRIVE (2026-08-23)
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Wall-clock instant before which the elimination sweep must not bust
   * anybody, because their stacks have not been written yet.
   *
   * A Spin seats its field as RESERVATIONS at zero chips and defers the credit
   * until the wheel stops — `spinRevealToDealMs()` later, about eighteen
   * seconds. The elimination checker, however, starts immediately and fires
   * every five. So at t+5s it synced `table_seats.stack` (still 0) into
   * `tournament_players.chips`, saw the ENTIRE field at `chips <= 0`, busted
   * everyone but an arbitrary "top" stack, and paid that player first prize —
   * before a single card had been dealt.
   *
   * Measured in production 2026-08-23: 276 of the last 278 completed Spins
   * finished with ZERO rows in hand_history. Every one collected buy-ins and
   * paid a prize for a game that was never played.
   *
   * This is the cause fix — no sweep may bust while a credit is still pending.
   * TournamentManagerEliminations carries the independent invariant as well:
   * a whole field at zero chips is never a result, because chips are conserved
   * in poker, so it can only ever mean an uncredited table.
   */
  protected bustingArmedAt: number = 0;
  /**
   * How often the elimination sweep runs. Named because `bustingArmedAt` is
   * sized in terms of it — a literal in two files is how the two drift apart.
   */
  static readonly ELIMINATION_SWEEP_MS = 5000;
  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  THE SPIN REVEAL IS ANCHORED TO THE THIRD PAYMENT (2026-08-27)
   * ═════════════════════════════════════════════════════════════════════════
   *
   * Dan 2026-08-21: "THE WHEEL STARTS SPINNING THE MOMENT THE 3RD PLAYER PAYS
   * FOR HIS SEAT... ONE SECOND LATER, A 3...2...1... COUNT DOWN CLOCK MUST
   * BEGIN WITH A WHEEL SPIN."
   *
   * `revealAt` used to be `Date.now()` taken AFTER the draw RPC, the settle
   * RPC, the row write and `createTablesAndSeatPlayers` — four round trips and
   * a table build after the moment the rule names, with nothing measuring the
   * gap. The client scales its animation against a fixed `spinRevealToDealMs()`
   * hold, so every millisecond of that work was silently taken off the wheel.
   *
   * These two are stamped at the paid-seat gate instead, from the LAST
   * `tournament_buyin` debit, so the slow work happens INSIDE the hold rather
   * than in front of it. `spinRevealAt` is when the count begins;
   * `spinHoldUntil` is the first instant a card may legally be dealt. Both are
   * epoch ms. Zero means "not a Spin, or not stamped yet".
   */
  protected spinRevealAt: number = 0;
  protected spinHoldUntil: number = 0;
  /**
   * How late the reveal broadcast was against the anchor. Reported when it
   * eats into the animation, because "nothing measures the gap" is what let the
   * gap grow unnoticed in the first place.
   */
  protected spinRevealLagMs: number = 0;
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
      } catch {
        /* ignore */
      }
      this.broadcastChannel = null;
      this.broadcastReady = false;
    }
  }

  /**
   * Stop the level clock and remember how much of the level was left, so
   * resumeFromBreak can give back exactly that much and no more.
   *
   * Shared by BOTH ways a tournament enters a break, because they used to
   * disagree:
   *
   *   - pauseForBreak, the :55 path, measured and cleared the timer here;
   *   - resume(), restarting INTO a live break, set onBreak = true and paused
   *     the tables but left the blind timer it had armed seconds earlier
   *     running. The level clock therefore ticked through the whole break, and
   *     when resumeFromBreak fired it found savedBlindTimerRemaining at 0 and
   *     handed out a FRESH FULL LEVEL. One restart during a break both burned
   *     a level's worth of clock and then reset it.
   *
   * Every entry into a break now goes through this.
   */
  protected suspendLevelClock(): void {
    /**
     * DEAD LEVEL CLOCK (2026-08-23). This measurement used to live entirely
     * inside `if (this.blindTimer)`, so a break that landed while no timer was
     * armed left `savedBlindTimerRemaining` at whatever it happened to hold —
     * 0 on the first break of a tournament. resumeFromBreak read that 0 as
     * "arm nothing", and the tournament played out the rest of its life at one
     * blind level.
     *
     * blindTimer is legitimately null for seconds at a time: advanceBlindLevel
     * consumes it on fire and does not re-arm until it has awaited a blind
     * write per table, the current_level persist, the level_up broadcast and
     * possibly a prize-pool finalization. A :55 break inside that window is
     * exactly the case that killed the clock.
     *
     * Every path now leaves a usable remaining time, and resumeFromBreak arms
     * unconditionally.
     */
    const structureAtPause = this.tournamentCache?.blind_structure || [];
    // resolveBlindLevel, not a clamped index: a tournament past the end of its
    // structure is playing a DERIVED level, and clamping here would measure the
    // remaining clock against the last persisted row's duration instead.
    const pausedLevelData = this.resolveBlindLevel(structureAtPause, this.currentLevel);
    const pausedLevelTotalMs = pausedLevelData ? this.levelDurationMs(pausedLevelData) : 0;
    if (this.blindTimer) {
      const elapsed = Date.now() - this.blindTimerStartedAt;
      clearTimeout(this.blindTimer);
      this.blindTimer = null;
      this.savedBlindTimerRemaining =
        pausedLevelTotalMs > 0 ? Math.max(pausedLevelTotalMs - elapsed, 1000) : 0;
    } else {
      // No armed clock to measure — a level transition is most likely still in
      // flight. Hand resumeFromBreak a full level so it can never come back
      // from the break with no clock at all.
      this.savedBlindTimerRemaining = pausedLevelTotalMs;
    }
  }

  /** Synchronized break: pause blind timer and broadcast break event */
  async pauseForBreak(breakDurationMs: number): Promise<void> {
    if (!this.running || this.onBreak) return;
    /**
     * ═════════════════════════════════════════════════════════════════════
     *  A SPIN NEVER BREAKS — AND THE GATE LIVES HERE (2026-08-27)
     * ═════════════════════════════════════════════════════════════════════
     *
     * The eligibility rule used to live only in the CALLER: GameServer checked
     * `takesSynchronizedBreaks()` before pausing anything, and pauseForBreak
     * itself would break whatever it was handed. Production disagrees with
     * that arrangement — 68 Spin rows carried `break_started_at` stamped
     * inside the :55 window across 2026-08-27/28, several stopped before
     * finishing level 1 — and a 3-handed hyper whose levels are three minutes
     * cannot survive a five-minute stop plus two minutes of last-hand grace.
     *
     * A caller-side gate is one forgotten `&&`, one new call site, or one
     * unpopulated `tournamentCache` away from breaking a hyper, so the refusal
     * is stated where the break actually starts. `breakApplies()` re-reads the
     * row when the cache is not populated, which is the window a manager sits
     * in between `this.running = true` at the top of start() and the row
     * landing a query later.
     */
    if (!(await this.breakApplies())) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Break refused — this format does not take the :55 break`
      );
      return;
    }
    this.onBreak = true;
    // A NEW break: its countdown has not started yet, so beginBreakCountdown
    // is allowed to stamp an end time exactly once. See breakCountdownStarted.
    this.breakCountdownStarted = false;

    // Save remaining blind timer time
    // TOURNEY-AUDIT 2026-07-24 (sweep 4): the empty-structure guard used to
    // `return` AFTER setting onBreak=true but BEFORE clearing the timer —
    // leaving the level clock running through the "break" with onBreak stuck
    // true. The timer is now always cleared once the break begins.
    /**
     * DEAD LEVEL CLOCK (2026-08-23). This measurement used to live entirely
     * inside `if (this.blindTimer)`, so a break that landed while no timer was
     * armed left `savedBlindTimerRemaining` at whatever it happened to hold —
     * 0 on the first break of a tournament. resumeFromBreak read that 0 as
     * "arm nothing", and the tournament played out the rest of its life at one
     * blind level.
     *
     * blindTimer is legitimately null for seconds at a time: advanceBlindLevel
     * consumes it on fire and does not re-arm until it has awaited a blind
     * write per table, the current_level persist, the level_up broadcast and
     * possibly a prize-pool finalization. A :55 break inside that window is
     * exactly the case that killed the clock.
     *
     * Every path now leaves a usable remaining time, and resumeFromBreak arms
     * unconditionally.
     */
    this.suspendLevelClock();

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
    // Derived past the end of the structure. The clamped index used to show the
    // last PERSISTED level on the break card while the felt played an escalated
    // one — the same "client shows 750/1500, table plays 12,000/24,000" split
    // that resolveBlindLevel exists to close.
    const nextLevel = this.resolveBlindLevel(blindStructure, this.currentLevel);
    /**
     * THE PAYLOAD MUST NOT INVENT AN END TIME (2026-08-27).
     *
     * This used to send `breakEndsAt: now + breakDurationMs`, i.e. :55 plus
     * five minutes, in the same breath as persisting `break_ends_at: null` for
     * exactly the reason documented above: at :55 only the LAST HAND is
     * announced, and the five minutes start when it lands. Every consumer of
     * this event counted down to that fabricated instant, so the break screen,
     * the tournament clock and the blinds tab all reached 0:00 up to
     * LAST_HAND_GRACE_MS (two minutes) before play actually resumed, and then
     * sat there under a full-screen opaque overlay.
     *
     * `phase` says which half of the break this is, and `breakEndsAt` is null
     * until beginBreakCountdown knows the real answer. A client that cannot
     * read a clock renders "Last Hand" rather than a wrong number.
     */
    await this.broadcast('tournament_break', {
      level: this.currentLevel,
      phase: 'last_hand',
      breakDurationMinutes: Math.round(breakDurationMs / 60000),
      breakEndsAt: null,
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
        // beforeNextHand: a break means STOP. A table that was idle at :55
        // must park without dealing, and no table may open a new hand until
        // the break ends. (Hand-for-hand deliberately does NOT pass this.)
        engine.pauseAfterHand(breakDurationMs + TournamentManagerBase.LAST_HAND_GRACE_MS, {
          beforeNextHand: true,
        });
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
    /**
     * ONCE STARTED, A COUNTDOWN IS NOT RESTARTED (2026-08-25).
     *
     * GameServer calls this twice for the same break whenever a tournament
     * starts while one is live: triggerSynchronizedBreak stamps every engine,
     * and holdIfBreakIsRunning then calls pauseForBreak + beginBreakCountdown
     * on the newcomer -- but its `toResume` sweep and the shared resume timer
     * mean an already-parked tournament can reach this a second time too.
     * pauseForBreak defends itself with `if (this.onBreak) return`; this had
     * no such guard, so the second call re-stamped break_ends_at further into
     * the future and quietly EXTENDED a break whose end time players had
     * already been shown.
     */
    if (this.breakCountdownStarted) return;
    this.breakCountdownStarted = true;
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
      phase: 'counting_down',
      // The countdown seed every client needs. Without breakDurationMinutes
      // here, TournamentClock fell back to a hardcoded 300 seconds.
      breakDurationMinutes: Math.round(breakDurationMs / 60000),
      breakEndsAt: endsAt,
      synchronized: true,
    });
  }

  /**
   * Clear the persisted break flags. Split out of resumeFromBreak because a
   * tournament that ENDS on a break has to come off it too, and that path does
   * not resume anything.
   */
  protected async clearPersistedBreak(): Promise<void> {
    try {
      await supabase
        .from('tournaments')
        .update({ on_break: false, break_ends_at: null })
        .eq('id', this.tournamentId);
    } catch (err) {
      reportError(err, 'TournamentManagerBase.resumeFromBreak_persist');
    }
  }

  /** Resume from synchronized break: restart blind timer with remaining time */
  async resumeFromBreak(): Promise<void> {
    if (!this.onBreak) return;
    this.onBreak = false;
    this.breakCountdownStarted = false;

    /**
     * A TOURNAMENT THAT ENDS ON A BREAK STILL HAS TO COME OFF IT (2026-08-25).
     *
     * The guard here was `if (!this.running || !this.onBreak) return` — a
     * single early return that fired BEFORE the persisted flags were cleared.
     * stop() sets running = false, so a tournament whose final hand landed
     * during a break (or one torn down by a redeploy) left `on_break = true`
     * on its row with nothing left alive that would ever clear it. Measured
     * 2026-08-25: 7 tournaments carry on_break = true against no live break,
     * the oldest stamped 2026-08-22 09:55 and still true 70 hours later.
     *
     * The database is cleared unconditionally now; only the RESUMING half —
     * broadcasting, un-pausing engines, re-arming the level clock — is skipped
     * when the tournament is no longer running.
     */
    await this.clearPersistedBreak();
    if (!this.running) return;

    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] BREAK ENDED — resuming play`);

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
    /**
     * DRIFTING LEVEL CLOCK (2026-08-23). This used to hand-roll its own
     * setTimeout and set `blindTimerStartedAt = Date.now()` while the level's
     * nominal duration stayed the FULL level. pauseForBreak measures remaining
     * as `fullDuration - (now - blindTimerStartedAt)`, so a SECOND break in
     * the same level gave the level back every minute it had already played —
     * a level with one minute left returned from the break with ten. Across an
     * hourly break cadence that is how a level stops going up.
     *
     * startBlindTimer already solves this: it clamps the override to the level
     * duration and BACK-DATES blindTimerStartedAt by the difference, so the
     * next pause measures the true remaining time. Routing through it also
     * re-persists level_started_at, so a restart mid-level resumes correctly,
     * and wraps advanceBlindLevel in the catch that keeps a throw from
     * silently ending escalation.
     *
     * Arming is unconditional. A zero here used to mean "no clock at all"
     * (see pauseForBreak); startBlindTimer with no override grants a fresh
     * full level, which is the safe direction to be wrong in.
     */
    {
      const blindStructure = this.tournamentCache?.blind_structure || [];
      const remaining = this.savedBlindTimerRemaining;
      // Cleared before arming: a stale value from a previous level must never
      // be readable by a later break that cannot measure the clock.
      this.savedBlindTimerRemaining = 0;
      this.startBlindTimer(blindStructure, remaining > 0 ? remaining : undefined);
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
  /**
   * FORMAT WINS OVER THE COLUMN (2026-08-27). `synchronized_breaks` defaults to
   * `true` in the schema and no Spin writer has ever set it otherwise: all
   * 28,788 Spin rows on the platform carry `true`. Reading the column alone
   * therefore says "break this hyper" for every Spin ever created, so the
   * format rule is applied first — see breakEligibility.ts.
   */
  synchronizedBreaksEnabled(): boolean {
    return mayTakeSynchronizedBreak(this.tournamentCache);
  }

  /**
   * The same question, asked where the break actually starts, and answered even
   * when `tournamentCache` has not been populated yet.
   *
   * A manager sits with `running = true` and `tournamentCache = null` from the
   * top of start() until the row lands one query later. Everything that reads
   * the cache alone treats that manager as an ordinary MTT, which is exactly
   * the wrong answer for the Spin it usually is. One extra SELECT on a path
   * that already writes to the row costs nothing and closes the window.
   */
  protected async breakApplies(): Promise<boolean> {
    if (this.tournamentCache) return mayTakeSynchronizedBreak(this.tournamentCache);
    const { data } = await supabase
      .from('tournaments')
      .select('tournament_type, variant, synchronized_breaks')
      .eq('id', this.tournamentId)
      .maybeSingle();
    return mayTakeSynchronizedBreak(data);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  THE FINAL TABLE IS ONE TABLE, NOT A HEADCOUNT (2026-08-27, P0)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `final_table` was declared purely on `remaining <= table_size`, and the
   * deal poll gated on the same shape (`alive.length <= tableSize`). Neither
   * asks where those players are SITTING. A 9-max event that falls to nine
   * players spread three-three-three across three felts satisfies both — so
   * every one of them gets the final-table overlay while two thirds of the
   * field are at other tables, and `fn_final_table_deal` will chop the pool
   * between nine players who never met.
   *
   * The count is a NECESSARY condition, never a sufficient one. The sufficient
   * one is this: exactly one live table still holds players. Consolidation is
   * the balancer's job (TableBalancer / checkTableBalance) — this is only the
   * gate, so a field that is short enough but not yet merged simply waits for
   * the balancer to finish, which is the correct behaviour and the reason the
   * two halves compose.
   *
   * Returns the number of live tables that still hold at least one seated
   * player, or `null` when it could not be read. A null is UNKNOWN, and every
   * caller treats unknown as "not yet" — the house rule already applied to the
   * elimination count. Declaring a final table one poll late costs nothing;
   * declaring one that is not there chops a tournament.
   */
  protected async countLiveTablesWithPlayers(): Promise<number | null> {
    const { data: liveTables, error: tablesErr } = await supabase
      .from('tables')
      .select('id')
      .eq('tournament_id', this.tournamentId)
      .in('status', ['running', 'waiting']);
    if (tablesErr || !liveTables) return null;
    const ids = liveTables.map((t: { id: string }) => t.id).filter(Boolean);
    if (ids.length === 0) return 0;
    // The seat query runs even for a single table, deliberately. "One table
    // exists" and "one table holds players" are different statements, and this
    // function is asked the second one — an empty adopted table must not read
    // as a final table.
    const { data: seats, error: seatsErr } = await supabase
      .from('table_seats')
      .select('table_id')
      .in('table_id', ids)
      .is('left_at', null);
    if (seatsErr || !seats) return null;
    return new Set(seats.map((s: { table_id: string }) => s.table_id)).size;
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  MYSTERY BOUNTY — ACTIVATION
  // ═══════════════════════════════════════════════════════════════════════════

  /** Local mirror of `tournaments.mystery_bounty_stage`, so the sweep below is
   *  free until the phase is genuinely eligible. Refreshed from the seed RPC's
   *  own answer, which is the only thing allowed to change it. */
  protected mysteryBountyStage: MysteryBountyStage = 'pending';
  /** Guard against two sweeps overlapping across an await. */
  private mysteryBountySeeding = false;

  /** True only when NO table in this event has a hand in progress. */
  protected allTablesBetweenHands(): boolean {
    for (const engine of this.tableEngines.values()) {
      try {
        if (!engine.isBetweenHands()) return false;
      } catch {
        // An engine that cannot answer is an engine we cannot vouch for.
        // Refusing to activate costs a few seconds; activating over a live
        // hand changes the value of a decision already made.
        return false;
      }
    }
    return true;
  }

  /**
   * Open the mystery phase, if this is the moment.
   *
   * Called from the elimination sweep, which already runs between hands and
   * already knows how many players are left. Everything expensive is behind
   * the cheap `stage !== 'pending'` test, so a non-mystery event pays one
   * boolean per sweep.
   *
   * The INVENTORY is built here, in TypeScript, from the one tier ladder in
   * `config/mysteryBountySpec.ts`, and shuffled with the CSPRNG before it goes
   * anywhere near the database. `fn_mystery_bounty_seed` refuses to invent
   * chests of its own precisely so a second ladder cannot come into existence
   * — three of them already had, and none agreed.
   */
  protected async maybeActivateMysteryBounty(playersRemaining: number): Promise<void> {
    if (this.mysteryBountyStage !== 'pending') return;
    const t = this.tournamentCache;
    if (!t?.is_mystery_bounty) return;
    if (this.mysteryBountySeeding) return;

    // The bounty pool grows with every late entry, so read it fresh rather
    // than from the cache: the cached row was loaded at start().
    // `as any` on the row, not on the query: the generated Supabase types were
    // last regenerated before the mystery_bounty_* columns existed, so the
    // typed client resolves a select naming them to GenericStringError and
    // every field access below is an error. The columns are real — they are
    // created by 20260825410000 and CHECK 17 verifies that against the live
    // schema on every branch.
    const { data: freshRow } = await supabase
      .from('tournaments')
      .select(
        'bounty_pool, bounty_pool_paid, prize_pool_finalized, mystery_bounty_stage, mystery_bounty_pool_percent, ' +
          'mystery_bounty_regular_pool_percent, mystery_bounty_profile, mystery_bounty_activation, ' +
          'mystery_bounty_activation_value, payout_structure, current_players'
      )
      .eq('id', this.tournamentId)
      .maybeSingle();
    const fresh = freshRow as any;
    if (!fresh) return;

    if (fresh.mystery_bounty_stage && fresh.mystery_bounty_stage !== 'pending') {
      // Another process (a previous incarnation of this manager, most likely)
      // already opened it. Adopt its answer rather than racing it.
      this.mysteryBountyStage = fresh.mystery_bounty_stage as MysteryBountyStage;
      return;
    }

    let poolCents = 0;
    try {
      poolCents = mysteryPoolCents(
        poolCentsFromNumeric(fresh.bounty_pool),
        fresh.mystery_bounty_pool_percent,
        fresh.mystery_bounty_regular_pool_percent,
        // What the REGULAR half has already paid out as flat pre-activation
        // knockouts. fn_mystery_bounty_seed subtracts this before checking
        // the inventory sum; not subtracting it here is what refused every
        // seed this platform has ever attempted. See mysteryPoolCents.
        poolCentsFromNumeric(fresh.bounty_pool_paid ?? 0)
      );
    } catch (err) {
      // A bounty pool that is not a whole number of cents means something
      // upstream started writing fractions of a cent. Seeding an inventory
      // from it would put the event permanently out of balance.
      reportError(err, 'Tournament.mystery_bounty_pool_not_in_cents');
      return;
    }

    // `payout_structure` is jsonb, and the client reads it back as an array in
    // most rows and as a JSON STRING in some — old rows written before the
    // column was jsonb. Reading only the array form would leave those events
    // with zero paid places, and the default activation mode (at the money)
    // would then never fire for them: the chests would sit unopened for the
    // whole tournament and every knockout would keep paying the flat bounty.
    const paidPlaces =
      countPaidPlaces(t?.payout_structure) || countPaidPlaces(fresh.payout_structure);

    const decision = shouldActivateMysteryBounty({
      isMysteryBounty: true,
      stage: 'pending',
      entryClosed: Boolean(fresh.prize_pool_finalized) || this.prizePoolFinalized,
      allTablesBetweenHands: this.allTablesBetweenHands(),
      playersRemaining,
      totalEntries: Number(fresh.current_players) || playersRemaining,
      paidPlaces,
      mode: (fresh.mystery_bounty_activation || 'at_the_money') as MysteryBountyActivationMode,
      modeValue: fresh.mystery_bounty_activation_value,
      mysteryPoolCents: poolCents,
    });
    if (!decision.activate) return;

    this.mysteryBountySeeding = true;
    try {
      const profile = resolveMysteryBountyProfile(fresh.mystery_bounty_profile);
      /* The stored top-bounty percentage DECIDES the jackpot, it does not just
         describe it. The lobby advertises this number before a chest is
         opened, so the generator has to be built from the same figure or the
         advertisement is a guess. Defaults to 20 - spec section 10 - which is
         what CLASSIC already carries, so a default event is unchanged. */
      const topPercent =
        fresh.mystery_bounty_top_percent == null
          ? DEFAULT_TOP_BOUNTY_PERCENT
          : Number(fresh.mystery_bounty_top_percent);
      const chests = shuffleChests(
        buildInventory(poolCents, decision.drawCount, profile, topPercent)
      ).map((c) => ({ tier: c.tier, amount_cents: c.amountCents, seq: c.seq }));

      const { data: seeded, error: seedErr } = await supabase.rpc('fn_mystery_bounty_seed', {
        p_tournament_id: this.tournamentId,
        /* PLAYERS REMAINING, not the chest count. The RPC derives the chest
           count from it (players - 1) and also records it as
           mystery_bounty_activated_players, which is the figure the audit
           trail prints as "Mystery Stage Activated: 150 Players Remaining".
           Sending drawCount here would log 149 for a 150-player field. */
        p_players_remaining: playersRemaining,
        p_chests: chests,
      });

      if (seedErr) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty seed FAILED (${seedErr.message}) — chests never opened, knockouts keep paying the flat bounty`
          ),
          'Tournament.mystery_bounty_seed_failed'
        );
        return;
      }
      const res = (seeded ?? {}) as { ok?: boolean; reason?: string; pool_cents?: number };
      if (!res.ok) {
        // `entry_still_open` is the ordinary "not yet" and is not worth an
        // error report; anything else means the engine and the database
        // disagree about the event, which is.
        if (res.reason !== 'entry_still_open') {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] mystery bounty seed refused: ${res.reason}`
            ),
            'Tournament.mystery_bounty_seed_refused'
          );
        }
        return;
      }

      this.mysteryBountyStage = 'active';
      await this.broadcast('mystery_bounty_activated', {
        poolCents: Number(res.pool_cents) || poolCents,
        chests: decision.drawCount,
        profile,
      });
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] MYSTERY BOUNTY OPEN — ${decision.drawCount} chests, ${poolCents}c, profile ${profile}`
      );
    } catch (err) {
      reportError(err, 'Tournament.mystery_bounty_activation_threw');
    } finally {
      this.mysteryBountySeeding = false;
    }
  }

  /**
   * Is this a multi-table event (MTT / XMTT) as opposed to a single-table
   * Spin or Heads-Up?
   *
   * NOT the synchronized-break gate any more — see takesSynchronizedBreaks()
   * below, and read that before wiring this into anything new.
   *
   * CASE-INSENSITIVE since 2026-08-27. It was the only format check in the
   * codebase comparing raw column values (every other one normalises first —
   * payoutStructure.ts, and lines 1361, 1915 and 2212 of this file). Migration
   * 20260820_spin_no_fee_constraint.sql records a real incident where a
   * creation path wrote `variant: 'SPIN'` uppercase and slipped past exactly
   * this shape of test.
   *
   * The hand-rolled comparison it used to carry now lives in
   * breakEligibility.ts, so the format rule is stated exactly once and this
   * predicate, synchronizedBreaksEnabled() and the pauseForBreak gate cannot
   * drift apart.
   */
  isMttOrXmtt(): boolean {
    return !isShortFormat(this.tournamentCache?.tournament_type, this.tournamentCache?.variant);
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  WHICH FORMATS TAKE THE :55 BREAK
   * ═════════════════════════════════════════════════════════════════════════
   *
   * GameServer's gate. It exists so a caller asks ONE question rather than
   * `isMttOrXmtt() && synchronizedBreaksEnabled()`, which is one forgotten
   * `&&` away from breaking a hyper.
   *
   * CORRECTED 2026-08-27. This method was introduced to admit Spins and
   * Heads-Up to the platform break — deliberately format-agnostic, on the
   * reasoning that "synchronized" is destroyed by any exception. Production
   * then showed what that costs: 68 Spin rows carried `break_started_at`
   * stamped inside the :55 window across 2026-08-27/28, several of them
   * stopped before finishing level 1. A Spin level is three minutes and the
   * whole game is over inside ten, so a five-minute stop plus up to two
   * minutes of last-hand grace does not interrupt the game, it IS the game.
   * The two guards that hold a level from advancing during a break then hold
   * the clock for the duration as well.
   *
   * So the format carve-out is back, and it is narrow and stated once:
   * `isShortFormat` (Spin, SNG/Heads-Up) in breakEligibility.ts, with the
   * per-tournament `synchronized_breaks` opt-out still honored on top of it
   * for everything else. Every MTT and XMTT still stops at :55 together, which
   * is the synchrony that was actually being asked for. The
   * `tournaments_short_formats_never_break` trigger (migration
   * `20260827_spin_never_breaks_and_drawn_button_survives_restart`) forces the
   * column off on every write of a short format as well, so the code gate and
   * the data agree.
   */
  takesSynchronizedBreaks(): boolean {
    return this.synchronizedBreaksEnabled();
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
      // Adopt whatever the row says the mystery phase is. A redeploy
      // mid-tournament must not re-seed an inventory that already exists.
      this.mysteryBountyStage =
        (tournament.mystery_bounty_stage as typeof this.mysteryBountyStage) || 'pending';

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
          /* THE GATE MUST NOT DISABLE ITSELF ON A FAILED READ (2026-08-28).
             This discarded its `error`. On failure `regs` is null, so
             `regIds` is [], the debits query below falls to its sentinel
             UUID, `debits` is [], and `unpaid` is [] — the gate PASSES,
             having verified exactly zero payments. That is the precise hole
             this block exists to close (the free-spin incident recorded
             above), reopened by any transient failure. The very next read
             already treats unreadable evidence as a stand-down; these two
             adjacent reads had opposite failure policies. */
          const { data: regs, error: regsErr } = await supabase
            .from('tournament_players')
            .select('user_id')
            .eq('tournament_id', this.tournamentId)
            .in('status', ['registered', 'playing']);
          if (regsErr) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Paid-entry roster unreadable (${regsErr.message}) — standing down, will retry`
              ),
              'Tournament.spin_paid_roster_unreadable'
            );
            this.running = false;
            return;
          }
          const regIds = (regs ?? []).map((r: any) => r.user_id).filter(Boolean);

          const { data: debits, error: debitErr } = await supabase
            .from('wallet_transactions')
            // `created_at` is read for the REVEAL ANCHOR, not for the gate:
            // Dan 2026-08-21, "THE WHEEL STARTS SPINNING THE MOMENT THE 3RD
            // PLAYER PAYS FOR HIS SEAT", and the last of these rows IS that
            // moment. See stampSpinRevealAnchor below.
            .select('user_id, amount, created_at')
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
            /**
             * RELEASE THEIR SEATS TOO, OR THIS GAME NEVER RUNS AGAIN
             * (2026-08-28).
             *
             * Removing the registration alone left the `table_seats` row
             * standing, and a seat-first game's fill is counted from those
             * rows — `readSeatFirstPaidSeats`, `fn_sync_seat_first_player_count`
             * and the stall watchdog all read `left_at IS NULL`. So the game
             * still read 3/3 SOLD with only 2 registrations:
             *
             *   - the fast lane force-starts it, `start()` now fails the
             *     field check ABOVE this gate (2 < 3) and stands down before
             *     ever reaching here again;
             *   - `topUpWithHorses` sees no shortfall — the seats are full —
             *     and adds nobody;
             *   - the stall watchdog is gated on `paid < seats`, so it is
             *     silent too.
             *
             * The result was a 5-second loop, forever, with money taken and
             * a single console.log as the only trace. Vacating the seat is
             * what lets a paying horse take it on the next pass, which is
             * what the comment below has always promised.
             */
            const { error: seatReleaseErr } = await supabase
              .from('table_seats')
              .update({ left_at: new Date().toISOString(), is_sitting_out: false })
              .in('user_id', unpaid)
              .is('left_at', null)
              .in(
                'table_id',
                (
                  await supabase.from('tables').select('id').eq('tournament_id', this.tournamentId)
                ).data?.map((r: { id: string }) => r.id) ?? []
              );
            if (seatReleaseErr) {
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Could not release unpaid seat(s): ${seatReleaseErr.message}. The game will read full and cannot refill until this clears.`
                ),
                'Tournament.spin_unpaid_seat_release_failed'
              );
            }
            // Both counters derive from the seat rows; resync rather than
            // arithmetic on a counter this gate has just proven unreliable.
            await supabase.rpc('fn_sync_seat_first_player_count', {
              p_tournament_id: this.tournamentId,
            });
            this.running = false;
            return; // discovery refills with PAYING horses and restarts
          }

          /**
           * THE WHEEL IS ANCHORED TO THE THIRD PAYMENT, NOT TO WHENEVER WE
           * FINISH WORKING (2026-08-27).
           *
           * Every paid seat has its `tournament_buyin` debit and the LAST of
           * them is the instant Dan's rule names. Stamp the reveal deadline
           * from it HERE, before the draw RPC, the settle RPC, the row write
           * and the seating — all of which used to run first, with
           * `revealAt = Date.now()` taken afterwards. Nothing measured that
           * gap, and the client scales its animation against a fixed
           * server hold, so any drift came straight off the wheel.
           */
          this.stampSpinRevealAnchor(
            (debits ?? [])
              .map((d: { created_at?: string }) => Date.parse(String(d?.created_at ?? '')))
              .filter((t: number) => Number.isFinite(t))
          );
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
          //
          // D5 (2026-08-25) — A DRAW THAT COULD NOT BE READ IS NOT A DRAW.
          //
          // This call used to destructure `{ data: draw }` and throw the
          // `error` away, sitting inside a `try { } catch { }` whose body was
          // the comment "handled below". "Below" then read the still-zero
          // multiplier and resolved it DOWN to SPIN_TIERS[0] — 2x — as though
          // that were a merciful default. It is not a default, it is an
          // invented result: three players watched a genuine-looking wheel
          // chase five laps and land on a tier the database was never able to
          // tell us it had drawn, and fn_spin_settle_game then moved real
          // money against that number. A money-facing lie.
          //
          // The house rule is the one already applied to the elimination count
          // (see 'remaining_count_unavailable' in TournamentManagerEliminations):
          // an unreadable result is UNKNOWN, never a value. There is no honest
          // multiplier to substitute, so the failure is made explicit and
          // RETRYABLE instead — three attempts here, then the start stands
          // down exactly like the short-field and unpaid-seat gates above.
          // Nothing irreversible has happened at this point: the
          // registrations are still 'registered', no table exists, no ledger
          // row has been written, so standing down costs nothing and the
          // discovery loop calls start() again on its next pass. The player
          // sees a game that has not started yet, which is true, rather than a
          // wheel telling him something that is false.
          let drawFailure: string | null = null;
          for (
            let attempt = 1;
            attempt <= 3 && (!spinMultiplier || spinMultiplier <= 0);
            attempt++
          ) {
            try {
              const { data: draw, error: drawErr } = await supabase.rpc('fn_spin_draw_multiplier', {
                p_club_id: tournament.club_id,
                p_buy_in: tournament.buy_in_amount || 0,
                p_tiers: SPIN_TIERS.map((t) => ({
                  multiplier: t.multiplier,
                  freq: t.freq,
                  reserveThresholdX: t.reserveThresholdX,
                })),
                p_rake_rate: spinRakeRate(tournament.buy_in_amount || 0),
                /* A SPIN HAS THREE SEATS BY DEFINITION (2026-08-28). This
                   read `current_players`, the registration counter that
                   GameServer's own start gate refuses to trust — "it drifts
                   badly: the live lobby was carrying spins reading 3/3 with
                   two seats actually sold, and others reading 0/3 with three
                   sold". `p_seats` is what `collected = seats x buy_in` is
                   computed from, so a drifted counter mis-books the house
                   rake and the reserve contribution while the prize
                   (buy_in x multiplier) stays correct — the two halves of
                   the pool identity disagreeing by exactly the drift.
                   SPIN_SEATS is forced at creation and is the honest number. */
                p_seats: SPEC_SPIN_SEATS,
              });
              // The error is READ now. It was the whole defect.
              if (drawErr) throw new Error(drawErr.message || 'draw_rpc_error');
              const drawn = Number(draw?.multiplier);
              // A response we cannot read a positive multiplier out of is a
              // failure too, not a licence to pick one.
              if (!Number.isFinite(drawn) || drawn <= 0) {
                throw new Error(
                  `draw returned no usable multiplier (${JSON.stringify(draw ?? null).slice(0, 160)})`
                );
              }
              spinMultiplier = drawn;
              drawFailure = null;
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
            } catch (err: any) {
              drawFailure = err?.message ? String(err.message) : String(err);
              // Same short backoff the settlement and row-write loops below
              // use; lock contention on a busy club's reserve pool is the
              // expected cause and it clears in well under a second.
              if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
            }
          }
          if (!spinMultiplier || spinMultiplier <= 0) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw UNAVAILABLE after 3 attempts (${drawFailure ?? 'no multiplier returned'}) — standing down; NO multiplier is invented and NO wheel is shown`
              ),
              'Tournament.spin_draw_unavailable'
            );
            console.error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw unavailable — standing down so the start can be retried (NOT cancelling, NOT defaulting to a tier)`
            );
            this.running = false;
            return; // discovery calls start() again once the RPC answers
          }
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw: ${spinMultiplier}x through the reserve gate`
          );
        }

        const buyIn = tournament.buy_in_amount || 0;
        // Same reasoning as p_seats on the draw above: three seats, always.
        const seats = SPEC_SPIN_SEATS;
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
        //
        // D5 (2026-08-25): the payload is hoisted into a named constant so the
        // SELF-HEALING repair below can re-apply the identical write. Three
        // attempts inside one start() is a thin defence against a failure that
        // outlives them: the game then runs with spin_multiplier NULL, and
        // every client gate for the wheel requires `> 0`, so the wheel can
        // never fire for ANYONE on that game — not the three players at the
        // table, not a spectator, not a reconnect. `fn_spin_sweep_unbooked`
        // skips it for the same reason. One transient write error was enough
        // to lose the whole feature for a game, permanently, and nothing ever
        // came back for it.
        const spinRowPatch = {
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
        };
        let spinRowWritten = false;
        let spinRowLastError = '';
        for (let attempt = 1; attempt <= 3 && !spinRowWritten; attempt++) {
          const { error: spinRowErr } = await supabase
            .from('tournaments')
            .update(spinRowPatch)
            .eq('id', this.tournamentId);
          if (!spinRowErr) {
            spinRowWritten = true;
            break;
          }
          spinRowLastError = spinRowErr.message;
          if (attempt === 3) {
            // The game still starts — Dan 2026-08-19, tournaments run, they do
            // not cancel — but it starts on the placeholder structure, so this
            // has to be loud. fn_spin_repair_missing_multiplier reconstructs
            // the multiplier from the prize actually paid on the next sweep.
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw row write FAILED after 3 attempts (${spinRowErr.message}) — ${spinMultiplier}x was drawn but the row still reads NULL; this game will run on the placeholder structure and NO client can show the wheel until the row is repaired`
              ),
              'Tournament.spin_draw_row_write_failed'
            );
          } else {
            await new Promise((r) => setTimeout(r, 250 * attempt));
          }
        }
        if (!spinRowWritten) {
          console.error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] SPIN ROW NOT WRITTEN (${spinRowLastError}) — ${spinMultiplier}x drawn, starting background repair`
          );
          // Safe to keep trying: the repair only ever writes the value THIS
          // start already drew and settled against, and only while the column
          // is still empty. See scheduleSpinRowRepair.
          this.scheduleSpinRowRepair(spinRowPatch, spinMultiplier);
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
      } else {
        /**
         * The credit is now in the future, so the bust sweep must be too.
         * Armed to the same instant the engine is allowed to deal, plus one
         * sweep interval of slack, so the first sweep that can ever bust
         * anybody runs against stacks that exist. Without this the sweep at
         * t+5s reads the reservation zeroes and ends the game.
         */
        // Measured from the HOLD, not from now: the hold is anchored to the
        // third payment (stampSpinRevealAnchor) and is therefore already
        // partly spent by the time we get here. Arming from `Date.now()` would
        // push the first bustable sweep a whole reveal PAST the moment the
        // chips land. Falls back to the old arithmetic when no anchor exists.
        this.bustingArmedAt =
          (this.spinHoldUntil > 0 ? this.spinHoldUntil : Date.now() + spinRevealToDealMs()) +
          TournamentManagerBase.ELIMINATION_SWEEP_MS;
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
        /**
         * ANCHORED, NOT TAKEN NOW (2026-08-27).
         *
         * `revealAt` used to be `Date.now()` read on this line — after the
         * draw RPC, the settle RPC, the row write and the table build. Dan's
         * rule anchors the wheel to the third payment, so the anchor was
         * stamped at the paid-seat gate before any of that work started and
         * `resolveSpinReveal()` returns it here, re-stamping only if the work
         * overran the animation entirely. It also MEASURES the gap, which
         * nothing did before: the client scales its animation against a fixed
         * server hold, so an unmeasured gap comes straight off the wheel.
         *
         * `holdUntil` is still the first instant a CARD may legally be dealt,
         * which is later than the wheel stopping: it covers the chip drop and
         * the button draw too, or the engine is free to deal in the same
         * instant the stacks are still being written.
         */
        const { revealAt, holdUntil } = this.resolveSpinReveal();
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
              /**
               * THE HOLD, STATED EXPLICITLY (2026-08-27).
               *
               * Epoch milliseconds of the first instant a card may legally be
               * dealt on this table — the same number `holdDealingUntil` was
               * just given, so it is the contract and not a description of
               * one. The client used to derive it by adding a hardcoded
               * reveal length to `reveal_at`, which is right only while the
               * engine and the client agree on every beat in SPIN_REVEAL and
               * the server hold starts exactly at `reveal_at`. Neither held.
               *
               * Clients CLAMP their animation to this: whatever is left
               * between now and `hold_until` is the time the wheel actually
               * has, so a client that loads late shortens its own sequence
               * instead of being dealt over.
               */
              hold_until: holdUntil,
              /** How far the broadcast slipped behind the third payment. */
              reveal_lag_ms: this.spinRevealLagMs,
              prize_pool: Number(tournament.prize_pool) || 0,
              timestamp: revealAt,
              /**
               * D3 (2026-08-25): ask the hub to HOLD this event until the
               * first card may legally be dealt, so a client that is
               * mid-reconnect at this exact instant still receives it when it
               * subscribes or resyncs. It used to be a single un-replayed
               * packet — miss the one emission and the reveal was gone for
               * good, because the SNAPSHOT a resync returns carries no
               * multiplier. Past `holdUntil` the wheel is meaningless (cards
               * are out), so the hub drops it on its own; there is no log.
               */
              replay_until: holdUntil,
            });
          } catch (err) {
            // The reveal is theatre; it must never stop a game from starting.
            reportError(err, 'Tournament.' + this.tournamentId.slice(0, 8) + '.spin_reveal_emit');
          }
        }
        this.scheduleSpinPostReveal(tournament, revealAt);
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Spin reveal broadcast — ${revealMultiplier}x, holding the deal until ${new Date(holdUntil).toISOString()} (${Math.max(0, holdUntil - Date.now())}ms from now, ${this.spinRevealLagMs}ms behind the third payment)`
        );
      }

      // ── GUARANTEE, no-late-reg case (2026-08-23) ──
      // An event with no late registration takes its last entry before this
      // line, so the pool it holds now is the pool it dies with — apply the
      // advertised guarantee here and finalize. Events WITH late reg are
      // bumped at finalization instead, where the pool truly stops moving.
      // Scheduler-spawned events accrue per-entry through the register RPCs
      // and nothing else ever applied guaranteed_prize (the old recurring
      // service pre-applied it at creation, which is why this was never seen
      // before the 2026-08-22 data-driven schedules).
      {
        const lateRegCap = Number(tournament.late_reg_levels ?? tournament.rebuy_levels ?? 0);
        const gtd = Number(tournament.guaranteed_prize) || 0;
        if (lateRegCap <= 0 && gtd > 0 && !this.prizePoolFinalized) {
          // OVERLAY FUNDING 2026-08-27: a guarantee becomes real money ONLY
          // through fn_apply_prize_guarantee, which funds the overlay from
          // the host club's chip_treasury and records it in
          // tournament_guarantee_overlays (PK-claimed, so a replayed start
          // cannot fund twice). Writing max(pool, gtd) from here is how
          // 265,209 chips were minted in 30 days with no funding source.
          // The call itself lives in applyPrizeGuarantee — one implementation
          // for all three closing sites, so a later site cannot quietly grow
          // its own local fallback pool again.
          const applied = await this.applyPrizeGuarantee('start_no_late_reg');
          if (applied !== null) {
            tournament.prize_pool = applied;
            this.prizePoolFinalized = true;
          }
        }
      }

      // Set tournament to RUNNING
      // Guard: only transition REGISTERING → RUNNING (prevents re-starting)
      //
      // RETRIED AND VERIFIED (2026-08-23). This was fire-and-forget: no error
      // check, no retry, no confirmation. When it failed — and it did, during
      // the DB-starvation window that was timing statements out — the game
      // went right on dealing from memory while its row still read
      // REGISTERING. Nothing downstream heals that: the stuck-COMPLETING
      // watchdog only reads COMPLETING, the decided-but-stalled watchdog only
      // reads RUNNING, and fn_final_table_deal requires RUNNING. Eleven
      // tournaments were found in exactly that state, 22-33 hours old, having
      // played to a finish with 570 chips debited and 48 paid out — 522 owed
      // to players who never got a result.
      //
      // The flip is now retried and then CONFIRMED by reading the row back.
      // A row that reads RUNNING (or any later status) is success, including
      // when another process won the race.
      let runningFlipped = false;
      for (let attempt = 1; attempt <= 3 && !runningFlipped; attempt++) {
        const { error: flipErr } = await supabase
          .from('tournaments')
          .update({ status: 'RUNNING', started_at: new Date().toISOString() })
          .eq('id', this.tournamentId)
          .eq('status', 'REGISTERING');
        const { data: confirmRow } = await supabase
          .from('tournaments')
          .select('status')
          .eq('id', this.tournamentId)
          .maybeSingle(); // FIX 168
        const confirmed = String(confirmRow?.status ?? '');
        if (!flipErr && confirmed !== 'REGISTERING' && confirmed !== '') {
          runningFlipped = true;
          break;
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 250 * attempt));
      }
      if (!runningFlipped) {
        // Loud, because the game is about to deal against a row that does not
        // know it. The REGISTERING-but-played watchdog in GameServer is the
        // safety net that settles it if this never lands.
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] RUNNING flip FAILED after 3 attempts — the game is starting with its row still REGISTERING`
          ),
          'Tournament.running_flip_failed'
        );
      }

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
            const remainder = 100 - sumNormalized;
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
      // Adopt whatever the row says the mystery phase is. A redeploy
      // mid-tournament must not re-seed an inventory that already exists.
      this.mysteryBountyStage =
        (tournament.mystery_bounty_stage as typeof this.mysteryBountyStage) || 'pending';

      // Find existing tables. `first_button_seat` comes along so a Spin whose
      // button was drawn but never dealt keeps the seat it drew — see
      // restoreDrawnFirstButtons.
      const { data: tables } = await supabase
        .from('tables')
        .select('id, first_button_seat')
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
          /**
           * NON-FATAL (2026-08-25). createTablesAndSeatPlayers throws
           * `No players` when nothing is in status 'playing' — which is exactly
           * the state a tournament is in when its whole roster is still
           * 'registered' (start() does that migration; resume() does not). The
           * throw escaped to resume()'s outer catch, so the level clock, the
           * elimination checker and the table-liveness sweep were ALL skipped
           * and `running` was set back to false. A tournament that merely could
           * not be re-seated was left RUNNING in the database with nothing
           * ticking above it, and no path back.
           *
           * The rebuild is best-effort now: it is reported and the rest of
           * resume() proceeds, so the every-5s sweeps get their chance to seat
           * the field and finish the event.
           */
          try {
            await this.createTablesAndSeatPlayers(tournament);
          } catch (rebuildErr) {
            reportError(rebuildErr, 'Tournament.resume_table_rebuild_failed');
          }
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
        // Re-apply a button that was DRAWN but never dealt. Awaited before the
        // first hand can plausibly land, and a no-op for every table that has
        // already played one.
        await this.restoreDrawnFirstButtons(
          tables as Array<{ id: string; first_button_seat?: number | null }>
        );
      }

      /**
       * A RESTART MUST NOT LEAVE THE FIELD ON ZERO CHIPS (2026-08-23).
       *
       * start() defers the Spin credit to a timer roughly eighteen seconds
       * out. A process restart inside that window threw the timer away, and
       * resume() never credited anything — so both `table_seats.stack` and
       * `tournament_players.chips` stayed at zero with no code path left that
       * would ever raise them. The table could not deal (no stacks) and, until
       * the guards added alongside this, the bust sweep ended the game.
       *
       * creditSeatStacks is idempotent and strictly raises, so calling it here
       * costs one query on a healthy resume and rescues the stranded case.
       */
      await this.creditSeatStacks(tournament);

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
      /**
       * A BREAK WHOSE COUNTDOWN NEVER STARTED IS STILL A BREAK (2026-08-25).
       *
       * This block used to be gated on `tournament.on_break && break_ends_at`,
       * and pauseForBreak deliberately writes break_ends_at as NULL: at :55
       * only the LAST HAND is announced, and beginBreakCountdown fills the end
       * time in once every table on the platform has parked — up to
       * LAST_HAND_GRACE_MS (two minutes) later. So a restart anywhere inside
       * that window skipped the whole recovery:
       *
       *   - `this.onBreak` stayed FALSE while the row said true, so the brand
       *     new engines were never re-paused and the tournament dealt straight
       *     through the remainder of its own break. That is exactly the defect
       *     this block was added to prevent, on the two minutes it did not
       *     cover;
       *   - reviveDeadTableEngines lost its `onBreak` skip, so it was free to
       *     tear down and REPLACE paused tables mid-break — and a fresh engine
       *     is not paused;
       *   - resumeFromBreak() early-returns on `!this.onBreak`, so nothing
       *     ever cleared `on_break` again.
       *
       * Measured 2026-08-25: 7 tournaments carry `on_break = true` with no
       * live break; 5 of them have `break_ends_at` NULL — Daily Freeroll,
       * Sunday Freeroll Special, Sunday Kickoff and Blitz Bounty all stamped
       * within 2026-08-23 14:55:00–14:56:39 and still true 41 hours later.
       *
       * A NULL end time is now read for what it means — the countdown had not
       * started yet — and the outside edge of the break is reconstructed from
       * break_started_at: the last-hand grace plus the break itself, i.e. the
       * same worst case GameServer.triggerSynchronizedBreak claims at :55. A
       * row with neither timestamp yields a negative remainder and falls to
       * the clear branch below, which is how the stale flags above heal.
       */
      if (tournament.on_break) {
        const breakStartedAt = tournament.break_started_at
          ? new Date(tournament.break_started_at).getTime()
          : 0;
        const breakEndsAt = tournament.break_ends_at
          ? new Date(tournament.break_ends_at).getTime()
          : breakStartedAt > 0
            ? breakStartedAt +
              TournamentManagerBase.LAST_HAND_GRACE_MS +
              TournamentManagerBase.BREAK_DURATION_MS
            : 0;
        const remainingMs = breakEndsAt - Date.now();
        if (remainingMs > 1000) {
          this.onBreak = true;
          // The end time is already fixed for this break — whether it came off
          // the row or was reconstructed above — so nothing may re-stamp it.
          this.breakCountdownStarted = true;
          // The level clock was armed moments ago, a few lines above. Suspend
          // it for the rest of the break exactly as the :55 path does —
          // without this it ran straight through the break and resumeFromBreak
          // then granted a fresh full level on top. See suspendLevelClock.
          this.suspendLevelClock();
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Resumed DURING a break — re-pausing for the remaining ${Math.round(remainingMs / 1000)}s`
          );
          for (const engine of this.tableEngines.values()) {
            try {
              engine.pauseAfterHand(remainingMs + TournamentManagerBase.LAST_HAND_GRACE_MS, {
                beforeNextHand: true,
              });
            } catch (err) {
              reportError(err, 'TournamentManagerBase.resume_rebreak_pause');
            }
          }
          const rebreakTimer = setTimeout(() => {
            void this.resumeFromBreak();
          }, remainingMs);
          // Never hold the process open for the tail of a break, the same rule
          // every other timer in this file follows.
          if (typeof (rebreakTimer as any)?.unref === 'function') {
            (rebreakTimer as any).unref();
          }
        } else {
          // The break already expired while we were down — clear the flag so
          // the lobby does not show a phantom break. This is also what heals
          // a row stranded by the two defects described above.
          this.onBreak = false;
          this.breakCountdownStarted = false;
          await this.clearPersistedBreak();
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
      } catch {
        /* ignore */
      }
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
    /* A FAILED READ IS NOT "EVERY SEAT IS ALREADY FUNDED" (2026-08-28).
       This discarded its error, so a failure produced `seatRows = null` ->
       `stale = []` -> an immediate `return 0` that is byte-for-byte the
       success-with-nothing-to-do answer, silently. This function is the ONLY
       thing that turns a spin's zero-chip reservations into real stacks (the
       reveal beat, and the safety net a couple of seconds later, both call
       it). If the read fails across that window every seat stays at 0 and
       the dealing loop parks at idle_not_enough_players indefinitely —
       recoverable only by a process restart. Report it and return, so the
       caller's retry and the watchdogs have something to see. */
    const { data: seatRows, error: seatReadErr } = await supabase
      .from('table_seats')
      .select('id, stack, tables!inner(tournament_id)')
      .is('left_at', null)
      .eq('tables.tournament_id', this.tournamentId);
    if (seatReadErr) {
      reportError(
        new Error(`seat stack credit could not read seats: ${seatReadErr.message}`),
        'Tournament.' + this.tournamentId.slice(0, 8) + '.seat_stack_read_failed'
      );
      return 0;
    }
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
   * D5 (2026-08-25) — SELF-HEALING for the draw row that would not land.
   *
   * `spin_multiplier` is not decoration. Both client gates for the wheel
   * require `> 0`, and `fn_spin_sweep_unbooked` requires it too, so a game
   * whose row write failed three times at start runs with the column NULL and
   * NOBODY can ever see the wheel on it — while the money has already been
   * settled against a multiplier that exists only in this process's memory.
   * Before this, that was terminal: three attempts, a report, and the value
   * was gone the moment the process restarted.
   *
   * Why re-writing is safe rather than a second source of truth:
   *
   *   - it writes ONLY the patch this start already computed, so it cannot
   *     introduce a multiplier that was never drawn;
   *   - it is guarded on the column still being empty (`is null` or `0`), so
   *     a value that arrived by any other route — a later start, the sweep,
   *     an operator — is never overwritten;
   *   - it re-reads and confirms, so "no error" is not mistaken for "landed"
   *     when the guard matched no rows;
   *   - it is bounded (12 passes, 5s apart, ~1 minute) and every timer is
   *     unref'd, so a wedged database cannot hold the process open.
   *
   * Exhausting the budget is reported, not swallowed: at that point the row
   * genuinely needs `fn_spin_repair_missing_multiplier` or a human.
   */
  private scheduleSpinRowRepair(patch: Record<string, unknown>, drawnMultiplier: number): void {
    const MAX_PASSES = 12;
    const INTERVAL_MS = 5000;
    const tag = this.tournamentId.slice(0, 8);
    let pass = 0;

    const soon = (fn: () => Promise<void>) => {
      const timer = setTimeout(() => {
        void fn().catch((err) => reportError(err, 'Tournament.' + tag + '.spin_row_repair'));
      }, INTERVAL_MS);
      // Never hold the process open for a repair.
      if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
    };

    const attempt = async (): Promise<void> => {
      pass++;
      const { data: before } = await supabase
        .from('tournaments')
        .select('spin_multiplier')
        .eq('id', this.tournamentId)
        .maybeSingle();
      if (Number(before?.spin_multiplier) > 0) {
        console.warn(
          `[Tournament:${tag}] Spin row repair: multiplier already present (${before?.spin_multiplier}x) after ${pass} pass(es) — nothing to do`
        );
        return;
      }

      await supabase
        .from('tournaments')
        .update(patch as any)
        .eq('id', this.tournamentId)
        // Only ever fills a hole. Never overwrites a real value.
        .or('spin_multiplier.is.null,spin_multiplier.eq.0');

      const { data: after } = await supabase
        .from('tournaments')
        .select('spin_multiplier')
        .eq('id', this.tournamentId)
        .maybeSingle();
      if (Number(after?.spin_multiplier) > 0) {
        console.warn(
          `[Tournament:${tag}] Spin row repair SUCCEEDED on pass ${pass} — ${drawnMultiplier}x is on the row; the wheel can fire again`
        );
        return;
      }

      if (pass >= MAX_PASSES) {
        reportError(
          new Error(
            `[Tournament:${tag}] Spin row repair EXHAUSTED after ${MAX_PASSES} passes — ${drawnMultiplier}x was drawn and settled but spin_multiplier is still empty; no client can show the wheel for this game`
          ),
          'Tournament.spin_row_repair_exhausted'
        );
        return;
      }
      soon(attempt);
    };

    soon(attempt);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  STAMP THE WHEEL'S DEADLINE WHEN THE THIRD SEAT IS SOLD (2026-08-27)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Called from the paid-seat gate with the `created_at` of every
   * `tournament_buyin` debit on this tournament. The LAST of them is the
   * moment Dan's rule names — "THE WHEEL STARTS SPINNING THE MOMENT THE 3RD
   * PLAYER PAYS FOR HIS SEAT" — and the count begins `LEAD_IN_MS` after it.
   *
   * Stamping here rather than at broadcast time is the whole point: the draw
   * RPC, the settle RPC, the row write and the table build all happen between
   * this line and the reveal, and they used to happen in FRONT of the wheel
   * instead of inside its hold.
   *
   * Clamped so the anchor can never be more than one full reveal in the past.
   * A row that was paid for minutes ago (a stalled game force-started by the
   * fully-paid watchdog) would otherwise produce a hold that has already
   * expired, and a wheel nobody can see is worse than a wheel that starts a
   * few seconds late.
   */
  protected stampSpinRevealAnchor(paidAtMs: number[]): void {
    if (this.spinRevealAt > 0) return; // stamped once per start
    const now = Date.now();
    const lastPaidAt = paidAtMs.length > 0 ? Math.max(...paidAtMs) : now;
    const earliest = now - spinRevealToDealMs();
    const anchor = Math.min(Math.max(lastPaidAt, earliest), now);
    this.spinRevealAt = anchor + SPIN_REVEAL.LEAD_IN_MS;
    this.spinHoldUntil = this.spinRevealAt + spinRevealToDealMs();
  }

  /**
   * The reveal instant and the hold deadline the broadcast actually uses.
   *
   * Normally these are the values stamped at the paid gate, so the wheel runs
   * its full sequence measured from the third payment. Two escape hatches:
   *
   *   - NO ANCHOR (a freeroll Spin, whose paid gate never runs because there is
   *     nothing to pay): fall back to the old behaviour, `Date.now()`.
   *   - THE WORK OVERRAN: if less than a countdown's worth of the animation is
   *     left, honouring the stamp would show a wheel that is already over. The
   *     reveal is re-stamped from now, and the overrun is REPORTED — this is
   *     the measurement the audit found missing.
   */
  protected resolveSpinReveal(): { revealAt: number; holdUntil: number } {
    const now = Date.now();
    if (this.spinRevealAt <= 0) {
      this.spinRevealAt = now;
      this.spinHoldUntil = now + spinRevealToDealMs();
      this.spinRevealLagMs = 0;
      return { revealAt: this.spinRevealAt, holdUntil: this.spinHoldUntil };
    }
    this.spinRevealLagMs = Math.max(0, now - this.spinRevealAt);
    if (this.spinHoldUntil - now < SPIN_REVEAL.COUNTDOWN_MS) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Spin start overran its own reveal window by ${this.spinRevealLagMs}ms — the wheel is being re-anchored to now, so the three players see it start late`
        ),
        'Tournament.spin_reveal_window_overrun'
      );
      this.spinRevealAt = now;
      this.spinHoldUntil = now + spinRevealToDealMs();
    }
    return { revealAt: this.spinRevealAt, holdUntil: this.spinHoldUntil };
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  A DRAWN BUTTON SURVIVES A RESTART (2026-08-27)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * The Spin button is drawn at random once the chips land and handed to the
   * engine through `setFirstButtonSeat`, which stores it in memory and consumes
   * it on the first deal. A restart in between lost it, and the rotation then
   * fell back to `buttonSeats[0]` — the lowest occupied seat, i.e. exactly the
   * deterministic edge the draw exists to remove. `restoreButtonFromHistory`
   * cannot cover this case either: it reads the last SETTLED hand, and there
   * isn't one yet.
   *
   * So the draw is written to `tables.first_button_seat` and re-applied here.
   *
   * ONLY WHILE THE TABLE HAS NEVER DEALT. Past the first hand the forced seat
   * would WIN over the live rotation (see ServerTableEngineDealing: a drawn
   * button beats `prevButtonSeat`), throwing the button backwards to where the
   * game started and taking the blinds again from everyone it skipped. So a
   * table with any hand history is skipped, and its stale column is cleared so
   * the question is never asked twice.
   */
  protected async restoreDrawnFirstButtons(
    tables: Array<{ id: string; first_button_seat?: number | null }>
  ): Promise<void> {
    const drawn = tables.filter((t) => Number(t?.first_button_seat) > 0);
    if (drawn.length === 0) return;
    for (const table of drawn) {
      const seat = Number(table.first_button_seat);
      try {
        const { count, error } = await supabase
          .from('hand_history')
          .select('id', { count: 'exact', head: true })
          .eq('table_id', table.id);
        if (error) {
          // Unreadable history is UNKNOWN, and the safe unknown here is "it may
          // already have dealt" — re-forcing the button on a live table is the
          // damaging direction.
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Could not check hand history for table ${table.id.slice(0, 8)} (${error.message}) — leaving the drawn button alone`
          );
          continue;
        }
        if ((count || 0) > 0) {
          await supabase.from('tables').update({ first_button_seat: null }).eq('id', table.id);
          continue;
        }
        this.tableEngines.get(table.id)?.setFirstButtonSeat(seat);
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Re-applied the drawn first button (seat ${seat}) to table ${table.id.slice(0, 8)} after a restart`
        );
      } catch (err) {
        reportError(err, 'Tournament.' + this.tournamentId.slice(0, 8) + '.first_button_restore');
      }
    }
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
    /**
     * D3: the same instant start() holds dealing until. Beats 1 and 2 are part
     * of the reveal, so they get the same short hub retention the wheel does —
     * a client that reconnects between the chips and the button still sees the
     * sequence rather than discovering it in a state diff. After this instant
     * the felt itself tells the story and the hub drops both.
     */
    const replayUntil = revealAt + spinRevealToDealMs();

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
            replay_until: replayUntil, // D3
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
           *
           * CRYPTO, NOT Math.random (2026-08-27). Every shuffle in this engine
           * already goes through CryptoRandom, for the reason stated in that
           * file: `Math.random()` is a predictable PRNG and this is a money
           * game. The first button on a 3-handed hyper is a real positional
           * edge, drawn once, in public, on a table where two of the three
           * players are horses — it belongs on the same generator as the deck.
           */
          const seat = seats[secureRandomInt(seats.length)];
          engine.setFirstButtonSeat(seat);
          /**
           * PERSISTED, BECAUSE A RESTART MUST NOT UNDO THE DRAW (2026-08-27).
           *
           * `setFirstButtonSeat` writes `forcedFirstButtonSeat`, which lives
           * only in engine memory and is consumed by the FIRST deal. A restart
           * between this draw and that deal threw it away, and the rotation
           * then fell back to `buttonSeats[0]` — the lowest occupied seat,
           * which is precisely the deterministic edge the comment above says
           * was removed. The window is real: the hold runs past this beat by
           * design, and a Spin that is restarted before its first hand has no
           * `hand_history` row for restoreButtonFromHistory to read either, so
           * nothing else could recover it.
           *
           * resume() reads this back and re-applies it, but ONLY while the
           * table has never settled a hand — see restoreDrawnFirstButtons.
           */
          void Promise.resolve(
            supabase.from('tables').update({ first_button_seat: seat }).eq('id', tableId)
          )
            .then(({ error }: { error: { message?: string } | null }) => {
              if (error) {
                console.warn(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Drawn button seat ${seat} not persisted for table ${tableId.slice(0, 8)} (${error.message}) — a restart before the first hand would revert it to the lowest seat`
                );
              }
            })
            .catch((err: unknown) => {
              // Fire-and-forget, so the rejection has nowhere else to go.
              console.warn(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Drawn button persist threw: ${(err as Error)?.message ?? err}`
              );
            });
          tableStateHub.emitEvent(tableId, {
            type: 'spin_button',
            table_id: tableId,
            tournament_id: this.tournamentId,
            dealer_seat: seat,
            timestamp: Date.now(),
            replay_until: replayUntil, // D3
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
    // max_players is read too: an ADOPTED table keeps the capacity it was
    // built with, which need not match the maxPerTable computed below (the
    // config may have changed, or the deck clamp may have lowered it). The
    // seating loop honours each table's own ceiling — see the capacity note
    // there.
    const { data: existingTables } = await supabase
      .from('tables')
      .select('id, max_players')
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

    /**
     * THE DECK HAS TO BE ABLE TO SERVE THE TABLE (2026-08-25).
     *
     * Cash tables have run through clampSeatsForVariant since the seat law was
     * written. Tournament tables never did - they took table_size verbatim, and
     * table_size knows nothing about how many hole cards the game deals.
     *
     * A 9-handed PLO6 table needs 9 x 6 = 54 hole cards plus a 5-card board
     * from a 52-card deck. It cannot be dealt, ever. ServerTableEngineDealing
     * refuses at deal time, sleeps 30s and returns WITHOUT dealing, so the
     * table sits at loopPhase 'dealing' having never dealt a card, the watchdog
     * eventually kills the engine, the reaper rebuilds it, and the new engine
     * refuses in exactly the same way. Permanent.
     *
     * Measured live 2026-08-25 before this fix: 58 of 70 PLO6 tournament tables
     * were seated beyond what their deck could serve (10 seated against a
     * ceiling of 7), and never-dealt rates were PLO6 36.5% / PLO5 35.9% against
     * NLH 22.3%. The whole 5-and-6-card excess is this one line.
     *
     * Clamped LAST so it wins over every branch above, including spin and sng.
     */
    const seatVariant = (tournament.game_type || '').toLowerCase();
    const deckSafe = clampSeatsForVariant(seatVariant, maxPerTable);
    if (deckSafe !== maxPerTable) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] ${seatVariant || 'nlh'} seats ${maxPerTable} -> ${deckSafe} (deck cannot serve more)`
      );
      maxPerTable = deckSafe;
    }

    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A TABLE COUNT THAT IGNORES HOW FULL THE TABLES ARE (2026-08-25)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This was `ceil(players.length / maxPerTable) - existingTables.length`,
     * which assumes every adopted table is EMPTY. Adoption exists precisely
     * because they are not.
     *
     * Worked example, and it is the live one: a tournament with one adopted
     * table already holding 9 of its 9 seats and 10 entrants asks for
     * ceil(10 / 9) = 2 tables, already has 1, and creates 1. Two table ids.
     * The round-robin below then hands entrant #10 to index 0 — the FULL
     * table — and the old seat scan, `while (taken.has(n)) n++` with no
     * ceiling at all, dutifully returned seat 10.
     *
     * Measured live 2026-08-25 07:41-07:42: "Turbo Tuesday Graveyard" tables
     * 44 through 56 each carry a live seat at seat_number 10 on max_players 9,
     * one of them with 10 live seats; 54 such seats across 53 tournament
     * tables platform-wide. A seat past the table's own ceiling is not
     * cosmetic — it is the deck-exhaustion deadlock (#782) reopened through a
     * different door, because clampSeatsForVariant clamps `max_players` and
     * this loop then walked straight past it.
     *
     * The shortfall is now measured in SEATS, against the real free capacity
     * of the tables the tournament already has.
     */
    const alreadyHave = (existingTables ?? []).length;
    const toSeatCount = players.filter((p: any) => !alreadySeated.has(p.user_id)).length;
    let freeSeatsNow = 0;
    for (const t of existingTables ?? []) {
      const cap = Math.max(0, Number((t as any).max_players) || maxPerTable);
      const used = occupiedSeats.get(t.id)?.size ?? 0;
      freeSeatsNow += Math.max(0, cap - used);
    }
    const seatShortfall = Math.max(0, toSeatCount - freeSeatsNow);
    const tablesToCreate = Math.ceil(seatShortfall / maxPerTable);

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
          // 2026-08-25: rabbit hunt is gated on tables.allow_rabbit_hunt, which
          // a cash host sets at table creation. Tournament tables never set it,
          // so every MTT, Spin and Heads Up table inherited the column default
          // and a tournament host had no way to turn the feature off — a
          // setting that cannot be changed is not a setting. Carried from the
          // tournament's own toggle, defaulting ON so nothing in flight changes.
          allow_rabbit_hunt: tournament.allow_rabbit_hunt !== false,
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
    /**
     * Every table's own ceiling. An adopted table keeps the max_players it was
     * built with; a table created moments ago holds maxPerTable. Nothing below
     * may write a seat number above the value here — that is the whole point
     * (see the table-count note above for the 54 live seats that proves it).
     */
    const capacityOf = new Map<string, number>();
    for (const t of existingTables ?? []) {
      capacityOf.set(t.id, Math.max(1, Number((t as any).max_players) || maxPerTable));
    }
    for (const id of tableIds) {
      if (!capacityOf.has(id)) capacityOf.set(id, maxPerTable);
    }

    // Round-robin CURSOR rather than `i % tableIds.length`: the modulo hands a
    // player to a fixed table whether or not that table has a seat left, which
    // is how a full adopted table was handed an eleventh player.
    let cursor = 0;
    for (let i = 0; i < toSeat.length; i++) {
      /**
       * THE SNAPSHOT IS NOT THE CHECK (2026-08-25).
       *
       * `alreadySeated` is read ONCE, above, and this loop then writes one
       * seat per statement for the whole field — five minutes on a 497-entrant
       * freeroll. A second pass over the same tournament (a re-entered start,
       * a resume, a second engine instance) takes its own snapshot inside that
       * window, sees every not-yet-written player as unseated, and seats them
       * again at a different table. `idx_unique_active_user_per_table` is
       * scoped to ONE table, so it cannot object.
       *
       * Live footprint on `bae46dbf` 2026-08-25: 72 players holding 144 live
       * seats, 46 of the pairs exactly 14 tables apart — two round-robin
       * cursors, this loop, running twice. Both seats were dealt and both
       * stacks diverged.
       *
       * So the seat is claimed against the DATABASE, immediately before the
       * write. A player who has acquired a seat since the snapshot is skipped,
       * and an unreadable answer skips too: the 5s seat sweep will seat them
       * on a later pass, and a guess here is a double stack.
       */
      const claim = await mayTakeSeat(supabase, this.tournamentId, toSeat[i].user_id);
      if (!claim.allowed) {
        if (claim.unknown) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Not seating ${toSeat[i].user_id.slice(0, 8)} — ${claim.reason}. Leaving them to the 5s seat sweep rather than risking a second live seat.`
            ),
            'Tournament.seat_claim_unreadable'
          );
        }
        continue;
      }

      // Next table, from the cursor, that has a genuinely free seat number
      // within its own capacity.
      let tableId: string | null = null;
      let seatNumber = 0;
      for (let probe = 0; probe < tableIds.length; probe++) {
        const candidate = tableIds[(cursor + probe) % tableIds.length];
        const cap = capacityOf.get(candidate) ?? maxPerTable;
        const taken = occupiedSeats.get(candidate) ?? new Set<number>();
        let n = 1;
        while (n <= cap && taken.has(n)) n++;
        if (n <= cap) {
          tableId = candidate;
          seatNumber = n;
          cursor = (cursor + probe + 1) % tableIds.length;
          break;
        }
      }

      if (!tableId) {
        /**
         * Every table is genuinely full. The seat sizing above is meant to make
         * this unreachable, so it means a table INSERT failed and was skipped
         * (see the `continue` in the creation loop). LEAVING THE PLAYER
         * UNSEATED IS DELIBERATE: the alternative is the seat past the table's
         * ceiling that this whole block exists to stop. ensureLateRegSeated
         * runs every five seconds and seats them the moment a seat exists, and
         * checkDynamicTableExpansion builds one; both respect the ceiling.
         */
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] No seat within capacity for ${toSeat.length - i} player(s) across ${tableIds.length} table(s) — leaving them unseated for the 5s seat sweep rather than writing a seat past a table's max_players`
          ),
          'Tournament.seating_capacity_exhausted'
        );
        break;
      }

      const taken = occupiedSeats.get(tableId) ?? new Set<number>();
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
        continue;
      }

      /**
       * THE ROSTER MUST KNOW WHERE THE PLAYER IS SITTING (2026-08-24).
       *
       * This wrote the table_seats row and stopped, leaving
       * tournament_players.table_id NULL for the entire start-seated field.
       * Only ensureLateRegSeated and the table-move path ever set it, so the
       * column was a lie for anyone who entered before the cards were in the
       * air: measured in production, 166 of 297 live entrants, every one of
       * them genuinely seated. Everything that navigates by that column was
       * broken for more than half the field, including TournamentDetails'
       * "go to my table" links, which resolved to /table/undefined.
       *
       * Written after the seat and skipped when the seat insert failed, so the
       * roster can never claim a seat the player does not hold.
       */
      const { error: rosterErr } = await supabase
        .from('tournament_players')
        .update({ table_id: tableId, seat_number: seatNumber })
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', toSeat[i].user_id);
      if (rosterErr) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] seated ${toSeat[i].user_id.slice(0, 8)} but could not record the table on the roster: ${rosterErr.message}`
          ),
          'Tournament.roster_table_id_write_failed'
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  THE BLINDS PAST THE END OF THE STRUCTURE ARE DERIVED, NEVER STORED
   *  (2026-08-27, P0)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Every preset structure is 10-12 levels long and tournaments routinely run
   * past the last one, so `advanceBlindLevel` has always had to invent levels
   * beyond the end. It used to do it like this:
   *
   *     const escalationFactor = Math.pow(2, this.currentLevel - blindStructure.length + 1);
   *     ...
   *     blindStructure.push(autoLevel);   // mutates the cached array
   *
   * The factor is anchored to `blindStructure.length`, and the push MOVES that
   * anchor. In steady state the two stay in lockstep — every push happens with
   * `currentLevel === blindStructure.length`, so the factor is always 2 and the
   * blinds double once per level, correctly.
   *
   * A RESTART BREAKS THE LOCKSTEP. `resume()` re-reads `blind_structure` fresh
   * from the row (the pushed levels were never persisted — the column is TEXT
   * holding the ORIGINAL JSON, and it must stay that way) while `currentLevel`
   * comes back from `tournaments.current_level`. So a tournament that had
   * reached level 13 on a 10-row structure resumes with length 10 and level 13:
   *
   *   first overflow  factor 2^(14-10+1) = 32  -> base x 32   (correct)
   *   push            length becomes 11
   *   next overflow   factor 2^(15-11+1) = 32  -> base x 1024 (32 x 32)
   *   next            base x 1,048,576, then clamped at MAX_BLIND_VALUE
   *
   * Three levels from a restart to a 10,000,000 big blind. Measured shape:
   * 24,000 -> 48,000 -> 1,536,000. Every reader that clamps its display to the
   * last persisted row (the break card, the lobby, expansion-table `stakes`)
   * went on showing 750/1500 while the felt played 12,000/24,000.
   *
   * THE FIX IS TO STOP STORING THE ANSWER. `blindStructure.length` is the
   * PERSISTED length and nothing mutates it any more, so
   * `2^(index - length + 1)` applied to the last playable persisted level is
   * the same number on every call, in every process, before and after a
   * restart — deterministic and stateless, so there is nothing to persist and
   * nothing that can drift. (Persisting the generated levels was the other
   * option and it is the worse one: `tournaments.blind_structure` is TEXT
   * holding the structure the tournament was ADVERTISED with, every write
   * lengthens it, and a lengthening anchor is the bug itself.)
   *
   * Callers must therefore read levels through THIS function rather than
   * indexing the array, or a tournament past the end reads the last persisted
   * row instead of what it is actually playing.
   */
  protected resolveBlindLevel(blindStructure: any[], index: number): any {
    if (!Array.isArray(blindStructure) || blindStructure.length === 0) return null;
    const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0;
    if (i < blindStructure.length) return blindStructure[i] ?? blindStructure[0];

    const lastLevel = blindStructure[lastPlayableIndex(blindStructure)];
    return escalatedBlindLevel(
      lastLevel,
      i,
      // The PERSISTED length. Nothing mutates this array any more; that is what
      // makes the answer identical across a restart.
      blindStructure.length,
      // Format-normalized, and halved for an accelerated MTT past late reg —
      // engine state, which is why the pure module takes it as an argument.
      this.levelDurationMs(lastLevel) / 60000
    );
  }

  protected startBlindTimer(blindStructure: any[], remainingOverrideMs?: number): void {
    if (blindStructure.length === 0) return;
    // Never leave two level clocks running for the same tournament. Callers
    // normally arrive with blindTimer already null (it has just fired, or
    // pauseForBreak cleared it), but a double-arm doubles the escalation rate
    // for the rest of the tournament and is invisible until the blinds run
    // away, so it is worth one clearTimeout to make it impossible.
    if (this.blindTimer) {
      clearTimeout(this.blindTimer);
      this.blindTimer = null;
    }
    // Past the end of the structure this synthesizes the level rather than
    // clamping to the last persisted row — see resolveBlindLevel.
    const currentLevelData =
      this.resolveBlindLevel(blindStructure, this.currentLevel) || blindStructure[0];
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

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  NO LEVEL ADVANCES DURING A BREAK (2026-08-25)
         * ═══════════════════════════════════════════════════════════════════
         *
         * A break is supposed to stop the level clock, and the only mechanism
         * that did so was pauseForBreak clearing `blindTimer`. That covers a
         * timer already armed. It does NOT cover a timer armed AFTER the break
         * began — and the tail of this very method arms one unconditionally.
         *
         * suspendLevelClock already documents the window: `blindTimer is
         * legitimately null for seconds at a time: advanceBlindLevel consumes
         * it on fire and does not re-arm until it has awaited a blind write per
         * table, the current_level persist, the level_up broadcast and possibly
         * a prize-pool finalization. A :55 break inside that window is exactly
         * the case that killed the clock.` That fix taught suspendLevelClock to
         * save a full level rather than 0. It left the other half open: the
         * in-flight transition then went on to arm a LIVE full-length timer,
         * which ran through the entire break.
         *
         * A break is five minutes plus up to two minutes of last-hand grace.
         * Every turbo, hyper-turbo and Spin level is shorter than that, so the
         * armed timer FIRES mid-break: the blinds jump while the field is
         * behind the break overlay, this method arms yet another timer, and the
         * level can advance TWICE inside one break. resumeFromBreak then hands
         * the level that just advanced the full duration saved at :55, so the
         * clock is reset on top of it.
         *
         * Two guards, one at each end:
         *
         *   HERE — a level that comes due during a break is not advanced. It is
         *   owed, so 1 s is handed to resumeFromBreak (startBlindTimer clamps
         *   the override to at least 1000 ms) and the level goes up the instant
         *   play resumes, rather than during the break or not at all.
         *
         *   AT THE TAIL — if a break began while this transition was in flight,
         *   the next level's full duration is handed to resumeFromBreak instead
         *   of being armed as a live timer.
         */
        if (this.onBreak) {
          this.savedBlindTimerRemaining = 1000;
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Level was due during a break — holding it until play resumes`
          );
          return;
        }

        const prevLevel = this.currentLevel;
        this.currentLevel++;

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  STRUCTURE BREAK ROWS ARE STEPPED OVER, NOT SAT ON (2026-08-23)
         * ═══════════════════════════════════════════════════════════════════
         *
         * Dan: breaks are the :55 of the hour and nothing else.
         *
         * Every default structure nonetheless carries isBreak rows — hyperTurbo
         * at indices 7, 13, 19 and 25, turbo and the rest on the same cadence —
         * and this used to be handled further down as:
         *
         *     if (level.isBreak) { this.startBlindTimer(blindStructure); return; }
         *
         * which was the worst of both worlds. It armed a timer for the break
         * row's five minutes and returned, so for those five minutes: no table
         * was paused and no break screen was shown (players simply kept
         * playing), the blinds stayed at the PREVIOUS level, `current_level`
         * was never persisted — so the SQL late-registration gate read a stale
         * level for the whole window — and the late-reg close and add-on
         * trigger below were skipped entirely. A break row sitting on the
         * cutoff level could swallow the add-on window for good.
         *
         * Break rows are now consumed with no time cost: step past them to the
         * next playable level and run one complete transition. This runs
         * BEFORE the auto-escalation check so that walking off the end through
         * trailing break rows escalates normally instead of clamping.
         */
        while (
          this.currentLevel < blindStructure.length &&
          blindStructure[this.currentLevel]?.isBreak
        ) {
          this.currentLevel++;
        }

        /**
         * PAST THE END OF THE STRUCTURE, THE LEVEL IS DERIVED (2026-08-27).
         *
         * This used to compute the escalated level here and then
         * `blindStructure.push(autoLevel)` it onto the cached array — which
         * moved the very anchor the escalation factor is measured from, so
         * after a restart the blinds went up 32x, then 1024x, then clamped at
         * ten million within three levels. resolveBlindLevel carries the whole
         * derivation and the full defect note; the array is never mutated
         * again, which is what makes the answer identical across restarts.
         */
        const level = this.resolveBlindLevel(blindStructure, this.currentLevel);
        if (!level) return;
        if (level.autoEscalated === true) {
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Auto-escalated blinds (level ${this.currentLevel}, structure has ${blindStructure.length}): ${level.smallBlind}/${level.bigBlind} ante ${level.ante}`
          );
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
              /**
               * KEEP `stakes` HONEST (2026-08-23).
               *
               * createTablesAndSeatPlayers writes `stakes` once, as the level-1
               * blinds, and this update never touched it — so the denormalised
               * string stayed frozen at the opening level for the life of the
               * tournament while the numeric columns advanced beside it.
               * Measured on "Prime Time Main Event (NLH) - Table 4": stakes
               * '25/50' against small_blind 750 / big_blind 1500. Every reader
               * that trusts `stakes` (the table masthead, the lobby rows, and
               * therefore every seat's BB depth badge) was reporting the wrong
               * level's blinds, and stack depths thirty times too deep.
               */
              stakes: `${safeSmallBlind}/${safeBigBlind}`,
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
        const prevLevelData =
          this.resolveBlindLevel(blindStructure, prevLevel) || blindStructure[0];
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
            // GUARANTEE (2026-08-27): the pool stops moving here, so this is
            // where the advertised guarantee becomes real money — and money is
            // MOVED, not declared. applyPrizeGuarantee carries the full note.
            const finalPool = await this.applyPrizeGuarantee('late_reg_close');
            if (finalPool !== null) {
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Late reg/rebuy closed at level ${this.currentLevel} — prize pool finalized: ${finalPool}`
              );
            }
            // The close is still announced when funding failed — late
            // registration really is shut, and a client that never hears it
            // keeps offering a seat nobody can take. What is NOT announced is
            // a made-up pool: on failure the last known accrued pool is sent,
            // never a zero and never a locally computed max(pool, gtd).
            await this.broadcast('late_reg_closed', {
              prizePool: finalPool ?? (Number(this.tournamentCache?.prize_pool) || 0),
            });
            if (finalPool !== null) {
              await this.recalculateEliminatedPrizes(finalPool);
            }
          }
        }

        // ── ADD-ON PERIOD TRIGGER (level-based) ──
        // When blind level passes the late reg/rebuy cutoff and add-on is available
        if (this.tournamentCache?.add_on_available && !this.addOnPeriodTriggered) {
          const rebuyLevelCap =
            this.tournamentCache.late_reg_levels ?? this.tournamentCache.rebuy_levels ?? 8;
          /**
           * LEVEL-BASED, NOT EDGE-BASED (2026-08-23). This was
           * `prevLevel < cap && this.currentLevel >= cap` — an edge, and an
           * edge is a single instant that is easy to miss and impossible to
           * recover:
           *
           *   - resume() restores currentLevel straight from the database. A
           *     redeploy while the tournament was already past the cutoff put
           *     prevLevel past it too, so the edge never came again and the
           *     add-on window never opened for the life of the tournament.
           *   - the old isBreak early-return skipped this check entirely, so a
           *     break row on the cutoff level consumed the only crossing.
           *
           * The late-reg finalization block directly above has always been
           * level-based (`>= cap`) for the same reason. Idempotency does not
           * depend on the edge: addOnPeriodTriggered guards the outer `if`,
           * and triggerAddOnPeriod re-checks and persists it.
           */
          if (this.currentLevel >= rebuyLevelCap) {
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

        // Schedule the next level (waits the new level's duration, then
        // advances) — unless a break began while this transition was in flight,
        // in which case the clock belongs to resumeFromBreak. Arming a live
        // timer here is what let a level advance during a break; see the guard
        // at the top of this method for the full defect.
        if (this.onBreak) {
          this.savedBlindTimerRemaining = this.levelDurationMs(level);
        } else {
          this.startBlindTimer(blindStructure);
        }
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
          // An add-on break is a break: nothing new is dealt during it.
          engine.pauseAfterHand(breakMs + TournamentManagerBase.LAST_HAND_GRACE_MS, {
            beforeNextHand: true,
          });
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

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  A GUARANTEE IS FUNDED, NOT DECLARED (2026-08-27, P0)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * All three sites that close a prize pool used to do this:
   *
   *     const finalPool = effectivePrizePool(freshT.prize_pool, freshT.guaranteed_prize);
   *     await supabase.from('tournaments').update({ prize_pool: finalPool, ... });
   *
   * `effectivePrizePool` is `Math.max`. Where the guarantee beat the entries,
   * the overlay was simply WRITTEN INTO `prize_pool` and then paid out to real
   * wallets. Nothing was debited from anything. The chips did not come from the
   * club treasury, from a reserve, or from any ledger row — they were created
   * by an assignment. Measured: 2,823 completed guaranteed events with no
   * overlay row at all, 1,492 of them accounting for 98,253.32 chips of
   * unfunded overlay, and Midway Union's treasury sitting at -4,346.80.
   *
   * `fn_apply_prize_guarantee` is the correct implementation. In one
   * transaction it takes the row lock, writes a `tournament_guarantee_overlays`
   * row, DEBITS `clubs.chip_treasury` by the overlay, raises a critical
   * `financial_alerts` row if that drives the treasury negative, and only then
   * sets `prize_pool` and `prize_pool_finalized`. It is idempotent twice over —
   * `already_finalized` short-circuits, and the overlay row has ON CONFLICT
   * (tournament_id) — so a retry, a double level-up or a restart cannot fund
   * the same overlay twice.
   *
   * THE POOL COMES BACK FROM THE RPC. Computing one locally and writing it is
   * how the two disagreed in the first place, so this returns the RPC's number
   * or NOTHING. Having ONE implementation is the other half of the fix: three
   * hand-rolled copies of this call is how one of them grew a local fallback.
   *
   * Returns the funded pool, or `null` when the call could not be completed —
   * in which case the caller must NOT invent a pool. A null is reported and
   * leaves the row un-finalized so a later pass (or
   * `fn_sweep_unfunded_guarantees`) can re-drive it; the tournament keeps
   * playing either way, because tournaments run.
   */
  protected async applyPrizeGuarantee(source: string): Promise<number | null> {
    try {
      const { data, error } = await supabase.rpc('fn_apply_prize_guarantee', {
        p_tournament_id: this.tournamentId,
        p_source: source,
      });
      const res = (data ?? {}) as {
        ok?: boolean;
        reason?: string;
        prize_pool?: number | string;
        overlay?: number | string;
        treasury_after?: number | string | null;
      };
      if (error || res.ok !== true) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Prize guarantee could not be funded (${error?.message ?? res.reason ?? 'unknown'}) — the pool is NOT being bumped locally; no chips are being created`
          ),
          'Tournament.prize_guarantee_unfunded'
        );
        return null;
      }
      const pool = Number(res.prize_pool);
      if (!Number.isFinite(pool)) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] fn_apply_prize_guarantee returned no readable prize_pool (${JSON.stringify(data ?? null).slice(0, 160)})`
          ),
          'Tournament.prize_guarantee_unreadable_pool'
        );
        return null;
      }
      this.prizePoolFinalized = true;
      if (this.tournamentCache) this.tournamentCache.prize_pool = pool;
      const overlay = Number(res.overlay) || 0;
      if (overlay > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Guarantee FUNDED via ${source}: overlay ${overlay} debited from the club treasury (now ${res.treasury_after ?? 'unknown'}), pool ${pool}`
        );
      }
      return pool;
    } catch (err) {
      reportError(err, 'Tournament.prize_guarantee_threw');
      return null;
    }
  }

  protected async finalizeAfterAddOn(): Promise<void> {
    if (this.prizePoolFinalized) return;

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] ADD-ON PERIOD ENDED at level ${this.currentLevel} — finalizing prize pool`
    );

    this.prizePoolFinalized = true;
    // GUARANTEE (2026-08-27): same rule as the late-reg-close site — the pool
    // is final now, so the advertised guarantee is FUNDED here (not declared).
    const finalPool = await this.applyPrizeGuarantee('addon_period_end');
    if (finalPool !== null) {
      await this.recalculateEliminatedPrizes(finalPool);
    }

    await this.broadcast('ADDON_PERIOD_END', {});
  }

  protected isProcessingEliminations = false;

  // ── Implemented by TournamentManagerEliminations (layer 2/3) ──
  protected abstract startEliminationChecker(): void;
  protected abstract recalculateEliminatedPrizes(finalPrizePool: number): Promise<void>;
}
