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
import { isDeepStrictEqual } from 'node:util';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { supabase } from '../services/supabase.js';
import { ChipRaceEngine } from '../engine/ChipRaceEngine.js';
import { TableBalancer } from '../engine/TableBalancer.js';
import {
  SPIN_TIERS,
  SPIN_REVEAL,
  spinRevealToDealMs,
  spinRevealTotalMs,
  spinPostRevealMs,
  SPIN_SEATS as SPEC_SPIN_SEATS,
  spinTier,
  spinRakeRate,
  spinBlindsForLevel,
} from '../config/spinSpec.js';
import { reportError } from '../services/errorReporter.js';
import { selectInChunks } from '../services/supabase/chunkedIn.js';
/**
 * THE TOURNAMENT CEILING IS THE DECK, NOT THE CASH SEAT LAW (2026-08-31).
 *
 * This line used to import `clampSeatsForVariant` from
 * `../config/tableSeating.js`. That module's own header says CASH GAMES ONLY —
 * "Nothing here may be applied to a table with a tournament_id" — and the
 * client copy carries Dan verbatim: "WHAT I GAVE YOU WAS FOR CASH GAMES ONLY,
 * YOU CAN NOT RUN IT TWO OR THREE TIMES IN A TOURNAMENT". The cash cap is
 * deliberately TIGHTER than the deck so Run It Twice still has three boards to
 * come out of (PLO6 dies at 7 seats: 52 - 6n >= 15 means n <= 6). Run It Twice
 * is hard-disabled on a tournament table — ServerTableEngineBase, `ritIsTournament`
 * forces `ritEnabled` false — so a tournament was paying that seat for a board
 * it can never be dealt.
 *
 * REUSED, not copied. `maxSeatsFor` is floor((deck - 5) / holeCards), which
 * already exists in exactly two places: here, and `maxSeatsTheDeckAllows` in
 * src/config/tableSeating.ts, which the browser bundle needs because it cannot
 * import from server/. A third copy of the formula would be a third thing to
 * keep in step; importing the engine's own module keeps the number the deal
 * path uses and the number the seating path uses the same by construction.
 */
import { maxSeatsFor as maxSeatsTheDeckAllows } from '../engine/VariantRules.js';
import { tableStateHub } from '../transport/TableStateHub.js';
import { refundAndCloseCancelledTournament } from './tournamentRecovery.js';
import { acceleratedLevelMs } from './acceleratedLevels.js';
import { spinRevealWouldSkipABeat, spinRevealLag } from './spinRevealWindow.js';
import { SpinOverrunReporter, describeOverrun } from './spinOverrunReporter.js';
import { isShortFormat, mayTakeSynchronizedBreak } from './breakEligibility.js';
import {
  capLevelToChipsInPlay,
  escalatedBlindLevel,
  lastPlayableIndex,
} from './blindEscalation.js';
import { observedStepRatio } from './blindLadder.js';
import { isSpinTournament } from './payoutStructure.js';
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
import { selectSeatsToFund, tournamentChipSupply } from './seatStackCredit.js';
import { applySpinDrawPatch } from './spinDrawSync.js';
import type { GameServer } from '../GameServer.js';
import { tournamentEliminationScheduler } from './TournamentEliminationScheduler.js';
import {
  TournamentLifecycleAbortedError,
  TournamentLifecycleEpoch,
  type TournamentLifecycleToken,
} from './TournamentLifecycleEpoch.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { horseAddsOnImmediately } from '../services/FreeBuy.js';
import { tournamentLeaseMonotonicNow } from '../services/tournamentLease.js';
import { bindTournamentDataAuthorityMethods } from '../services/supabase/dataActorContext.js';
import {
  publicTournamentTableFormat,
  type PublicLiveTableFormat,
} from '../observability/liveTableFormat.js';

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

interface TournamentEntryWindowResult {
  ok?: boolean;
  reason?: string;
  entry_closed?: boolean;
  window_mode?: 'levels' | 'minutes' | 'immediate';
  close_mode?: 'levels' | 'minutes' | 'immediate' | 'addon';
  retry_after_ms?: number | string | null;
  finalized?: boolean;
  finalization_deferred?: boolean;
  prize_pool?: number | string;
  payout_structure?: unknown;
  reprice_pending?: boolean;
}

interface TournamentLaunchBeginResult {
  ok?: boolean;
  claimed?: boolean;
  launch_id?: string;
  started_at?: string;
  replay?: boolean;
  completed?: boolean;
  status?: string;
  reason?: string;
  lease_generation?: string;
}

interface TournamentLaunchClaim {
  launchId: string;
  startedAtIso: string;
  completed: boolean;
}

interface TournamentLaunchCompleteResult {
  ok?: boolean;
  completed?: boolean;
  status?: string;
  started_at?: string;
  completed_at?: string;
  replay?: boolean;
  reason?: string;
  lease_generation?: string;
}

export abstract class TournamentManagerBase {
  protected tournamentId: string;
  protected gameServer: GameServer;
  /** Opaque database authority generation held for this manager's lifetime. */
  protected readonly tournamentLeaseGeneration: string | null;
  private tournamentLeaseProofDeadlineMonotonicMs: number | null;
  private tournamentLeaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private tournamentLeaseAuthorityExpired = false;
  protected running: boolean = false;
  /**
   * Exact ownership of asynchronous manager work.
   *
   * A boolean cannot distinguish a stopped generation from a replacement that
   * has since set the same boolean true. Every start/resume and every delayed
   * callback is bound to one token; stop aborts it synchronously before any
   * teardown await can yield.
   */
  private readonly lifecycleEpoch = new TournamentLifecycleEpoch();
  private lifecycleOperation: Promise<void> | null = null;
  private teardownPromise: Promise<void> | null = null;
  /** The synchronous half of stop may be applied before the graceful table drain. */
  private stopFenceApplied = false;
  /** Manager callbacks are stopped while its lease remains live for hand drain. */
  private shutdownDrainFenceApplied = false;
  private readonly lifecycleTimeouts = new Set<ReturnType<typeof setTimeout>>();
  private readonly lifecycleIntervals = new Set<ReturnType<typeof setInterval>>();
  /** Async work launched by lifecycle timers or table-engine starts. */
  private readonly lifecycleJobs = new Set<Promise<unknown>>();
  /** Starts must settle before start/resume may advertise admission complete. */
  private readonly tableEngineStartJobs = new Set<Promise<void>>();
  /** Full start loops may wait for players; stop engines before draining these. */
  private readonly tableEngineRunJobs = new Set<Promise<void>>();
  /** One live teardown/replacement operation per exact dealer generation. */
  private readonly tableEngineRecoveries = new WeakMap<ServerTableEngine, Promise<void>>();
  /** One causally-triggered retry per durable table; healthy tables arm none. */
  private readonly tableEngineRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly tableEngineRecoveryAttempts = new Map<string, number>();
  /** Scheduler runs are separate because a finish can initiate stop from inside one. */
  private readonly eliminationSchedulerJobs = new Set<Promise<void>>();
  protected blindTimer: NodeJS.Timeout | null = null;
  /** Removes this manager from the one process-wide elimination scheduler. */
  protected eliminationSchedulerUnregister: (() => void) | null = null;
  /** Current admitted sweep signal, visible to long mutating helper loops. */
  protected eliminationSweepSignal: AbortSignal | null = null;
  /** Cooperative wall-clock deadline for one admitted unit of sweep work. */
  protected eliminationSweepDeadlineAt = 0;
  /** A durable unanimous-vote event bypasses the defensive 10s vote throttle. */
  protected forceFinalTableDealCheck = false;
  /**
   * Exact durable browser-action rows admitted but not yet fully executed.
   * PostgreSQL identity allocation is not commit ordered, so a scalar high
   * water mark can acknowledge an older id that committed after the snapshot.
   */
  protected readonly pendingManagerWakes = new Map<number, string>();
  protected tableEngines: Map<string, ServerTableEngine> = new Map();
  protected currentLevel: number = 0;
  // Add-on period
  protected addOnPeriodTriggered: boolean = false;
  /** Prevent two async level/hand edges from opening the same persisted window. */
  protected addOnPeriodOpening: boolean = false;
  /** One close check for the persisted window; re-arming replaces the old one. */
  private addOnPeriodEndTimer: NodeJS.Timeout | null = null;
  /** Bounded delivery retry for the shifted deadline after maintenance thaw. */
  private addOnResumeBroadcastRetryTimer: NodeJS.Timeout | null = null;
  private addOnResumeBroadcastRetryAttempts = 0;
  /** Durable add-on break timers are reconstructed from addon_period_ends_at. */
  private addOnBreakStartTimer: NodeJS.Timeout | null = null;
  private addOnBreakEndTimer: NodeJS.Timeout | null = null;
  private addOnBreakActive = false;
  /** Durable end inherited by replacement dealers while the add-on break is active. */
  private addOnBreakEndsAtMs = 0;
  /** The add-on may own the level clock even when hand-for-hand owns dealer pause. */
  private addOnBreakOwnsLevelClock = false;
  private addOnBreakOwnsPause = false;
  /** Bounded, no-money replay of a committed add-on's operational tail. */
  private addOnFinalTailReplayTimer: NodeJS.Timeout | null = null;
  private addOnFinalTailReplayAttempts = 0;
  /** Prevent a level edge and the wall-clock timer from finalizing together. */
  private addOnPeriodFinalizing: boolean = false;
  /**
   * When the add-on was last offered to the field. The window is offered
   * REPEATEDLY, not once, so a player who was between seats at the moment it
   * opened still gets theirs -- see tryTournamentAddOns.
   */
  protected lastAddOnOfferAt: number = 0;
  /** Preserve the pre-scheduler add-on retry cadence without per-manager timers. */
  static readonly ADD_ON_RETRY_MS = 20_000;
  /** Poll an enabled deal only after this manager has confirmed one final table. */
  static readonly FINAL_TABLE_DEAL_POLL_MS = 10_000;
  /** A full table promotes a registrant before expansion; re-drive that handoff promptly. */
  static readonly LATE_REG_REDRIVE_MS = 5_000;
  /** Preserve fast recovery while a known zero-stack player is unresolved. */
  static readonly UNRESOLVED_BUST_RETRY_MS = 5_000;
  /** Re-check only a tournament whose balancer proved work remains. */
  static readonly BALANCE_REDRIVE_MS = 5_000;
  /**
   * One admitted scheduler job may finish at most this many per-player/table
   * mutations before yielding its physical slot and urgently requeueing the
   * continuation. This is a work budget, not a timeout: the live promise is
   * never released while it is still mutating.
   */
  static readonly SWEEP_MUTATION_BATCH_SIZE = 20;
  /** Yield before one tournament can monopolize a physical scheduler slot. */
  static readonly SWEEP_WORK_BUDGET_MS = 5_000;
  /** Horses already offered the current add-on window in this process. */
  protected addOnAttemptedHorseIds = new Set<string>();
  /** Round-robin cursor keeps one transient refusal from starving the field. */
  protected addOnBatchCursor = 0;
  protected pendingAddOnPeriod: boolean = false;
  // Hand-for-hand bubble
  protected handForHandActive: boolean = false;
  protected handForHandAnnounced: boolean = false;
  /** Stable table membership for the active barrier, including a recovering id. */
  private readonly handForHandTableIds = new Set<string>();
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
  protected handForHandRePauseTimer: NodeJS.Timeout | null = null;
  // Late reg finalization
  protected prizePoolFinalized: boolean = false;
  /** Database-authoritative entry-window state; never inferred from host time. */
  protected tournamentEntryWindowClosed: boolean = false;
  /** One exact deadline timer for a minutes-only window in this lifecycle. */
  private tournamentEntryCloseTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialize timer, level-change, wake and resume attempts inside one manager. */
  private tournamentEntryCloseOperation: Promise<boolean> | null = null;
  /** A reconnect may replay the durable close receipt; announce the edge once. */
  private tournamentEntryCloseAnnounced: boolean = false;
  /** Local hint; the database receipt remains the crash-safe authority. */
  protected tournamentEntryRepricePending: boolean = false;
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
   * used to run every five seconds. So at t+5s it synced
   * `table_seats.stack` (still 0) into
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
   * ── THE PRE-SEAT MINUTE (Dan 2026-08-30) ──
   *
   * How far ahead of the advertised `start_time` this start() ran, in ms, or 0
   * for a start at or past it. GameServer discovers a timed event
   * TOURNAMENT_PRESEAT_LEAD_MS early so the field is SEATED before the clock;
   * this number is what stops the poker moving with it. Two consumers, both in
   * start(): the `holdDealingUntil` deadline on every table, and the level
   * clock, which is armed after this lead rather than at seating so level 1 is
   * a full level of cards instead of a minute of waiting plus nine of poker.
   *
   * Read it as "time the felt owes the clock", not as a state — nothing outside
   * start() branches on it, and it is 0 for every seat-first game and for every
   * event started late.
   */
  protected preStartLeadMs: number = 0;
  /** Extra time after deferred Spin chips land before any bust may be ruled. */
  static readonly POST_CREDIT_BUST_SLACK_MS = 5000;
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
  /**
   * Tables the paid seats are already sitting at, read for free alongside the
   * paid-entry roster. A seat-first player is on the felt before the game
   * starts, so this is where the wheel has to reach them (round 18).
   */
  protected seatFirstTableIds: string[] = [];
  /**
   * Has the reveal already gone out? Once it has, the moment is PUBLIC and
   * `resolveSpinReveal` must never re-anchor it — three players are already
   * animating against those numbers, and moving them would desynchronise the
   * one thing the whole anchor exists to keep in step.
   */
  protected spinRevealEmitted = false;
  // Tournament metadata cache
  protected tournamentCache: any = null;
  // FIX 151: ChipRaceEngine for denomination removal on level-up
  protected chipRaceEngine: ChipRaceEngine = new ChipRaceEngine((event) => {
    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] ChipRace: ${event.type}`);
  });
  // FIX 154: TableBalancer for proper gap-1 rebalancing across tournament tables
  protected tableBalancer: TableBalancer = new TableBalancer((event) => {
    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] TableBalance: ${event.type} - ${(event as any).moveCount || 0} moves`
    );
  });
  // Reusable broadcast channel (prevents memory leak from creating per-event)
  protected broadcastChannel: any = null;
  protected broadcastReady: boolean = false;

  constructor(
    tournamentId: string,
    gameServer: GameServer,
    tournamentLeaseGeneration: string | null = null,
    tournamentLeaseProofDeadlineMonotonicMs: number | null = null
  ) {
    this.tournamentId = tournamentId;
    this.gameServer = gameServer;
    this.tournamentLeaseGeneration = tournamentLeaseGeneration;
    this.tournamentLeaseProofDeadlineMonotonicMs = tournamentLeaseProofDeadlineMonotonicMs;
  }

  /** Every dealer owned by this manager carries the same tournament fence. */
  protected createManagedTableEngine(tableId: string): ServerTableEngine {
    if (this.tournamentLeaseGeneration) {
      const deadline = this.tournamentLeaseProofDeadlineMonotonicMs;
      if (deadline === null || !Number.isFinite(deadline)) {
        throw new Error(
          `Tournament ${this.tournamentId} cannot create table ${tableId} without a current lease deadline`
        );
      }
      const engine = new ServerTableEngine(tableId, {
        scope: 'tournament',
        verified: true,
        generation: this.tournamentLeaseGeneration,
        tournamentId: this.tournamentId,
        proofDeadlineMonotonicMs: deadline,
      });
      return bindTournamentDataAuthorityMethods(
        {
          tournamentId: this.tournamentId,
          leaseGeneration: this.tournamentLeaseGeneration,
        },
        engine
      );
    }
    return new ServerTableEngine(tableId, {
      scope: 'tournament',
      verified: false,
      generation: null,
      tournamentId: this.tournamentId,
      proofDeadlineMonotonicMs: null,
    });
  }

  private tournamentLeaseAuthorityIsCurrent(): boolean {
    /* A null generation exists only in isolated dependency-injected harnesses.
       GameServer production admission requires an exact protocol-2 generation. */
    if (!this.tournamentLeaseGeneration) return true;
    return (
      !this.tournamentLeaseAuthorityExpired &&
      this.tournamentLeaseProofDeadlineMonotonicMs !== null &&
      Number.isFinite(this.tournamentLeaseProofDeadlineMonotonicMs) &&
      tournamentLeaseMonotonicNow() < this.tournamentLeaseProofDeadlineMonotonicMs
    );
  }

  private clearTournamentLeaseExpiryTimer(): void {
    if (!this.tournamentLeaseExpiryTimer) return;
    clearTimeout(this.tournamentLeaseExpiryTimer);
    this.tournamentLeaseExpiryTimer = null;
  }

  private armTournamentLeaseExpiryTimer(): void {
    this.clearTournamentLeaseExpiryTimer();
    if (!this.tournamentLeaseGeneration || this.tournamentLeaseAuthorityExpired) return;
    const deadline = this.tournamentLeaseProofDeadlineMonotonicMs;
    if (deadline === null || !Number.isFinite(deadline)) {
      this.expireTournamentLeaseAuthority();
      return;
    }
    const delayMs = deadline - tournamentLeaseMonotonicNow();
    if (delayMs <= 0) {
      this.expireTournamentLeaseAuthority();
      return;
    }
    this.tournamentLeaseExpiryTimer = setTimeout(() => {
      this.tournamentLeaseExpiryTimer = null;
      /* A timer may fire slightly early. Re-read the monotonic clock instead
         of converting an early wake into a false ownership loss. */
      if (this.tournamentLeaseAuthorityIsCurrent()) {
        this.armTournamentLeaseExpiryTimer();
        return;
      }
      this.expireTournamentLeaseAuthority();
    }, Math.ceil(delayMs));
    this.tournamentLeaseExpiryTimer.unref?.();
  }

  private expireTournamentLeaseAuthority(): void {
    if (!this.tournamentLeaseGeneration || this.tournamentLeaseAuthorityExpired) return;
    this.fenceForTournamentLeaseLoss();
    reportError(
      new Error(
        `Tournament ${this.tournamentId} lease generation ${this.tournamentLeaseGeneration} expired before it was renewed`
      ),
      'Tournament.lease_proof_expired'
    );
    const teardown = this.stop();
    void teardown.catch((error) =>
      reportError(error, 'Tournament.lease_expiry_stop_failed', {
        tournamentId: this.tournamentId,
      })
    );
  }

  /**
   * Extend authority only for the same, still-live manager generation. A late
   * response cannot resurrect an expired lifecycle.
   */
  renewTournamentLeaseProof(leaseGeneration: string, proofDeadlineMonotonicMs: number): boolean {
    if (
      !this.tournamentLeaseGeneration ||
      this.tournamentLeaseGeneration.toLowerCase() !== leaseGeneration.toLowerCase() ||
      this.tournamentLeaseAuthorityExpired ||
      this.stopFenceApplied ||
      (!this.running && !this.shutdownDrainFenceApplied) ||
      !Number.isFinite(proofDeadlineMonotonicMs) ||
      tournamentLeaseMonotonicNow() >= proofDeadlineMonotonicMs
    ) {
      return false;
    }
    /* The primary and shutdown lifecycle can briefly join the same in-flight
       renewal. A late older response is still valid, but must never shorten a
       newer conservative proof already installed on this generation. */
    this.tournamentLeaseProofDeadlineMonotonicMs = Math.max(
      this.tournamentLeaseProofDeadlineMonotonicMs ?? Number.NEGATIVE_INFINITY,
      proofDeadlineMonotonicMs
    );
    const authority = {
      scope: 'tournament' as const,
      verified: true as const,
      generation: this.tournamentLeaseGeneration,
      tournamentId: this.tournamentId,
      proofDeadlineMonotonicMs: this.tournamentLeaseProofDeadlineMonotonicMs,
    };
    for (const engine of this.tableEngines.values()) {
      if (!engine.renewEngineLeaseProof(authority)) {
        this.fenceForTournamentLeaseLoss();
        return false;
      }
    }
    this.armTournamentLeaseExpiryTimer();
    return true;
  }

  /** Read-time fence used after every heartbeat, including UNKNOWN results. */
  hasCurrentTournamentLeaseAuthority(): boolean {
    if (this.tournamentLeaseAuthorityIsCurrent()) return true;
    this.expireTournamentLeaseAuthority();
    return false;
  }

  /** Invalidate all async work synchronously before physical teardown awaits. */
  fenceForTournamentLeaseLoss(): void {
    if (this.tournamentLeaseGeneration) this.tournamentLeaseAuthorityExpired = true;
    this.clearTournamentLeaseExpiryTimer();
    for (const engine of this.tableEngines.values()) {
      engine.fenceForEngineLeaseLoss('tournament_lease_lost', false);
    }
    this.applyStopFence();
  }

  protected lifecycleIsCurrent(token = this.lifecycleEpoch.current()): boolean {
    if (!this.tournamentLeaseAuthorityIsCurrent()) {
      this.expireTournamentLeaseAuthority();
      return false;
    }
    return this.running && this.lifecycleEpoch.isCurrent(token);
  }

  protected captureLifecycleToken(): TournamentLifecycleToken | null {
    if (!this.tournamentLeaseAuthorityIsCurrent()) {
      this.expireTournamentLeaseAuthority();
      return null;
    }
    return this.lifecycleEpoch.current();
  }

  protected assertLifecycleCurrent(token: TournamentLifecycleToken): void {
    if (!this.tournamentLeaseAuthorityIsCurrent()) {
      this.expireTournamentLeaseAuthority();
      throw new TournamentLifecycleAbortedError(token.generation);
    }
    this.lifecycleEpoch.assertCurrent(token);
    if (!this.running) throw new TournamentLifecycleAbortedError(token.generation);
  }

  private trackLifecycleJob<T>(operation: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation.finally(() => this.lifecycleJobs.delete(tracked));
    this.lifecycleJobs.add(tracked);
    return tracked;
  }

  /** Drain to a fixed point: a tracked callback may launch another tracked job. */
  private async drainLifecycleJobs(): Promise<void> {
    while (this.lifecycleJobs.size > 0) {
      await Promise.allSettled([...this.lifecycleJobs]);
    }
  }

  private async drainTableEngineStartJobs(): Promise<void> {
    while (this.tableEngineStartJobs.size > 0) {
      await Promise.allSettled([...this.tableEngineStartJobs]);
    }
  }

  private async drainTableEngineRunJobs(): Promise<void> {
    while (this.tableEngineRunJobs.size > 0) {
      await Promise.allSettled([...this.tableEngineRunJobs]);
    }
  }

  private async drainEliminationSchedulerJobs(): Promise<void> {
    while (this.eliminationSchedulerJobs.size > 0) {
      await Promise.allSettled([...this.eliminationSchedulerJobs]);
    }
  }

  private dispatchLifecycleCallback(
    callback: () => void | Promise<unknown>,
    errorContext: string
  ): void {
    try {
      const result = callback();
      if (result && typeof result.then === 'function') {
        void this.trackLifecycleJob(result).catch((error) => reportError(error, errorContext));
      }
    } catch (error) {
      reportError(error, errorContext);
    }
  }

  /**
   * Install one dealer without ever overwriting another manager's generation.
   * A collision is an ownership loss, not a cue to stop the incumbent: fence
   * this manager synchronously and let its shared teardown promise drain the
   * candidate and every engine it had already admitted.
   */
  protected admitManagedTableEngine(tableId: string, engine: ServerTableEngine): void {
    if (this.gameServer.registerTableEngine(tableId, engine)) return;

    const error = new Error(
      `Tournament ${this.tournamentId} cannot claim table ${tableId}: another engine generation owns it`
    );
    const teardown = this.stop();
    void teardown.catch((teardownError) =>
      reportError(teardownError, 'Tournament.table_engine_admission_cleanup_failed', { tableId })
    );
    throw error;
  }

  private tableIdForManagedEngine(engine: ServerTableEngine): string | null {
    for (const [tableId, candidate] of this.tableEngines) {
      if (candidate === engine) return tableId;
    }
    return null;
  }

  private clearManagedTableEngineRecovery(tableId: string, resetAttempts = true): void {
    const timer = this.tableEngineRecoveryTimers.get(tableId);
    if (timer) this.clearLifecycleTimeout(timer);
    this.tableEngineRecoveryTimers.delete(tableId);
    if (resetAttempts) this.tableEngineRecoveryAttempts.delete(tableId);
  }

  private clearManagedTableEngineRecoveries(): void {
    for (const timer of this.tableEngineRecoveryTimers.values()) {
      this.clearLifecycleTimeout(timer);
    }
    this.tableEngineRecoveryTimers.clear();
    this.tableEngineRecoveryAttempts.clear();
  }

  /** A replacement inherits every pause authority before it can deal. */
  private prepareManagedTableEngineForPlay(engine: ServerTableEngine): void {
    if (this.addOnBreakActive && this.addOnBreakEndsAtMs > Date.now()) {
      // The absolute hold is independent of hand-for-hand's pause flag, so a
      // barrier resume cannot deal through an overlapping add-on break.
      engine.holdDealingUntil(this.addOnBreakEndsAtMs);
    }
    if (this.onBreak) {
      engine.pauseAfterHand(TournamentManagerBase.MAX_HEALTHY_PAUSE_MS, {
        beforeNextHand: true,
      });
      return;
    }
    if (this.addOnBreakActive && this.addOnBreakOwnsPause) {
      engine.pauseAfterHand(
        Math.max(
          1_000,
          this.addOnBreakEndsAtMs - Date.now() + TournamentManagerBase.LAST_HAND_GRACE_MS
        ),
        { beforeNextHand: true }
      );
      return;
    }
    if (this.handForHandActive) engine.pauseAfterHand();
  }

  /**
   * Retain one failed causal operation, not a fleet scanner. The timer names
   * both the durable table and (when present) the exact dead generation. A
   * healthy table has no timer and a superseded generation cannot touch its
   * successor.
   */
  private scheduleManagedTableEngineRecovery(
    tableId: string,
    expected: ServerTableEngine | null,
    lifecycle: TournamentLifecycleToken,
    reason: string
  ): void {
    if (!this.lifecycleIsCurrent(lifecycle)) {
      this.clearManagedTableEngineRecovery(tableId);
      return;
    }
    if (this.tableEngineRecoveryTimers.has(tableId)) return;

    // A table whose dealer generation is being replaced is still a member of
    // the tournament.  Keep its durable id in an active hand-for-hand barrier
    // even when the dead engine has already left tableEngines.  Otherwise a
    // recovery that began just before the bubble was armed disappeared from
    // the expected roster and the remaining tables could deal an extra hand.
    if (this.handForHandActive) this.handForHandTableIds.add(tableId);

    const attempt = (this.tableEngineRecoveryAttempts.get(tableId) ?? 0) + 1;
    this.tableEngineRecoveryAttempts.set(tableId, attempt);
    const delayMs = Math.min(250 * 2 ** Math.min(attempt - 1, 6), 15_000);
    let timer!: ReturnType<typeof setTimeout>;
    timer = this.setLifecycleTimeout(async () => {
      if (this.tableEngineRecoveryTimers.get(tableId) !== timer) return;
      this.tableEngineRecoveryTimers.delete(tableId);
      if (!this.lifecycleIsCurrent(lifecycle)) {
        this.tableEngineRecoveryAttempts.delete(tableId);
        return;
      }

      try {
        if (expected) {
          if (this.tableEngines.get(tableId) !== expected) {
            this.tableEngineRecoveryAttempts.delete(tableId);
            return;
          }
          await this.recoverManagedTableEngine(
            tableId,
            expected,
            lifecycle,
            `${reason}:retry`,
            false
          );
          return;
        }

        if (this.tableEngines.has(tableId)) {
          this.tableEngineRecoveryAttempts.delete(tableId);
          return;
        }
        await this.admitMissingManagedTableEngine(tableId, lifecycle, `${reason}:retry`);
      } catch (error) {
        reportError(error, 'Tournament.table_engine_causal_retry_failed', {
          tournamentId: this.tournamentId,
          tableId,
          reason,
          attempt,
        });
        if (!this.lifecycleIsCurrent(lifecycle)) return;
        const incumbent = this.tableEngines.get(tableId);
        if (expected && incumbent !== expected) return;
        this.scheduleManagedTableEngineRecovery(tableId, incumbent ?? null, lifecycle, reason);
      }
    }, delayMs);
    this.tableEngineRecoveryTimers.set(tableId, timer);
  }

  /** Admit a table retired after a failed start, after proving it is still live. */
  private async admitMissingManagedTableEngine(
    tableId: string,
    lifecycle: TournamentLifecycleToken,
    reason: string
  ): Promise<void> {
    if (!this.lifecycleIsCurrent(lifecycle) || this.tableEngines.has(tableId)) return;

    const { data: table, error } = await supabase
      .from('tables')
      .select('id, tournament_id, status, is_deleted')
      .eq('id', tableId)
      .maybeSingle();
    this.assertLifecycleCurrent(lifecycle);
    if (error) throw new Error(`Tournament table recovery lookup failed: ${error.message}`);

    const wakeable =
      table &&
      table.tournament_id === this.tournamentId &&
      table.is_deleted !== true &&
      ['running', 'waiting', 'active'].includes(String(table.status ?? '').toLowerCase());
    if (!wakeable) {
      this.clearManagedTableEngineRecovery(tableId);
      this.retireManagedTableFromHandForHand(tableId);
      return;
    }

    const fresh = this.createManagedTableEngine(tableId);
    fresh.setHub(tableStateHub);
    this.prepareManagedTableEngineForPlay(fresh);
    this.wireEliminationWake(fresh);
    try {
      this.admitManagedTableEngine(tableId, fresh);
      this.tableEngines.set(tableId, fresh);
      this.startManagedTableEngine(fresh, 'Tournament.table_engine_readmission_failed', {
        tableId,
        reason,
      });
    } catch (admissionError) {
      await fresh.stop().catch(() => undefined);
      this.gameServer.unregisterTournamentTableEngine(tableId, fresh);
      throw admissionError;
    }
  }

  private async recoverManagedTableEngine(
    tableId: string,
    engine: ServerTableEngine,
    lifecycle: TournamentLifecycleToken,
    reason: string,
    deferReadmission: boolean
  ): Promise<void> {
    const existing = this.tableEngineRecoveries.get(engine);
    if (existing) return existing;

    const operation = this.performManagedTableEngineRecovery(
      tableId,
      engine,
      lifecycle,
      reason,
      deferReadmission
    ).catch((error) => {
      if (this.lifecycleIsCurrent(lifecycle)) {
        const incumbent = this.tableEngines.get(tableId);
        if (incumbent === engine || !incumbent) {
          this.scheduleManagedTableEngineRecovery(tableId, incumbent ?? null, lifecycle, reason);
        }
      }
      throw error;
    });
    let tracked!: Promise<void>;
    tracked = operation.finally(() => {
      if (this.tableEngineRecoveries.get(engine) === tracked) {
        this.tableEngineRecoveries.delete(engine);
      }
    });
    this.tableEngineRecoveries.set(engine, tracked);
    return tracked;
  }

  private async performManagedTableEngineRecovery(
    tableId: string,
    engine: ServerTableEngine,
    lifecycle: TournamentLifecycleToken,
    reason: string,
    deferReadmission: boolean
  ): Promise<void> {
    if (!this.lifecycleIsCurrent(lifecycle) || this.tableEngines.get(tableId) !== engine) return;

    if (deferReadmission) {
      try {
        await engine.stop();
      } catch (error) {
        // performStop releases process scheduler ownership before reporting an
        // aggregate cleanup failure. Keeping the dead object addressable would
        // turn that diagnostic into a permanent table outage.
        reportError(error, 'Tournament.table_engine_failed_start_teardown_error', {
          tableId,
          reason,
        });
      }
      if (!this.lifecycleIsCurrent(lifecycle) || this.tableEngines.get(tableId) !== engine) return;
      if (!this.gameServer.unregisterTournamentTableEngine(tableId, engine)) {
        const ownershipError = new Error(
          `Tournament ${this.tournamentId} lost table ${tableId} while retiring a failed engine start`
        );
        void this.stop().catch((error) =>
          reportError(error, 'Tournament.table_engine_ownership_loss_cleanup_failed', { tableId })
        );
        throw ownershipError;
      }
      this.tableEngines.delete(tableId);
      this.scheduleManagedTableEngineRecovery(tableId, null, lifecycle, reason);
      return;
    }

    const fresh = this.createManagedTableEngine(tableId);
    fresh.setHub(tableStateHub);
    this.prepareManagedTableEngineForPlay(fresh);
    this.wireEliminationWake(fresh);
    let replaced = false;
    try {
      replaced = await this.gameServer.replaceTableEngine(tableId, engine, fresh);
    } catch (error) {
      await fresh.stop().catch(() => undefined);
      throw error;
    }
    if (!replaced) {
      await fresh.stop().catch(() => undefined);
      if (this.lifecycleIsCurrent(lifecycle) && this.tableEngines.get(tableId) === engine) {
        const ownershipError = new Error(
          `Tournament ${this.tournamentId} lost table ${tableId} during generation replacement`
        );
        void this.stop().catch((error) =>
          reportError(error, 'Tournament.table_engine_ownership_loss_cleanup_failed', { tableId })
        );
        throw ownershipError;
      }
      return;
    }

    if (!this.lifecycleIsCurrent(lifecycle) || this.tableEngines.get(tableId) !== engine) {
      await fresh.stop().catch(() => undefined);
      this.gameServer.unregisterTournamentTableEngine(tableId, fresh);
      return;
    }
    this.tableEngines.set(tableId, fresh);
    this.startManagedTableEngine(fresh, 'Tournament.table_engine_restart_failed', {
      tableId,
      reason,
    });
  }

  /** A manager is not torn down until every table start it launched has settled. */
  protected startManagedTableEngine(
    engine: ServerTableEngine,
    errorContext: string,
    metadata?: Record<string, unknown>
  ): void {
    const lifecycle = this.lifecycleEpoch.current();
    const tableId = this.tableIdForManagedEngine(engine);
    const operation = engine.start().catch(async (error) => {
      reportError(error, errorContext, metadata);
      if (!lifecycle || !tableId || !this.lifecycleIsCurrent(lifecycle)) return;
      await this.recoverManagedTableEngine(tableId, engine, lifecycle, 'engine_start_failed', true);
    });
    let runJob!: Promise<void>;
    runJob = operation.finally(() => this.tableEngineRunJobs.delete(runJob));
    this.tableEngineRunJobs.add(runJob);
    void runJob.catch((error) =>
      reportError(error, 'Tournament.table_engine_start_recovery_failed', {
        ...metadata,
        tableId,
      })
    );

    // start() may intentionally wait for a second player for minutes. Manager
    // admission needs the earlier authoritative-ready edge: configuration and
    // the first waiting snapshot are loaded, so the table is connectable even
    // though it is not yet dealable.
    const readiness = engine.ready.then((ready) => {
      if (!ready) throw new Error(`Tournament table ${tableId ?? 'unknown'} was never ready`);
      if (tableId && this.tableEngines.get(tableId) === engine) {
        this.clearManagedTableEngineRecovery(tableId);
      }
    });
    let tableStart!: Promise<void>;
    tableStart = readiness.finally(() => this.tableEngineStartJobs.delete(tableStart));
    this.tableEngineStartJobs.add(tableStart);
    void tableStart.catch((error) =>
      reportError(error, 'Tournament.table_engine_never_ready', {
        ...metadata,
        tableId,
      })
    );
  }

  /** Bind a delayed manager mutation to the exact lifecycle that scheduled it. */
  protected setLifecycleTimeout(
    callback: () => void | Promise<unknown>,
    delayMs: number
  ): ReturnType<typeof setTimeout> {
    const token = this.lifecycleEpoch.current();
    const timer = setTimeout(() => {
      this.lifecycleTimeouts.delete(timer);
      if (!this.lifecycleIsCurrent(token)) return;
      this.dispatchLifecycleCallback(callback, 'TournamentManagerBase.lifecycle_timeout_failed');
    }, delayMs);
    this.lifecycleTimeouts.add(timer);
    timer.unref?.();
    return timer;
  }

  /** Bind repeated manager work to the exact lifecycle that armed it. */
  protected setLifecycleInterval(
    callback: () => void | Promise<unknown>,
    delayMs: number
  ): ReturnType<typeof setInterval> {
    const token = this.lifecycleEpoch.current();
    const timer = setInterval(() => {
      if (!this.lifecycleIsCurrent(token)) {
        clearInterval(timer);
        this.lifecycleIntervals.delete(timer);
        return;
      }
      this.dispatchLifecycleCallback(callback, 'TournamentManagerBase.lifecycle_interval_failed');
    }, delayMs);
    this.lifecycleIntervals.add(timer);
    timer.unref?.();
    return timer;
  }

  protected clearLifecycleTimeout(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.lifecycleTimeouts.delete(timer);
  }

  protected clearLifecycleInterval(timer: ReturnType<typeof setInterval>): void {
    clearInterval(timer);
    this.lifecycleIntervals.delete(timer);
  }

  private clearLifecycleTimers(): void {
    for (const timer of this.lifecycleTimeouts) clearTimeout(timer);
    for (const timer of this.lifecycleIntervals) clearInterval(timer);
    this.lifecycleTimeouts.clear();
    this.lifecycleIntervals.clear();
  }

  /** Install the process-wide sweep runner once for this manager. */
  protected registerEliminationScheduler(run: (signal: AbortSignal) => Promise<void>): void {
    if (this.eliminationSchedulerUnregister) return;
    const lifecycle = this.lifecycleEpoch.current();
    if (!this.lifecycleIsCurrent(lifecycle)) return;
    this.eliminationSchedulerUnregister = tournamentEliminationScheduler.register({
      tournamentId: this.tournamentId,
      run: (signal) => {
        // Defer entry by one microtask so the promise is registered as active
        // before user code can reach its first await (or initiate stop).
        const operation = Promise.resolve().then(async () => {
          if (!this.lifecycleIsCurrent(lifecycle)) return;
          await run(signal);
        });
        let tracked!: Promise<void>;
        tracked = operation.finally(() => this.eliminationSchedulerJobs.delete(tracked));
        this.eliminationSchedulerJobs.add(tracked);
        return tracked;
      },
      isActive: () => this.lifecycleIsCurrent(lifecycle),
    });
  }

  /** Remove only this manager's scheduler entry; safe from lifecycle catches. */
  protected unregisterEliminationScheduler(): void {
    if (!this.eliminationSchedulerUnregister) return;
    this.eliminationSchedulerUnregister();
    this.eliminationSchedulerUnregister = null;
  }

  /**
   * Cooperative lifecycle fence for helpers entered by the shared scheduler.
   * A helper may also run during initial setup, when no sweep signal exists;
   * in both cases manager stop is authoritative.
   */
  protected eliminationMutationAllowed(): boolean {
    return (
      this.running &&
      !this.eliminationSweepSignal?.aborted &&
      (this.eliminationSweepDeadlineAt === 0 || Date.now() < this.eliminationSweepDeadlineAt)
    );
  }

  protected eliminationWorkBudgetExpired(): boolean {
    return this.eliminationSweepDeadlineAt > 0 && Date.now() >= this.eliminationSweepDeadlineAt;
  }

  /** Wake this manager without exposing the process scheduler to GameServer. */
  requestEliminationSweep(reason?: string, durableWakeId?: number): boolean {
    if (reason === 'deal_vote') this.forceFinalTableDealCheck = true;
    const accepted = tournamentEliminationScheduler.wake(this.tournamentId);
    if (accepted && Number.isSafeInteger(durableWakeId) && Number(durableWakeId) > 0) {
      this.pendingManagerWakes.set(Number(durableWakeId), String(reason ?? ''));
    }
    return accepted;
  }

  /**
   * Re-drive one manager through the scheduler's shared timer. This preserves
   * narrow feature cadences without recreating one timer per tournament.
   */
  requestEliminationSweepAfter(delayMs: number): void {
    tournamentEliminationScheduler.wakeAfter(this.tournamentId, delayMs);
  }

  /** A delayed correctness retry that outranks the routine safety backlog. */
  protected requestUrgentEliminationSweepAfter(delayMs: number): void {
    tournamentEliminationScheduler.wakeUrgentAfter(this.tournamentId, delayMs);
  }

  /** Keep one add-on retry due while its persisted offer window is open. */
  protected scheduleAddOnRetry(): void {
    if (!this.running || !this.addOnPeriodTriggered || this.prizePoolFinalized) return;
    const dueIn = Math.max(
      0,
      this.lastAddOnOfferAt + TournamentManagerBase.ADD_ON_RETRY_MS - Date.now()
    );
    this.requestUrgentEliminationSweepAfter(dueIn);
  }

  /** Re-drive one failed close through the shared scheduler, never a manager-local poll. */
  private requestAddOnDeadlineRetry(delayMs: number): void {
    if (!this.running || !this.addOnPeriodTriggered || this.prizePoolFinalized) return;
    const delay = Math.max(0, delayMs);
    // The elimination stage admits add-on work on this cadence. Preserve the
    // requested delay without letting its ordinary retry overwrite it.
    this.lastAddOnOfferAt = Date.now() - TournamentManagerBase.ADD_ON_RETRY_MS + delay;
    this.requestUrgentEliminationSweepAfter(delay);
  }

  /**
   * A zero final stack is the event that can create an elimination. The engine
   * invokes this callback as a scheduling hint after its persistence attempts.
   * A failed mirror/history write must still wake because Dealing can durably
   * vacate the zero later and that player will not appear in another hand. The
   * sweep is the authority and fails closed until exact evidence is visible.
   * Wake only for the zero shape; waking on every ordinary hand would rebuild
   * the fan-out this scheduler removes. Registration, rebuy, add-on, bounty,
   * deal-vote and window transitions each carry their own durable wake or
   * exact deadline.
   */
  protected wireEliminationWake(engine: ServerTableEngine): void {
    engine.onHandComplete((_tableId, finalStacks) => {
      if (finalStacks.some((player) => Number(player.stack) <= 0)) {
        this.requestEliminationSweep();
      }
    });
    engine.onPauseReady(() => this.advanceHandForHandBarrier());
    engine.onRestartRequired((reason) => {
      const lifecycle = this.captureLifecycleToken();
      const tableId = this.tableIdForManagedEngine(engine);
      if (!lifecycle || !tableId || !this.lifecycleIsCurrent(lifecycle)) return;
      const recovery = this.recoverManagedTableEngine(tableId, engine, lifecycle, reason, false);
      void this.trackLifecycleJob(recovery).catch((error) =>
        reportError(error, 'Tournament.table_engine_runtime_recovery_failed', {
          tournamentId: this.tournamentId,
          tableId,
          reason,
        })
      );
    });
  }

  isRunning(): boolean {
    if (!this.tournamentLeaseAuthorityIsCurrent()) {
      this.expireTournamentLeaseAuthority();
      return false;
    }
    return this.running;
  }

  /** Generation GameServer must prove on every ownership heartbeat. */
  getTournamentLeaseGeneration(): string | null {
    return this.tournamentLeaseGeneration;
  }

  /**
   * Safe category for public table-liveness certification.
   *
   * Only the product lane leaves this manager. The tournament row, ownership
   * generation, players, money and cards remain private. A manager cannot own
   * table engines before start() has loaded tournamentCache, so null describes
   * an incomplete admission rather than guessing a format.
   */
  getPublicLiveTableFormat(): Exclude<PublicLiveTableFormat, 'cash'> | null {
    return this.tournamentCache ? publicTournamentTableFormat(this.tournamentCache) : null;
  }

  /** Public club scope paired with the format label; never an ownership id. */
  getPublicLiveTableClubId(): string | null {
    const clubId = this.tournamentCache?.club_id;
    return typeof clubId === 'string' && clubId.trim() ? clubId : null;
  }

  /**
   * The tables this manager currently owns an engine for.
   *
   * Added 2026-09-01 so GameServer can bound `tournamentOwnedTables`, which
   * had only ever been added to. Pruning that set against GameServer's own
   * `tableEngines` alone would drop the hub room of a tournament table during
   * the window where its manager is rebuilding the engine, which is precisely
   * the case the set was created to protect.
   */
  getTableIds(): string[] {
    return [...this.tableEngines.keys()];
  }

  /**
   * Is this tournament on a break of its own right now?
   *
   * Added 2026-09-01 for the maintenance break, which resumes EVERY table on
   * the platform when it ends. Without this it would also resume a tournament
   * that is still on a break of a different length - an add-on break runs up
   * to ten minutes (`addon_break_minutes`), so one starting near :55 outlives
   * the five-minute maintenance break and its tables would be dealt back into
   * play while the tournament clock still says they are away.
   *
   * Read-only, and deliberately the ONLY thing exposed: whoever paused a table
   * is responsible for resuming it, and this lets a second pause authority ask
   * "is somebody else still holding this" without being able to answer for
   * them.
   */
  isOnBreak(): boolean {
    return this.onBreak || this.addOnBreakActive;
  }

  /**
   * Broadcast a tournament event to the `t-break-<id>` topic the clients watch.
   *
   * ═══ THE ENGINE STOPPED JOINING 425 CHANNELS TO SPEAK ON THEM (2026-09-06) ══
   *
   * This used to `subscribe()` a channel per tournament and keep it for the
   * tournament's lifetime. One engine process holds ONE Realtime socket, and a
   * socket has a hard cap of 100 channels: with 425 live tournaments plus a
   * channel per bomb-pot table, the engine sat permanently over the cap and
   * Realtime refused the surplus joins — 123,219 `ChannelRateLimitReached:
   * Too many channels` in 24 hours, about 1.4 every second, for ever, because
   * each refusal was retried.
   *
   * That mattered beyond the noise. Supabase Realtime runs the channel layer
   * and the WAL replication poller in the SAME Elixir node, so a rejected-join
   * loop at 1.4/s is CPU taken from the poller that was already behind.
   *
   * THE ENGINE ONLY EVER SPEAKS HERE; it never listens. So it does not need a
   * channel at all. `httpSend` posts the broadcast to Realtime's REST endpoint
   * and reaches every subscribed client identically — this is the same
   * transport `send()` was silently falling back to (the "Sent 202" lines in
   * the Realtime log), now asked for explicitly rather than through a path the
   * library warns is deprecated.
   *
   * The client contract is UNCHANGED: clients still subscribe to
   * `t-break-<tournamentId>` and still receive `tournament_event`.
   */
  protected async broadcast(eventType: string, payload: any): Promise<boolean> {
    try {
      if (!this.broadcastChannel) {
        this.broadcastChannel = supabase.channel(`t-break-${this.tournamentId}`);
        this.broadcastReady = true;
      }
      const receipt = await this.broadcastChannel.httpSend('tournament_event', {
        type: eventType,
        payload,
      });
      if (receipt?.success !== true) {
        throw new Error(`Realtime REST broadcast returned no success receipt for ${eventType}`);
      }
      return true;
    } catch (e) {
      reportError(e, 'TournamentManager.broadcast_failed');
      // Drop the channel object so the next call rebuilds it. Nothing is
      // joined, so this costs one allocation rather than a re-join.
      //
      // It goes through removeChannel and not a bare `= null`, corrected
      // 2026-09-06. `supabase.channel(topic)` APPENDS to the client's channel
      // registry and does not de-duplicate by topic, so nulling the reference
      // leaves the object there and the next call adds a second entry under
      // `t-break-<id>`. A tournament whose broadcasts keep failing - the case
      // this branch exists for - would grow that registry once per event for
      // the life of the process, which is the accumulation this whole change
      // set removed from the JOIN path, reappearing on the error path.
      const stale = this.broadcastChannel;
      this.broadcastChannel = null;
      this.broadcastReady = false;
      if (stale) {
        try {
          await supabase.removeChannel(stale);
        } catch {
          /* a channel that will not release cannot fail a broadcast twice */
        }
      }
      return false;
    }
  }

  /**
   * Release the broadcast channel when the tournament ends.
   *
   * Nothing is joined any more (see broadcast above), so there is no
   * `unsubscribe()` to await. `removeChannel` drops the object from the
   * client's channel registry, which is what stops a finished tournament from
   * accumulating there for the life of the process.
   */
  protected async cleanupBroadcastChannel(): Promise<void> {
    if (this.broadcastChannel) {
      try {
        await supabase.removeChannel(this.broadcastChannel);
      } catch {
        /* a channel that will not release cannot hold up a tournament ending */
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
      this.clearLifecycleTimeout(this.blindTimer);
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
    const lifecycle = this.captureLifecycleToken();
    if (!lifecycle || !this.lifecycleIsCurrent(lifecycle) || this.onBreak) return;
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
    const applies = await this.breakApplies();
    // breakApplies may be waiting on the tournament row while shutdown fences
    // this manager. Never let that retired continuation begin a new break.
    if (!this.lifecycleIsCurrent(lifecycle)) return;
    if (!applies) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Break refused - this format does not take the :55 break`
      );
      return;
    }
    // A synchronized break is allowed to overlap the durable add-on break.
    // If the add-on already suspended the level clock, preserve that exact
    // remaining time instead of measuring a null timer as a fresh full level;
    // the synchronized break becomes the pause owner until one of them ends.
    const addOnBreakAlreadyOwnsLevelClock = this.addOnBreakActive && this.addOnBreakOwnsLevelClock;
    this.onBreak = true;
    if (this.addOnBreakActive) this.addOnBreakOwnsPause = false;
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
    if (!addOnBreakAlreadyOwnsLevelClock) this.suspendLevelClock();

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] SYNCHRONIZED BREAK - ${Math.round(breakDurationMs / 60000)} minutes`
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
    // Persistence was admitted by this generation, but its response may return
    // after the generation was fenced. The retired manager must not publish or
    // pause table engines behind shutdown's final ownership snapshot.
    if (!this.lifecycleIsCurrent(lifecycle)) return;

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
    if (!this.lifecycleIsCurrent(lifecycle)) return;

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
    const lifecycle = this.captureLifecycleToken();
    if (!lifecycle || !this.lifecycleIsCurrent(lifecycle) || !this.onBreak) return;
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
    // The database write began while this manager owned the generation. If its
    // response crosses the stop fence, do not announce a countdown from a
    // manager that no longer owns the tournament.
    if (!this.lifecycleIsCurrent(lifecycle)) return;
    await this.broadcast('tournament_break_started', {
      level: this.currentLevel,
      phase: 'counting_down',
      // The countdown seed every client needs. Without breakDurationMinutes
      // here, TournamentClock fell back to a hardcoded 300 seconds.
      breakDurationMinutes: Math.round(breakDurationMs / 60000),
      breakEndsAt: endsAt,
      synchronized: true,
    });
    if (!this.lifecycleIsCurrent(lifecycle)) return;
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

    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] BREAK ENDED - resuming play`);

    await this.broadcast('break_ended', { level: this.currentLevel });

    /* Undo the pause taken in pauseForBreak only when no durable add-on break
       is still holding it. This is the exact Free Buy boundary: the :55
       synchronized break commonly overlaps the add-on break at start + 60m.
       Hand pause ownership to that break rather than dealing for the seconds
       between the two deadlines. Hand-for-hand independently owns its pause
       when active. */
    const addOnBreakStillActive = this.addOnBreakActive;
    if (addOnBreakStillActive) {
      this.addOnBreakOwnsPause = true;
      this.addOnBreakOwnsLevelClock = true;
    }
    if (!this.handForHandActive && !addOnBreakStillActive) {
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
    if (!addOnBreakStillActive) {
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
   * field are at other tables, and `fn_settle_final_table_deal_atomic` will chop the pool
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

  /** Late registration state is owned by fn_close_tournament_entry_window. */
  protected isLateRegClosed(): boolean {
    return this.prizePoolFinalized || this.tournamentEntryWindowClosed;
  }

  private clearTournamentEntryCloseTimer(): void {
    if (!this.tournamentEntryCloseTimer) return;
    this.clearLifecycleTimeout(this.tournamentEntryCloseTimer);
    this.tournamentEntryCloseTimer = null;
  }

  /**
   * Arm exactly one lifecycle-owned check from a DATABASE-RELATIVE delay.
   * No database timestamp is compared with Date.now(): clocks on different
   * hosts never decide whether a paid entry is still legal.
   */
  private armTournamentEntryCloseTimer(retryAfterMs: number): void {
    this.clearTournamentEntryCloseTimer();
    const delayMs = Math.min(Math.max(0, Math.ceil(retryAfterMs)), 2_147_483_647);
    this.tournamentEntryCloseTimer = this.setLifecycleTimeout(() => {
      this.tournamentEntryCloseTimer = null;
      return this.reconcileTournamentEntryWindow('engine.entry_window_deadline');
    }, delayMs);
  }

  /**
   * Start, resume, blind transitions, the exact minutes timer and the durable
   * manager wake all enter this one serialized operation. A committed close
   * leaves a database receipt plus wake; that wake cannot be acknowledged by
   * the elimination loop until this method proves the reprice complete.
   */
  protected async reconcileTournamentEntryWindow(source: string): Promise<boolean> {
    if (this.tournamentEntryCloseOperation) return this.tournamentEntryCloseOperation;
    let operation!: Promise<boolean>;
    operation = this.reconcileTournamentEntryWindowOnce(source).finally(() => {
      if (this.tournamentEntryCloseOperation === operation) {
        this.tournamentEntryCloseOperation = null;
      }
    });
    this.tournamentEntryCloseOperation = operation;
    return operation;
  }

  private async reconcileTournamentEntryWindowOnce(source: string): Promise<boolean> {
    const lifecycle = this.captureLifecycleToken();
    if (!lifecycle || !this.lifecycleIsCurrent(lifecycle)) return false;

    let data: unknown;
    let error: { message?: string } | null = null;
    try {
      const response = await supabase.rpc('fn_close_tournament_entry_window', {
        p_tournament_id: this.tournamentId,
        p_source: source,
      });
      data = response.data;
      error = response.error;
    } catch (err) {
      error = { message: err instanceof Error ? err.message : String(err) };
    }
    if (!this.lifecycleIsCurrent(lifecycle)) return false;

    const result = (data ?? {}) as TournamentEntryWindowResult;
    if (error || result.ok !== true || typeof result.entry_closed !== 'boolean') {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] entry-window authority refused ${source}: ${error?.message ?? result.reason ?? 'invalid contract'}`
        ),
        'Tournament.entry_window_close_refused'
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return false;
    }

    if (!result.entry_closed) {
      this.tournamentEntryWindowClosed = false;
      this.tournamentEntryRepricePending = false;
      const retryAfterMs = Number(result.retry_after_ms);
      if (result.window_mode === 'minutes' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
        this.armTournamentEntryCloseTimer(retryAfterMs);
      } else {
        this.clearTournamentEntryCloseTimer();
      }
      return true;
    }

    this.clearTournamentEntryCloseTimer();
    this.tournamentEntryWindowClosed = true;

    if (!this.tournamentEntryCloseAnnounced) {
      this.tournamentEntryCloseAnnounced = true;
      try {
        await this.broadcast('late_reg_closed', {
          prizePool: Number(result.prize_pool ?? this.tournamentCache?.prize_pool) || 0,
        });
      } catch (err) {
        reportError(err, 'Tournament.entry_window_close_broadcast_failed');
      }
      if (!this.lifecycleIsCurrent(lifecycle)) return false;
    }

    // The entry boundary and add-on boundary are distinct. Entry closes now;
    // add-on chips keep the pool mutable until the persisted add-on deadline.
    if (result.finalization_deferred === true && result.reason === 'addon_required') {
      this.tournamentEntryRepricePending = false;
      if (this.tournamentCache?.add_on_available && !this.addOnPeriodTriggered) {
        if (this.onBreak) {
          this.pendingAddOnPeriod = true;
        } else {
          await this.triggerAddOnPeriod();
          if (!this.lifecycleIsCurrent(lifecycle)) return false;
        }
      }
      return true;
    }

    if (result.finalized !== true) {
      reportError(
        new Error('entry-window authority closed entry without finalizing or deferring the pool'),
        'Tournament.entry_window_close_contract_invalid'
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return false;
    }

    const finalPool = Number(result.prize_pool);
    if (!Number.isFinite(finalPool) || !Array.isArray(result.payout_structure)) {
      reportError(
        new Error('entry-window authority returned an unreadable final pool or payout structure'),
        'Tournament.entry_window_close_result_unreadable'
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return false;
    }
    this.prizePoolFinalized = true;
    if (this.tournamentCache) {
      this.tournamentCache.prize_pool = finalPool;
      this.tournamentCache.prize_pool_finalized = true;
      this.tournamentCache.payout_structure = result.payout_structure;
    }

    this.tournamentEntryRepricePending = result.reprice_pending === true;
    if (!this.tournamentEntryRepricePending) return true;

    const repriced = await this.recalculateEliminatedPrizes(finalPool);
    if (!this.lifecycleIsCurrent(lifecycle)) return false;
    if (!repriced) {
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return false;
    }

    const { data: completeData, error: completeError } = await supabase.rpc(
      'fn_complete_tournament_entry_reprice',
      { p_tournament_id: this.tournamentId }
    );
    if (!this.lifecycleIsCurrent(lifecycle)) return false;
    const completion = (completeData ?? {}) as {
      ok?: boolean;
      reason?: string;
      mismatches?: number;
    };
    if (completeError || completion.ok !== true) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] final-field reprice proof refused: ${completeError?.message ?? completion.reason ?? 'invalid contract'} (${Number(completion.mismatches) || 0} mismatches)`
        ),
        'Tournament.entry_window_reprice_unproven'
      );
      this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
      return false;
    }
    this.tournamentEntryRepricePending = false;
    return true;
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
        // mystery_bounty_top_percent 2026-08-29: it was READ fourteen lines
        // below and never selected, so `fresh.mystery_bounty_top_percent` was
        // always undefined, `undefined == null` is true, and EVERY event built
        // its chest at the 20% default. That is the exact defect
        // mysteryBountySpec.ts says it fixed -- "an event configured at 25%
        // would advertise 25% and pay 20%" -- fixed in the spec and never
        // wired to the query. On a 25,000 mystery pool configured at 30% the
        // lobby advertises 7,500 and the chest holds 5,000.
        'bounty_pool, bounty_pool_paid, prize_pool_finalized, mystery_bounty_stage, mystery_bounty_pool_percent, ' +
          'mystery_bounty_regular_pool_percent, mystery_bounty_profile, mystery_bounty_activation, ' +
          'mystery_bounty_activation_value, mystery_bounty_top_percent, payout_structure, current_players'
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
            `[Tournament:${this.tournamentId.slice(0, 8)}] CRITICAL: mystery bounty seed FAILED (${seedErr.message}) - chests never opened, knockouts keep paying the flat bounty`
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
        `[Tournament:${this.tournamentId.slice(0, 8)}] MYSTERY BOUNTY OPEN - ${decision.drawCount} chests, ${poolCents}c, profile ${profile}`
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

  /**
   * Advance hand-for-hand from the final table's actual between-hands edge.
   * Every engine publishes that edge only after its wait resolver and escape
   * deadline exist, so the synchronous resume below cannot be lost.
   */
  private advanceHandForHandBarrier(): void {
    if (!this.handForHandActive || !this.running) return;
    const expectedIds = [...this.handForHandTableIds];
    if (expectedIds.length === 0) return;
    const engines = expectedIds.map((tableId) => this.tableEngines.get(tableId));
    if (
      engines.some((engine) => !engine) ||
      !engines.every((engine) => engine!.isWaitingForHandForHand())
    ) {
      return;
    }

    console.log(
      `[Tournament:${this.tournamentId.slice(0, 8)}] Hand-for-hand: all ${engines.length} tables done - resuming for next hand`
    );
    for (const engine of engines) engine!.resumeDealing();

    if (this.handForHandRePauseTimer) {
      this.clearLifecycleTimeout(this.handForHandRePauseTimer);
    }
    this.handForHandRePauseTimer = this.setLifecycleTimeout(() => {
      this.handForHandRePauseTimer = null;
      // Bubble burst and manager stop are terminal for this exact re-pause.
      if (!this.running || !this.handForHandActive) return;
      for (const engine of this.tableEngines.values()) engine.pauseAfterHand();
    }, 500);
  }

  /**
   * Retire only a table whose durable closure has been confirmed.  A missing
   * or temporarily failed dealer remains in the barrier through recovery; a
   * successfully broken/closed table must not hold every survivor forever.
   */
  protected retireManagedTableFromHandForHand(tableId: string): void {
    if (!this.handForHandTableIds.delete(tableId)) return;
    this.advanceHandForHandBarrier();
  }

  /** Arm the edge-driven barrier and cover an engine already parked. */
  protected startHandForHandSync(): void {
    if (this.handForHandTableIds.size === 0) {
      for (const tableId of this.tableEngines.keys()) this.handForHandTableIds.add(tableId);
      // Recovery attempts outlive their timer while the replacement lookup or
      // start is in flight.  Their keys therefore form the stable roster for
      // tables retired before hand-for-hand activation.
      for (const tableId of this.tableEngineRecoveryAttempts.keys()) {
        this.handForHandTableIds.add(tableId);
      }
    }
    this.advanceHandForHandBarrier();
  }

  /** Stop hand-for-hand and cancel the one causal next-hand re-pause. */
  protected stopHandForHandSync(): void {
    this.handForHandTableIds.clear();
    // Bubble burst calls this and then resumes
    // engines permanently; a surviving re-pause timer would immediately freeze
    // them again for a hand-for-hand cycle that is over.
    if (this.handForHandRePauseTimer) {
      this.clearLifecycleTimeout(this.handForHandRePauseTimer);
      this.handForHandRePauseTimer = null;
    }
  }

  private launchTimestampMatches(actual: unknown, expected: string): boolean {
    const actualMs = Date.parse(String(actual ?? ''));
    const expectedMs = Date.parse(expected);
    return Number.isFinite(actualMs) && actualMs === expectedMs;
  }

  private launchRowMatchesPatch(
    row: Record<string, unknown> | null | undefined,
    patch: Record<string, unknown>
  ): boolean {
    if (!row) return false;
    return Object.entries(patch).every(([key, expected]) => {
      if (!Object.prototype.hasOwnProperty.call(row, key)) return false;
      const actual = row[key];
      if (expected === null) return actual === null;
      if (typeof expected === 'number') {
        if (typeof actual !== 'number' && (typeof actual !== 'string' || actual.trim() === ''))
          return false;
        return Number.isFinite(Number(actual)) && Number(actual) === expected;
      }
      if (key.endsWith('_at') && typeof expected === 'string') {
        return this.launchTimestampMatches(actual, expected);
      }
      if (typeof expected === 'object') {
        // The live blind/payout columns are TEXT; locked tiers are JSONB.
        // Compare their values after decoding, preserving array order and
        // every nested key. Storage encoding or JSONB key order is not a
        // different draw, but malformed or different content still refuses it.
        let decoded = actual;
        if (typeof decoded === 'string') {
          try {
            decoded = JSON.parse(decoded);
          } catch {
            return false;
          }
        }
        return isDeepStrictEqual(decoded, expected);
      }
      return actual === expected;
    });
  }

  /**
   * Claim the one durable launch receipt before the first launch mutation.
   *
   * The request id is minted once by startLifecycle and reused for every
   * ambiguous transport retry. The database may return a different launch id
   * only when it is adopting an incomplete receipt left by a crashed process;
   * that returned id becomes the owner for the rest of this invocation.
   */
  private async beginTournamentLaunch(
    lifecycle: TournamentLifecycleToken,
    requestedLaunchId: string,
    requestedStartedAtIso: string | null
  ): Promise<TournamentLaunchClaim | null> {
    if (!this.tournamentLeaseGeneration) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Launch has no verified lease generation`
        ),
        'Tournament.launch_lease_generation_missing'
      );
      return null;
    }
    let lastFailure = 'the launch claim did not return a response';

    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, error } = await supabase.rpc('fn_begin_tournament_launch_atomic', {
        p_tournament_id: this.tournamentId,
        p_launch_id: requestedLaunchId,
        p_started_at: requestedStartedAtIso,
        p_lease_generation: this.tournamentLeaseGeneration,
      });
      this.assertLifecycleCurrent(lifecycle);

      if (error) {
        lastFailure = error.message || 'launch claim RPC failed';
        if (/platform[_ ]frozen/i.test(lastFailure)) {
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Launch refused while the platform is frozen`
          );
          return null;
        }
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          this.assertLifecycleCurrent(lifecycle);
          continue;
        }
        break;
      }

      const result = (data ?? {}) as TournamentLaunchBeginResult;
      if (result.reason === 'platform_frozen') {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Launch refused while the platform is frozen`
        );
        return null;
      }

      const returnedLaunchId = String(result.launch_id ?? '');
      const returnedStartedAtIso = String(result.started_at ?? '');
      const returnedStartedAtMs = Date.parse(returnedStartedAtIso);
      const adoptsExistingReceipt =
        result.replay === true &&
        returnedLaunchId.toLowerCase() !== requestedLaunchId.toLowerCase();
      const exactReceipt =
        result.ok === true &&
        result.claimed === true &&
        typeof result.lease_generation === 'string' &&
        result.lease_generation.toLowerCase() === this.tournamentLeaseGeneration.toLowerCase() &&
        typeof result.replay === 'boolean' &&
        typeof result.completed === 'boolean' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          returnedLaunchId
        ) &&
        Number.isFinite(returnedStartedAtMs) &&
        (requestedStartedAtIso === null ||
          this.launchTimestampMatches(result.started_at, requestedStartedAtIso) ||
          adoptsExistingReceipt);
      if (exactReceipt && result.completed === false) {
        return {
          launchId: returnedLaunchId,
          startedAtIso: new Date(returnedStartedAtMs).toISOString(),
          completed: false,
        };
      }
      if (exactReceipt && result.completed === true && result.status === 'RUNNING') {
        return {
          launchId: returnedLaunchId,
          startedAtIso: new Date(returnedStartedAtMs).toISOString(),
          completed: true,
        };
      }

      lastFailure = result.reason || 'launch claim response did not prove an exact receipt state';
      break;
    }

    reportError(
      new Error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Launch receipt was not proven - standing down before launch mutations (${lastFailure})`
      ),
      'Tournament.launch_claim_unproven'
    );
    return null;
  }

  /**
   * Commit RUNNING only after every durable launch step and before any local
   * dealer is admitted. A lost response is safe to retry because completion is
   * an exact replay against the launch receipt.
   */
  private async completeTournamentLaunch(
    lifecycle: TournamentLifecycleToken,
    launchId: string,
    startedAtIso: string
  ): Promise<boolean> {
    if (!this.tournamentLeaseGeneration) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Launch completion has no verified lease generation`
        ),
        'Tournament.launch_lease_generation_missing'
      );
      return false;
    }
    let lastFailure = 'the launch completion did not return a response';

    for (let attempt = 1; attempt <= 3; attempt++) {
      const { data, error } = await supabase.rpc('fn_complete_tournament_launch_atomic', {
        p_tournament_id: this.tournamentId,
        p_launch_id: launchId,
        p_lease_generation: this.tournamentLeaseGeneration,
      });
      this.assertLifecycleCurrent(lifecycle);

      if (error) {
        lastFailure = error.message || 'launch completion RPC failed';
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          this.assertLifecycleCurrent(lifecycle);
          continue;
        }
        break;
      }

      const result = (data ?? {}) as TournamentLaunchCompleteResult;
      const exactCompletion =
        result.ok === true &&
        result.completed === true &&
        result.status === 'RUNNING' &&
        typeof result.lease_generation === 'string' &&
        result.lease_generation.toLowerCase() === this.tournamentLeaseGeneration.toLowerCase() &&
        this.launchTimestampMatches(result.started_at, startedAtIso) &&
        Number.isFinite(Date.parse(String(result.completed_at ?? '')));
      if (exactCompletion) return true;

      lastFailure = result.reason || 'launch completion response did not prove RUNNING';
      break;
    }

    reportError(
      new Error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Launch completion was not proven - no dealer will be admitted (${lastFailure})`
      ),
      'Tournament.launch_completion_unproven'
    );
    return false;
  }

  /**
   * Read the launch back as one coherent, dealable field. Individual write
   * calls are intentionally idempotent, so a failed proof leaves the receipt
   * incomplete and the next start invocation repairs only what is missing.
   */
  private async proveTournamentLaunchSetup(
    lifecycle: TournamentLifecycleToken,
    tournament: any,
    requiredField: number,
    expectedPlayerIds: string[],
    startedAtIso: string,
    stacksMayBeDeferred: boolean
  ): Promise<boolean> {
    const refuse = (detail: string): false => {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Launch setup was not durably proven - standing down before RUNNING (${detail})`
        ),
        'Tournament.launch_setup_unproven'
      );
      return false;
    };

    const { data: tournamentProof, error: tournamentProofErr } = await supabase
      .from('tournaments')
      .select('status, started_at, spin_multiplier, prize_pool')
      .eq('id', this.tournamentId)
      .maybeSingle();
    this.assertLifecycleCurrent(lifecycle);
    if (tournamentProofErr || !tournamentProof) {
      return refuse(tournamentProofErr?.message || 'the tournament row could not be read');
    }
    if (tournamentProof.status !== 'REGISTERING') {
      return refuse(`the tournament status is ${String(tournamentProof.status ?? 'missing')}`);
    }
    if (
      tournamentProof.started_at != null &&
      !this.launchTimestampMatches(tournamentProof.started_at, startedAtIso)
    ) {
      return refuse('the tournament start timestamp disagrees with the launch receipt');
    }

    const { data: rosterRows, error: rosterErr } = await supabase
      .from('tournament_players')
      .select('user_id, status, table_id, seat_number, chips')
      .eq('tournament_id', this.tournamentId)
      .in('status', ['registered', 'playing']);
    this.assertLifecycleCurrent(lifecycle);
    if (rosterErr) return refuse(`the active roster could not be read: ${rosterErr.message}`);

    const roster = (rosterRows ?? []) as Array<{
      user_id?: string | null;
      status?: string | null;
      table_id?: string | null;
      seat_number?: number | null;
      chips?: number | null;
    }>;
    if (roster.length < requiredField) {
      return refuse(`only ${roster.length} of ${requiredField} required players remain active`);
    }
    if (roster.some((row) => row.status !== 'playing')) {
      return refuse('at least one registration was not migrated to playing');
    }
    if (
      roster.some(
        (row) =>
          !row.user_id ||
          !row.table_id ||
          !Number.isInteger(Number(row.seat_number)) ||
          Number(row.seat_number) <= 0 ||
          !Number.isFinite(Number(row.chips)) ||
          Number(row.chips) < 0
      )
    ) {
      return refuse('the playing roster does not have a finite stack and an exact table seat');
    }
    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A BUST IS NOT AN UNCREDITED STACK (2026-09-09)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This used to demand `chips > 0` from EVERY roster row, and that cannot
     * tell the hazard it was written for - "the stacks were never credited, do
     * not launch a field with no money on it" - from its exact opposite: the
     * stacks WERE credited and then somebody lost them at the table.
     *
     * The second case is real and it wedged events permanently. Measured on
     * production 2026-09-09: eight Spins stuck in REGISTERING, one of them for
     * ten hours, each retrying the launch every thirty seconds - 478 refusals
     * in half an hour, all this one message. Every one was a 3-max Spin whose
     * roster summed to EXACTLY 3 x starting_chips with one seat holding zero,
     * because the table had already dealt (one of them 73 hands) before the
     * launch was proven. Sum right, distribution uneven: chips were credited
     * and then played for. There is no state that function can reach on its
     * own, so the retry could never converge.
     *
     * CONSERVATION IS THE TEST THAT ACTUALLY SEPARATES THEM. An uncredited
     * field is short of `roster x starting_chips`; a field that has been played
     * still adds up to it. Early-bird bonuses and rebuys only ever ADD, so the
     * expected total is a floor, not an equality. A field where nothing was
     * credited sums to zero and is still refused, which is the whole point of
     * the original check.
     *
     * `stacksMayBeDeferred` still means the credit legitimately has not
     * happened yet (the Spin reveal hold credits after this); the later
     * durable-stack check below owns that case, so conservation is only
     * asserted once the credit is claimed to be done.
     */
    if (!stacksMayBeDeferred) {
      const startingChips = Math.max(0, Math.floor(Number(tournament?.starting_chips) || 0));
      const rosterChips = roster.reduce((sum, row) => sum + Number(row.chips), 0);
      const expectedFloor = roster.length * startingChips;
      if (startingChips > 0 && rosterChips < expectedFloor) {
        return refuse(
          `the playing roster holds ${rosterChips} chips, short of the ${expectedFloor} its ${roster.length} seats were bought for - the stacks were not credited`
        );
      }
      if (rosterChips <= 0) {
        return refuse('the playing roster holds no chips at all - the stacks were not credited');
      }
      if (!roster.some((row) => Number(row.chips) > 0)) {
        return refuse('no seat on the playing roster holds a positive stack');
      }
    }
    if (new Set(roster.map((row) => row.user_id)).size !== roster.length) {
      return refuse('the active roster contains a duplicate player');
    }
    const provenPlayerIds = roster.map((row) => String(row.user_id)).sort();
    const expectedIds = [...expectedPlayerIds].sort();
    if (
      provenPlayerIds.length !== expectedIds.length ||
      provenPlayerIds.some((userId, index) => userId !== expectedIds[index])
    ) {
      return refuse('the active roster changed after launch migration began');
    }

    const { data: durableTableRows, error: durableTablesErr } = await supabase
      .from('tables')
      .select('id, status, current_players, max_players')
      .eq('tournament_id', this.tournamentId)
      .in('status', ['running', 'waiting']);
    this.assertLifecycleCurrent(lifecycle);
    if (durableTablesErr) {
      return refuse(
        `the tournament table inventory could not be read: ${durableTablesErr.message}`
      );
    }
    const durableTables = (durableTableRows ?? []) as Array<{
      id?: string | null;
      status?: string | null;
      current_players?: number | null;
      max_players?: number | null;
    }>;
    const durableTablesById = new Map(
      durableTables.map((table) => [String(table.id ?? ''), table] as const)
    );
    if (
      durableTables.length === 0 ||
      durableTables.length !== this.tableEngines.size ||
      [...this.tableEngines.keys()].some((tableId) => !durableTablesById.has(tableId))
    ) {
      return refuse('the durable open tables and inert engine inventory do not match exactly');
    }

    const { data: seatRows, error: seatErr } = await supabase
      .from('table_seats')
      .select(
        'user_id, table_id, seat_number, stack, tables!inner(id, tournament_id, status, current_players)'
      )
      .is('left_at', null)
      .eq('tables.tournament_id', this.tournamentId);
    this.assertLifecycleCurrent(lifecycle);
    if (seatErr) return refuse(`the live seats could not be read: ${seatErr.message}`);

    const seats = (seatRows ?? []) as Array<{
      user_id?: string | null;
      table_id?: string | null;
      seat_number?: number | null;
      stack?: number | null;
      tables?:
        | {
            id?: string | null;
            status?: string | null;
            current_players?: number | null;
          }
        | Array<{
            id?: string | null;
            status?: string | null;
            current_players?: number | null;
          }>
        | null;
    }>;
    if (seats.length !== roster.length) {
      return refuse(
        `the roster has ${roster.length} players but the felt has ${seats.length} seats`
      );
    }
    const seatsByUser = new Map<string, typeof seats>();
    const seatsByTable = new Map<string, number>();
    const occupiedCoordinates = new Set<string>();
    for (const seat of seats) {
      const userId = String(seat.user_id ?? '');
      const tableId = String(seat.table_id ?? '');
      if (userId) seatsByUser.set(userId, [...(seatsByUser.get(userId) ?? []), seat]);
      if (tableId) seatsByTable.set(tableId, (seatsByTable.get(tableId) ?? 0) + 1);
      const durableTable = durableTablesById.get(tableId);
      const seatNumber = Number(seat.seat_number);
      if (
        !durableTable ||
        !Number.isInteger(seatNumber) ||
        seatNumber <= 0 ||
        seatNumber > Number(durableTable.max_players)
      ) {
        return refuse(`${userId.slice(0, 8)} occupies an invalid tournament table coordinate`);
      }
      const coordinate = `${tableId}:${seatNumber}`;
      if (occupiedCoordinates.has(coordinate)) {
        return refuse(`more than one player occupies ${coordinate}`);
      }
      occupiedCoordinates.add(coordinate);
    }

    for (const player of roster) {
      const userId = String(player.user_id);
      const ownedSeats = seatsByUser.get(userId) ?? [];
      if (ownedSeats.length !== 1) {
        return refuse(`${userId.slice(0, 8)} owns ${ownedSeats.length} live seats`);
      }
      const seat = ownedSeats[0];
      if (
        seat.table_id !== player.table_id ||
        Number(seat.seat_number) !== Number(player.seat_number)
      ) {
        return refuse(`${userId.slice(0, 8)} has contradictory roster and seat coordinates`);
      }
      // Same rule as the roster conservation above: a seat that has been played
      // down to zero is funded, it is just busted. Only a stack that is missing
      // or impossible is a funding failure at this point; the seat TOTAL is
      // checked once, below, against what the field was bought for.
      if (
        !stacksMayBeDeferred &&
        (!Number.isFinite(Number(seat.stack)) || Number(seat.stack) < 0)
      ) {
        return refuse(`${userId.slice(0, 8)} has no funded stack`);
      }
    }

    // The felt has to hold what the field paid for. One seat at zero is a bust;
    // every seat short of the floor is a credit that never landed, and that is
    // the case this proof exists to stop from ever dealing a hand.
    if (!stacksMayBeDeferred) {
      const startingChips = Math.max(0, Math.floor(Number(tournament?.starting_chips) || 0));
      const seatChips = seats.reduce((sum, seat) => sum + Number(seat.stack ?? 0), 0);
      const expectedFloor = roster.length * startingChips;
      if (startingChips > 0 && seatChips < expectedFloor) {
        return refuse(
          `the felt holds ${seatChips} chips, short of the ${expectedFloor} its ${roster.length} seats were bought for`
        );
      }
    }

    for (const durableTable of durableTables) {
      const tableId = String(durableTable.id ?? '');
      const liveCount = seatsByTable.get(tableId) ?? 0;
      if (!tableId || !['running', 'waiting'].includes(String(durableTable.status ?? ''))) {
        return refuse(`table ${tableId.slice(0, 8)} is not durably open`);
      }
      if (Number(durableTable.current_players) !== liveCount) {
        return refuse(
          `table ${tableId.slice(0, 8)} says ${String(durableTable.current_players)} players but owns ${liveCount} live seats`
        );
      }
      if (!this.tableEngines.has(tableId)) {
        return refuse(`table ${tableId.slice(0, 8)} has no inert engine ready for admission`);
      }
    }

    const spinLaunch =
      String(tournament.variant ?? '').toLowerCase() === 'spin' ||
      String(tournament.tournament_type ?? '').toUpperCase() === 'SPIN';
    if (spinLaunch && Number(tournament.buy_in_amount) > 0) {
      const { data: bookedRows, error: bookedErr } = await supabase
        .from('spin_reserve_ledger')
        .select('multiplier, buy_in, seats, house_rake')
        .eq('tournament_id', this.tournamentId)
        .eq('kind', 'jackpot_draw');
      this.assertLifecycleCurrent(lifecycle);
      if (bookedErr) return refuse(`the Spin settlement could not be read: ${bookedErr.message}`);
      const bookedMultiplier = Number(bookedRows?.[0]?.multiplier);
      const rowMultiplier = Number(tournamentProof.spin_multiplier);
      const buyIn = Number(tournament.buy_in_amount);
      const expectedPrizePool = Math.round(buyIn * bookedMultiplier * 100) / 100;
      const expectedRake = Math.round(buyIn * SPEC_SPIN_SEATS * spinRakeRate(buyIn) * 100) / 100;
      if (
        bookedRows?.length !== 1 ||
        !Number.isFinite(bookedMultiplier) ||
        bookedMultiplier <= 0 ||
        bookedMultiplier !== Number(tournament.spin_multiplier) ||
        rowMultiplier !== bookedMultiplier ||
        Number(bookedRows[0].buy_in) !== buyIn ||
        Number(bookedRows[0].seats) !== SPEC_SPIN_SEATS ||
        Number(bookedRows[0].house_rake) !== expectedRake ||
        Number(tournamentProof.prize_pool) !== expectedPrizePool ||
        Number(tournament.prize_pool) !== expectedPrizePool
      ) {
        return refuse('the Spin row and reserve settlement do not prove the same exact launch');
      }
    }

    return true;
  }

  async start(): Promise<void> {
    if (this.teardownPromise) await this.teardownPromise;
    if (!this.tournamentLeaseAuthorityIsCurrent()) {
      this.expireTournamentLeaseAuthority();
      return;
    }
    if (this.lifecycleOperation) return this.lifecycleOperation;
    this.stopFenceApplied = false;
    this.shutdownDrainFenceApplied = false;
    const lifecycle = this.lifecycleEpoch.begin();
    this.running = true;
    this.armTournamentLeaseExpiryTimer();
    const operation = this.startLifecycle(lifecycle);
    this.lifecycleOperation = operation;
    try {
      await operation;
    } finally {
      if (this.lifecycleOperation === operation) this.lifecycleOperation = null;
    }
  }

  private async startLifecycle(lifecycle: TournamentLifecycleToken): Promise<void> {
    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] Starting...`);

    try {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', this.tournamentId)
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
      this.assertLifecycleCurrent(lifecycle);

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
      this.tournamentEntryWindowClosed = this.prizePoolFinalized;
      this.tournamentEntryCloseAnnounced = false;
      this.tournamentEntryRepricePending = false;
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
      /**
       * ═════════════════════════════════════════════════════════════════
       *  ONE READ, NOT TWO (2026-08-31 audit)
       * ═════════════════════════════════════════════════════════════════
       *
       * This head-count and the paid-entry roster below issued the SAME
       * query — `tournament_players` for this tournament with status in
       * ('registered','playing') — one asking for the count and one for the
       * rows, back to back, both on the critical path between the third
       * payment and the wheel.
       *
       * `spin_reveal_lag_ms` now measures that path (p50 4.2s, and 93% of
       * spins miss Dan's one-second rule outright), and five sequential
       * round trips sit inside it. This is the one that was free to remove:
       * a Spin holds three players, so the rows ARE the count.
       *
       * Only for a Spin with a buy-in — i.e. only where the paid gate below
       * is going to read them anyway. An MTT keeps the head count, because
       * reading 390 player rows to learn there are 390 would be the same
       * trade made backwards.
       */
      const spinPaidGateWillRun =
        (tournament.variant === 'spin' || tournament.tournament_type === 'SPIN') &&
        Number(tournament.buy_in_amount || 0) > 0;

      let regCount: number | null = null;
      let spinRoster: Array<{ user_id?: string | null; table_id?: string | null }> | null = null;

      if (spinPaidGateWillRun) {
        /* THE GATE MUST NOT DISABLE ITSELF ON A FAILED READ (2026-08-28).
           Unreadable evidence is not evidence of an empty field: stand down
           and let the next pass retry, exactly as the paid gate below does
           with its own read. Hoisting the read must not weaken that. */
        const { data: roster, error: rosterErr } = await supabase
          .from('tournament_players')
          /* `table_id` costs nothing here — this read already happens — and
             it is what lets the wheel fire the INSTANT the draw resolves
             rather than after the settle, the row write, the per-player
             updates and the table build (round 18). */
          .select('user_id, table_id')
          .eq('tournament_id', this.tournamentId)
          .in('status', ['registered', 'playing']);
        this.assertLifecycleCurrent(lifecycle);
        if (rosterErr) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Paid-entry roster unreadable (${rosterErr.message}) - standing down, will retry`
            ),
            'Tournament.spin_paid_roster_unreadable'
          );
          this.running = false;
          return;
        }
        spinRoster = roster ?? [];
        regCount = spinRoster.length;
      } else {
        const { count } = await supabase
          .from('tournament_players')
          .select('*', { count: 'exact', head: true })
          .eq('tournament_id', this.tournamentId)
          .in('status', ['registered', 'playing']);
        this.assertLifecycleCurrent(lifecycle);
        regCount = count ?? 0;
      }

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
          `[Tournament:${this.tournamentId.slice(0, 8)}] Only ${regCount} of ${requiredField} player(s) - standing down so the field can be filled (NOT cancelling)`
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
          /* ALREADY READ, ABOVE. The head-count gate issued this exact query
             and kept the rows (see "ONE READ, NOT TWO"). Its failure policy
             is identical — an unreadable roster stands the start down — so
             nothing this gate depends on has been weakened; the second round
             trip is simply gone from the path between the third payment and
             the wheel. `spinRoster` is non-null here by construction:
             spinPaidGateWillRun is the same condition as this block. */
          const regs = spinRoster ?? [];
          const regIds = (regs ?? []).map((r: any) => r.user_id).filter(Boolean);
          /* The tables these paid seats are already sitting at. Distinct, and
             usually exactly one for a Spin. Used only by the early reveal. */
          this.seatFirstTableIds = Array.from(
            new Set((regs ?? []).map((r: any) => r.table_id).filter(Boolean) as string[])
          );

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
          this.assertLifecycleCurrent(lifecycle);

          if (debitErr) {
            // Evidence unreadable ≠ evidence of non-payment. Stand down and
            // try again next pass rather than kicking players over a blip.
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Paid-entry check unreadable (${debitErr.message}) - standing down, will retry`
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
                  .join(', ')}) - removing them; a spin NEVER starts until 3 players have paid`
              ),
              'Tournament.spin_unpaid_registration_removed'
            );
            await supabase
              .from('tournament_players')
              .delete()
              .eq('tournament_id', this.tournamentId)
              .in('user_id', unpaid);
            this.assertLifecycleCurrent(lifecycle);
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
            this.assertLifecycleCurrent(lifecycle);
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
            this.assertLifecycleCurrent(lifecycle);
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

      /**
       * THE LAUNCH HAS ONE DURABLE ADMISSION POINT (2026-09-07).
       *
       * Every field and paid-entry precondition above is still read while the
       * tournament is merely REGISTERING. The receipt below is the first
       * launch write and holds the shared maintenance boundary for its whole
       * transaction. Settlement, registration migration, stack funding and
       * table construction are therefore recovery work owned by this exact
       * receipt, never work that can begin after maintenance has closed entry.
       *
       * `started_at` comes from an existing durable start first, then the
       * advertised start. If neither exists, NULL asks the database to stamp
       * its transaction time into the new receipt; an incomplete replay then
       * adopts that stored value instead of reconstructing it locally.
       */
      const scheduledStartMs = Date.parse(String(tournament.start_time ?? ''));
      const existingStartMs = Date.parse(String(tournament.started_at ?? ''));
      const requestedStartedAtIso = Number.isFinite(existingStartMs)
        ? new Date(existingStartMs).toISOString()
        : Number.isFinite(scheduledStartMs)
          ? new Date(scheduledStartMs).toISOString()
          : null;
      const requestedLaunchId = nodeCrypto.randomUUID();
      const launchClaim = await this.beginTournamentLaunch(
        lifecycle,
        requestedLaunchId,
        requestedStartedAtIso
      );
      this.assertLifecycleCurrent(lifecycle);
      if (!launchClaim || launchClaim.completed) {
        this.running = false;
        return;
      }
      const { launchId, startedAtIso } = launchClaim;
      const launchStartMs = Date.parse(startedAtIso);
      this.preStartLeadMs = launchStartMs > Date.now() ? launchStartMs - Date.now() : 0;

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
          /* A CRASH BETWEEN SETTLE AND THE ROW WRITE MUST NOT REDRAW
             (2026-08-30 audit). The settle books the drawn multiplier into
             spin_reserve_ledger BEFORE the tournament row is patched with it.
             A process death in that window restarts start() with
             spin_multiplier NULL, and drawing again here would broadcast and
             PAY a different prize than the ledger booked - silently, because
             fn_spin_settle_game answers already_settled. The ledger is the
             booked truth, so it is consulted first; unreadable evidence is a
             stand-down (the house rule), never a licence to redraw. */
          const { data: bookedRows, error: bookedErr } = await supabase
            .from('spin_reserve_ledger')
            .select('multiplier')
            .eq('tournament_id', this.tournamentId)
            .eq('kind', 'jackpot_draw')
            .limit(1);
          this.assertLifecycleCurrent(lifecycle);
          if (bookedErr) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Booked-draw ledger unreadable (${bookedErr.message}) - standing down rather than risking a redraw of a settled spin`
              ),
              'Tournament.spin_booked_draw_unreadable'
            );
            this.running = false;
            return;
          }
          const bookedMult = Number(bookedRows?.[0]?.multiplier);
          if (Number.isFinite(bookedMult) && bookedMult > 0) {
            spinMultiplier = bookedMult;
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Adopting ALREADY-BOOKED ${bookedMult}x from spin_reserve_ledger - a previous process settled this spin but died before writing the row`
              ),
              'Tournament.spin_adopted_booked_multiplier'
            );
          }
        }

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
              this.assertLifecycleCurrent(lifecycle);
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
              if (err instanceof TournamentLifecycleAbortedError) throw err;
              drawFailure = err?.message ? String(err.message) : String(err);
              // Same short backoff the settlement and row-write loops below
              // use; lock contention on a busy club's reserve pool is the
              // expected cause and it clears in well under a second.
              if (attempt < 3) {
                await new Promise((r) => setTimeout(r, 250 * attempt));
                this.assertLifecycleCurrent(lifecycle);
              }
            }
          }
          this.assertLifecycleCurrent(lifecycle);
          if (!spinMultiplier || spinMultiplier <= 0) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw UNAVAILABLE after 3 attempts (${drawFailure ?? 'no multiplier returned'}) - standing down; NO multiplier is invented and NO wheel is shown`
              ),
              'Tournament.spin_draw_unavailable'
            );
            console.error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw unavailable - standing down so the start can be retried (NOT cancelling, NOT defaulting to a tier)`
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
        let prizePool = Math.round(buyIn * spinMultiplier * 100) / 100;

        /**
         * ═══════════════════════════════════════════════════════════════════
         *  THE WHEEL FIRES HERE, NOT FOUR ROUND TRIPS LATER (round 18)
         * ═══════════════════════════════════════════════════════════════════
         *
         * Dan: "AS SOON AS THE 3RD SEAT IS PAID FOR THE ANIMATION SHOULD
         * START AS SOON AS POSSIBLE."
         *
         * The draw has just resolved, and the draw is the ONLY thing the
         * wheel is waiting on — every number the packet carries is already
         * known on this line: the multiplier, the buy-in, and `prizePool`,
         * computed immediately above from the two of them.
         *
         * Everything that used to sit between here and the broadcast is
         * bookkeeping the player cannot see: `fn_spin_settle_game`, the spin
         * row write, a roster read plus a per-player update for each seat,
         * the stack credit, and the table build. Measured post-round-16 over
         * 229 spins, third paid seat to `started_at` was p50 3.02s with a
         * floor of 1.57s — and the old broadcast sat behind all of it.
         *
         * None of that work is a precondition for showing three players a
         * spinning wheel. It is a precondition for DEALING, and dealing is
         * already held for `spinRevealToDealMs` by the hold below, which is
         * far longer than the work takes. So the reveal goes out now and the
         * bookkeeping continues underneath it, inside a hold that was always
         * there.
         *
         * The later block still runs: it applies `holdDealingUntil` to each
         * engine once they exist, and re-emits for any table this early pass
         * could not name. `resolveSpinReveal` is frozen the moment this fires
         * (`spinRevealEmitted`), so the second emit carries the SAME instant
         * and cannot move a wheel that is already turning.
         */
        if (this.seatFirstTableIds.length > 0 && spinMultiplier > 0) {
          const { revealAt, holdUntil } = this.resolveSpinReveal();
          this.spinRevealEmitted = true;
          for (const tableId of this.seatFirstTableIds) {
            try {
              tableStateHub.emitEvent(tableId, {
                type: 'spin_reveal',
                table_id: tableId,
                tournament_id: this.tournamentId,
                multiplier: spinMultiplier,
                buy_in: buyIn,
                locked_tiers: tournament.spin_locked_tiers ?? null,
                reveal_at: revealAt,
                hold_until: holdUntil,
                reveal_lag_ms: this.spinRevealLagMs,
                prize_pool: prizePool,
                timestamp: revealAt,
                /* THE REPLAY WINDOW COVERS THE HOLD THE ENGINE WILL ACTUALLY
                   KEEP, NOT THE ONE PLANNED HERE (fixed 2026-09-02).

                   This read `holdUntil`, but the pass further down extends the
                   hold to `Math.max(holdUntil, now + spinPostRevealMs())` so
                   the post-reveal beats always have room. The hub drops a
                   replay packet once `replay_until` passes, so on exactly the
                   bad day the extension exists for, a player reconnecting
                   between the planned hold and the real one got NO reveal at
                   all while the cards were still legally undealt. Same floor,
                   computed the same way. */
                replay_until: Math.max(holdUntil, Date.now() + spinPostRevealMs()),
              });
            } catch (err) {
              /* The reveal is theatre; it must never stop a game starting. */
              reportError(
                err,
                'Tournament.' + this.tournamentId.slice(0, 8) + '.spin_reveal_early_emit'
              );
            }
          }
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Spin reveal broadcast EARLY - ${spinMultiplier}x to ${this.seatFirstTableIds.length} table(s), ${this.spinRevealLagMs}ms behind the third payment, settle and table build still to come inside the hold`
          );
        }

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
            this.assertLifecycleCurrent(lifecycle);
            if (settleErr || !settle?.ok) {
              throw new Error(settleErr?.message || settle?.reason || 'settle_failed');
            }
            settled = true;
            /* THE LEDGER OUTRANKS A FRESH DRAW (2026-08-30). already_settled
               now carries the multiplier the original settlement booked. If it
               disagrees with the one this process holds, the booked one is the
               money truth - adopt it before the row write and the payouts
               below, and say so loudly. The pre-draw ledger check makes this
               near-unreachable; this is the backstop for a race between two
               processes settling the same spin. */
            if (settle.reason === 'already_settled') {
              const booked = Number(settle.multiplier);
              if (Number.isFinite(booked) && booked > 0 && booked !== spinMultiplier) {
                reportError(
                  new Error(
                    `[Tournament:${this.tournamentId.slice(0, 8)}] Settle was ALREADY BOOKED at ${booked}x but this process drew ${spinMultiplier}x - adopting the booked ${booked}x`
                  ),
                  'Tournament.spin_settle_multiplier_mismatch'
                );
                spinMultiplier = booked;
                prizePool = Math.round(buyIn * spinMultiplier * 100) / 100;
              }
            }
            if (Number(settle.operator_shortfall) > 0) {
              // The pool was too thin to cover the prize. Players are paid in
              // full regardless; this says the club needs seeding.
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Spin pool SHORTFALL ${settle.operator_shortfall} on a ${spinMultiplier}x - club ${tournament.club_id} needs a larger reserve seed`
                ),
                'Tournament.spin_pool_shortfall'
              );
            }
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] SPIN ${spinMultiplier}x - pool ${prizePool}, rake ${settle.house_rake}, reserve ${settle.balance}`
            );
          } catch (settleErr: any) {
            if (settleErr instanceof TournamentLifecycleAbortedError) throw settleErr;
            if (attempt === 3) {
              // Settlement is part of launch, not optional accounting. The
              // incomplete launch receipt keeps the tournament REGISTERING so
              // the next start pass can replay this idempotent RPC exactly.
              reportError(
                new Error(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Spin reserve settlement FAILED after 3 attempts (${settleErr?.message}) - standing down before RUNNING; the incomplete launch receipt will retry the same settlement`
                ),
                'Tournament.spin_settle_failed'
              );
            } else {
              await new Promise((r) => setTimeout(r, 250 * attempt));
              this.assertLifecycleCurrent(lifecycle);
            }
          }
        }
        this.assertLifecycleCurrent(lifecycle);
        if (!settled) {
          this.running = false;
          return;
        }

        // BLINDS scale with the drawn tier. THE STACK DOES NOT, and has not
        // since 2026-09-01: it is a property of the BOARD (Turbo 300, Deep
        // Stack 1000, spinSpec SPIN_STACKS), written at creation and held by
        // the seat from the moment the buy-in is paid. This comment used to
        // read "300 chips at 2x, 500 chips at 500x", describing the retired
        // behaviour where the wheel decided how many chips you played with.
        // The code below never did that; the sentence did, and spinSpec warns
        // in as many words not to reintroduce it. Since the draw moved to
        // start, creation writes only a smallest-tier placeholder, so the
        // blinds MUST be rewritten here — before
        // createTablesAndSeatPlayers below reads them — or a 500x would run
        // on 1-minute levels.
        // Settlement may adopt an already-booked multiplier. Derive every
        // tier-dependent field from that final value, including payout shares.
        const tier = spinTier(spinMultiplier);
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
        // The payload is hoisted so write and read-back prove the exact same
        // shape. If that proof cannot be obtained, the launch receipt remains
        // incomplete and the game stays REGISTERING; the next admission pass
        // retries this idempotent write before any dealer can exist.
        const spinRowPatch = {
          prize_pool: prizePool,
          spin_multiplier: spinMultiplier,
          is_premium_spin: spinMultiplier >= 100,
          /* THE STACK IS NOT WRITTEN HERE ANY MORE (Dan, 2026-09-01).
             It used to read `tier?.startingStack ?? tournament.starting_chips`,
             so the wheel decided how many chips the players had -- 300, 1000 or
             5000 depending on what it landed on. That is retired: the stack
             belongs to the board (Turbo 300, Deep Stack 1000, spinSpec
             SPIN_STACKS), it is written at creation, and the seat holds it from
             the moment the buy-in is paid. Re-adding it here would put the seat
             back to guessing until the draw lands. */
          starting_chips: tournament.starting_chips,
          blind_structure: spinBlinds,
          payout_structure: (tier?.payouts ?? [1]).map((pct, i) => ({
            place: i + 1,
            percentage: Math.round(pct * 10000) / 100,
          })),
          /* THE ONE NUMBER DAN ASKS ABOUT, WRITTEN DOWN (2026-08-31 audit).
             How far behind the third payment the wheel actually went out.
             It was computed on every spin, logged to the console and sent to
             the client — and persisted nowhere, so the only way to answer
             "is the wheel still opening on time?" was for an agent to
             hand-measure it, which is how a 3.0s p50 drifted to 13.7s over a
             day without anything noticing. It rides the write that already
             carries the draw, so it costs no extra round trip, and
             v_spin_reveal_latency reads it back. */
          spin_reveal_lag_ms: Math.round(this.spinRevealLagMs),
          /* THE OTHER HALF OF THE LAG NUMBER (Dan 2026-09-05): "THERE IS NO
             SOUND EFFECT OR COUNT DOWN FOR THE SPIN ANIMATION."

             `spin_reveal_lag_ms` above says HOW LATE the wheel went out; this
             says WHEN it was anchored, which is the number a client needs to
             animate it. Without it `buildSpinDrawFromRow` had to key on
             `started_at`, and the lag beside it measures exactly how wrong
             that is - a 4.2s p50 against a 1000ms lead-in and a 3000ms
             countdown, so every client on the DB fallback path skipped both
             and watched a silent spinner. See the migration
             20260905065304_the_wheel_is_anchored_to_the_instant_the_engine_chose.

             `spinRevealAt` is already frozen by here: resolveSpinReveal ran in
             the early-emit block above and set `spinRevealEmitted`, so this is
             the SAME instant the packet carries and the two can never
             disagree. Zero means the anchor was never stamped (no seat-first
             table to emit to); null then, and the client keeps its
             started_at fallback rather than being handed the epoch. */
          spin_reveal_at: this.spinRevealAt > 0 ? new Date(this.spinRevealAt).toISOString() : null,
          ...(redrawnLockedTiers ? { spin_locked_tiers: redrawnLockedTiers } : {}),
        };
        let spinRowWritten = false;
        let spinRowLastError = '';
        const spinRowProjection = Object.keys(spinRowPatch).join(',');
        for (let attempt = 1; attempt <= 3 && !spinRowWritten; attempt++) {
          const { error: spinRowErr } = await supabase
            .from('tournaments')
            .update(spinRowPatch)
            .eq('id', this.tournamentId);
          this.assertLifecycleCurrent(lifecycle);
          if (!spinRowErr) {
            const { data: spinRowProof, error: spinRowProofErr } = await supabase
              .from('tournaments')
              .select(spinRowProjection)
              .eq('id', this.tournamentId)
              .maybeSingle();
            this.assertLifecycleCurrent(lifecycle);
            if (
              !spinRowProofErr &&
              this.launchRowMatchesPatch(
                spinRowProof as Record<string, unknown> | null,
                spinRowPatch as unknown as Record<string, unknown>
              )
            ) {
              spinRowWritten = true;
              break;
            }
            spinRowLastError =
              spinRowProofErr?.message || 'the draw row read-back did not match the exact patch';
          } else {
            spinRowLastError = spinRowErr.message;
          }
          if (attempt === 3) {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Spin draw row was not proven after 3 attempts (${spinRowLastError}) - standing down before RUNNING; the incomplete launch receipt will replay the exact booked draw`
              ),
              'Tournament.spin_draw_row_write_failed'
            );
          } else {
            await new Promise((r) => setTimeout(r, 250 * attempt));
            this.assertLifecycleCurrent(lifecycle);
          }
        }
        if (!spinRowWritten) {
          this.running = false;
          return;
        }

        // The stack came from the board and is already on the row; the draw
        // does not change it (see spinRowPatch above).
        /* THE WHOLE PATCH, ONTO BOTH COPIES (2026-08-31).
           The in-memory object drives table creation and the level timer, and
           tournamentCache is what the elimination and bubble paths read for
           the rest of the game, so both must agree with what was just written
           — the DB write alone would leave this start running on the
           placeholder structure.

           This was a hand-written list of field names and it copied FOUR of
           the patch's five fields. `payout_structure` was the one it dropped,
           so a started Spin's cache kept the pre-draw winner-take-all
           placeholder for the life of the game, and
           `recalculateEliminatedPrizes` (which reads the cache) topped up
           eliminated players against a different structure than the one that
           had paid them. On a 10x that is 80/20 versus 100/0.

           applySpinDrawPatch copies EVERY key of the patch, so the patch is
           now the only list there is: add a sixth field and it is synced by
           construction. Never re-introduce a per-field copy here. */
        applySpinDrawPatch(
          spinRowPatch as unknown as Record<string, unknown>,
          tournament as unknown as Record<string, unknown>,
          this.tournamentCache as unknown as Record<string, unknown> | null
        );
      }

      // Migrate registrations (registered -> playing).
      //
      // EARLY BIRD (2026-08-22 parity): fn_register_for_tournament credits the
      // early-bird bonus into tournament_players.chips AT REGISTRATION, so a
      // 'registered' row's chips column is the pre-credited bonus (0 for
      // everyone else). Seating must therefore ADD the starting stack to that
      // bonus — the old single-statement UPDATE overwrote it with
      // starting_chips and silently destroyed every bonus ever granted.
      let expectedLaunchPlayerIds: string[] = [];
      {
        const { data: regRows, error: regRowsErr } = await supabase
          .from('tournament_players')
          .select('user_id, chips, status')
          .eq('tournament_id', this.tournamentId)
          .in('status', ['registered', 'playing']);
        this.assertLifecycleCurrent(lifecycle);
        if (regRowsErr) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Registration migration roster was unreadable (${regRowsErr.message}) - standing down before table construction`
            ),
            'Tournament.launch_roster_migration_read_failed'
          );
          this.running = false;
          return;
        }
        expectedLaunchPlayerIds = (regRows ?? []).map((row) => String(row.user_id ?? ''));
        if (
          expectedLaunchPlayerIds.length < requiredField ||
          expectedLaunchPlayerIds.some((userId) => !userId) ||
          new Set(expectedLaunchPlayerIds).size !== expectedLaunchPlayerIds.length
        ) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Registration migration roster was not a complete unique field - standing down before table construction`
            ),
            'Tournament.launch_roster_migration_invalid'
          );
          this.running = false;
          return;
        }
        const migrationResults = await Promise.all(
          (regRows ?? [])
            .filter((row) => row.status === 'registered')
            .map((row: { user_id: string; chips: number | null }) => {
              const bonus = Math.max(0, Math.floor(Number(row.chips) || 0));
              return supabase
                .from('tournament_players')
                .update({ status: 'playing', chips: tournament.starting_chips + bonus })
                .eq('tournament_id', this.tournamentId)
                .eq('user_id', row.user_id)
                .eq('status', 'registered');
            })
        );
        this.assertLifecycleCurrent(lifecycle);
        const migrationFailure = migrationResults.find((result) => result.error)?.error;
        if (migrationFailure) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Registration migration was not complete (${migrationFailure.message}) - standing down before table construction`
            ),
            'Tournament.launch_roster_migration_failed'
          );
          this.running = false;
          return;
        }
      }

      /**
       * SEAT-FIRST STACK SYNC — but NOT yet, if a wheel is about to turn.
       *
       * A player who sat down before the game started used to hold a
       * RESERVATION at zero chips, because stack depth was read off the drawn
       * tier and there was no honest number to seat them with until the wheel
       * landed. THAT IS RETIRED. The stack belongs to the board (Turbo 300,
       * Deep Stack 1000), it is known before anybody sits, and Dan's rule is
       * that it appears the instant the buy-in is paid: "as soon as they buy
       * in 300 chips should appear in their action box (not 0)".
       *
       * Dan 2026-08-21: "AFTER THE SPIN COMPLETES, CHIP STACKS GET ADDED,
       * BUTTON RANDOMLY ASSIGNED AND THE SPIN STARTS." Crediting here — which
       * is what used to happen — put the stacks on the felt while the wheel
       * was still turning, so the table had already answered the question the
       * wheel was in the middle of asking. For a Spin the credit is scheduled
       * after the reveal instead; everything else is credited now.
       */
      let stacksMayBeDeferred = await this.deferStacksForSpinReveal(tournament);
      if (!stacksMayBeDeferred) {
        this.assertLifecycleCurrent(lifecycle);
        await this.creditSeatStacks(tournament);
        this.assertLifecycleCurrent(lifecycle);
      } else {
        this.assertLifecycleCurrent(lifecycle);
        /**
         * The credit is now in the future, so the bust sweep must be too.
         * Armed to the same instant the engine is allowed to deal, plus one
         * explicit post-credit slack, so the first sweep that can ever bust
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
          TournamentManagerBase.POST_CREDIT_BUST_SLACK_MS;
      }

      // Create tables and seat players
      await this.createTablesAndSeatPlayers(tournament);
      this.assertLifecycleCurrent(lifecycle);

      /* FREE BUY: open only AFTER the field has real live seats. The old call
         ran near the top of start(), before registration migration, table
         creation, or seating. Its automatic horse purchases therefore found
         no eligible seats, and its broadcast offered humans an add-on the
         database correctly refused. Opening here still satisfies "as soon as
         they sit down" while making the seat the precondition it has always
         been at the money boundary. */
      if (tournament.addon_from_start && tournament.add_on_available) {
        await this.triggerAddOnPeriod();
        this.assertLifecycleCurrent(lifecycle);
        if (!this.addOnPeriodTriggered) {
          // This is the only edge that can give a Free Buy field its promised
          // from-start window. Starting the dealers after an unproven CAS would
          // silently collapse that hour to the later break-only fallback.
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Free Buy add-on window was not durably proven after seating - standing down before dealer admission`
            ),
            'Tournament.free_buy_addon_open_unproven'
          );
          this.running = false;
          return;
        }
      }

      /**
       * ═══════════════════════════════════════════════════════════════════════
       *  THE PRE-SEAT MINUTE (Dan 2026-08-30, binding)
       * ═══════════════════════════════════════════════════════════════════════
       *
       * "When a player is registered, they should be 'sat down' one minute
       *  before the event starts."
       *
       * GameServer discovers a timed event TOURNAMENT_PRESEAT_LEAD_MS before its
       * `start_time`, so by this line the tables exist and every registered
       * player — human and horse alike — is in a seat with a stack, one minute
       * ahead of the clock. What must NOT move with them is the poker: the
       * lobby advertised a start time and that is when the first card is dealt.
       *
       * So the whole field is held to the advertised instant, using the same
       * `holdDealingUntil` deadline the spin wheel uses. `holdDealingUntil` is
       * monotonic (it only ever takes the later of the two), so a spin reveal
       * arming its own longer hold a few lines below cannot be shortened by
       * this one, and this cannot be shortened by it.
       *
       * `preStartLeadMs` is what the level clock reads at the bottom of start():
       * arming it here would spend the first minute of level 1 on an empty
       * felt, and a 10-minute level would be a 9-minute level for everybody.
       *
       * SECTION 10.5. There is no horse branch anywhere in this window. Every
       * seat is filled by the same pass and every seat waits out the same
       * minute — a felt that filled a horse seat and dealt to it while the
       * human seats were still held would announce which is which.
       */
      if (this.preStartLeadMs > 0) {
        for (const engine of this.tableEngines.values()) {
          engine.holdDealingUntil(launchStartMs);
        }
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Pre-seated ${this.tableEngines.size} table(s) - holding the deal ${Math.round(this.preStartLeadMs / 1000)}s until the admitted start ${startedAtIso}`
        );
      }

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
        /**
         * ONE-SIDED SAFETY ON THE HOLD (round 18).
         *
         * Freezing the reveal at the early emit means `holdUntil` is now
         * decided BEFORE the settle, the row write and the table build,
         * rather than after them. In the normal case that work costs a second
         * or two out of a 16.6s hold and nothing changes. On a bad day — a
         * slow settle, a retry loop — it could in principle consume the whole
         * hold, and the re-anchor that used to catch exactly that is
         * deliberately disabled once the moment is public (three wheels are
         * already turning on those numbers; moving them is worse).
         *
         * So the HOLD is extended instead of the reveal being moved. Clients
         * clamp their animation to the `hold_until` they were given and are
         * allowed to finish EARLY — "faster than the budget is allowed: that
         * player's wheel lands early and the felt simply waits" — so a longer
         * server hold desynchronises nothing. It only ever guarantees the
         * post-reveal beats (chip drop, button draw) still have room, which
         * is the floor below which a card would land on a moving wheel.
         */
        const effectiveHold = Math.max(holdUntil, Date.now() + spinPostRevealMs());
        for (const [tableId, engine] of this.tableEngines) {
          try {
            /* THE HOLD IS APPLIED EITHER WAY (round 18). The early emit above
               reached the players; it could not reach the ENGINE, which did
               not exist yet. This is where dealing is actually held, and it
               must happen for every table whether or not the wheel was
               already announced to it. */
            engine.holdDealingUntil(effectiveHold);
            /* Already announced to this table by the early pass — the wheel
               is turning on those exact numbers. Re-emitting is harmless (the
               client guards a second open) but pointless, and skipping keeps
               one reveal to one table. */
            if (this.spinRevealEmitted && this.seatFirstTableIds.includes(tableId)) continue;
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
              /* `effectiveHold`, not `holdUntil` (fixed 2026-09-02). The
                 comment above says this is "the same number
                 `holdDealingUntil` was just given, so it is the contract and
                 not a description of one" - and it was not: the engine was
                 held to `effectiveHold` while the client was told
                 `holdUntil`. On the overrun path, the only path where the two
                 differ, the client clamped against a deadline the engine had
                 already abandoned. */
              hold_until: effectiveHold,
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
              replay_until: effectiveHold,
            });
          } catch (err) {
            // The reveal is theatre; it must never stop a game from starting.
            reportError(err, 'Tournament.' + this.tournamentId.slice(0, 8) + '.spin_reveal_emit');
          }
        }
        this.scheduleSpinPostReveal(tournament, revealAt);
        if (stacksMayBeDeferred) {
          // Completion may not turn the tournament RUNNING while its promised
          // stacks still exist only in a timer. Wait for the public chip-drop
          // beat, perform the idempotent credit in this owned lifecycle, then
          // require the launch proof below to read every positive stack back.
          const chipsAt = revealAt + spinRevealTotalMs();
          const waitForChipDropMs = Math.max(0, chipsAt - Date.now());
          if (waitForChipDropMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitForChipDropMs));
            this.assertLifecycleCurrent(lifecycle);
          }
          await this.creditSeatStacks(tournament);
          this.assertLifecycleCurrent(lifecycle);
          stacksMayBeDeferred = false;
        }
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Spin reveal broadcast - ${revealMultiplier}x, holding the deal until ${new Date(holdUntil).toISOString()} (${Math.max(0, holdUntil - Date.now())}ms from now, ${this.spinRevealLagMs}ms behind the third payment)`
        );
      }

      /**
       * COMPLETE IS THE ONLY RUNNING TRANSITION.
       *
       * Every durable launch step above has finished while the receipt still
       * owns a REGISTERING tournament. Completion atomically verifies that
       * exact receipt, writes its advertised start, and flips RUNNING. A
       * missing or malformed receipt is a hard stand-down: the local engines
       * exist only as inert objects at this point and no card can be dealt.
       */
      const launchSetupProven = await this.proveTournamentLaunchSetup(
        lifecycle,
        tournament,
        requiredField,
        expectedLaunchPlayerIds,
        startedAtIso,
        stacksMayBeDeferred
      );
      this.assertLifecycleCurrent(lifecycle);
      if (!launchSetupProven) {
        this.running = false;
        return;
      }
      const launchCompleted = await this.completeTournamentLaunch(
        lifecycle,
        launchId,
        startedAtIso
      );
      this.assertLifecycleCurrent(lifecycle);
      if (!launchCompleted) {
        this.running = false;
        return;
      }

      tournament.status = 'RUNNING';
      tournament.started_at = startedAtIso;

      // LIVE E2E FIX 2026-08-15: tournamentCache was captured while status was
      // still REGISTERING and never refreshed after this transition — so
      // ensureLateRegSeated's `status !== 'RUNNING'` guard made the former
      // seat self-heal a permanent no-op for every tournament started (not
      // resumed) by this process. Live evidence: 3 RUNNING tournaments frozen
      // for hours with 'playing' players holding chips but no active seat.
      if (this.tournamentCache) {
        this.tournamentCache.status = 'RUNNING';
        this.tournamentCache.started_at = startedAtIso;
      }

      /**
       * ═══════════════════════════════════════════════════════════════════════
       *  THE STRUCTURE IS NOT REWRITTEN AT START ANY MORE (2026-08-29)
       * ═══════════════════════════════════════════════════════════════════════
       *
       * What used to be here: if the configured percentages did not sum to
       * 100, it normalised them and PERMANENTLY OVERWROTE
       * `tournaments.payout_structure` with the result. Three things were
       * wrong with that, and the fourth is that it is no longer needed at all.
       *
       *   1. IT TRUNCATED IN BINARY FLOATS.
       *      `Math.trunc((p.percentage / totalPct) * 100 * 100) / 100` -- the
       *      same class of arithmetic that had the engine and the database
       *      disagreeing by a cent, except this one wrote its lossy answer
       *      back to the column every other payout site then reads.
       *
       *   2. IT DUMPED THE REMAINDER ON `payouts[0]`.
       *      That is the first ARRAY element, not place 1 -- a structure
       *      stored out of order landed the remainder on an arbitrary place.
       *      And on a well-ordered structure it landed on the HEADLINE prize,
       *      which is the exact opposite of the payout law: the adjustment
       *      goes on the smallest prize, never a first-place figure a player
       *      has been reading in the lobby all week.
       *
       *   3. THE WRITE ERROR WAS DISCARDED.
       *      On failure the in-memory cache held the normalised structure
       *      while the database column held the original, so
       *      recalculateEliminatedPrizes priced against one and
       *      eliminatePlayer/finishTournament (which re-read the row) priced
       *      against the other. A fifth independent structure, created by a
       *      failure nobody logged.
       *
       *   4. IT IS REDUNDANT. `computePlacePrize` divides by the structure's
       *      OWN total in integer basis points, so a structure summing to 95
       *      or 105 is already spread proportionally and exactly, by every
       *      payout site at once -- engine, client and SQL. Normalising the
       *      stored column buys nothing and costs the three problems above.
       *
       * The operator's configured structure is now left exactly as they wrote
       * it. A structure that does not sum to 100 is still worth saying out
       * loud, so the warning stays.
       */
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
              `[Tournament:${this.tournamentId.slice(0, 8)}] payout percentages sum to ${totalPct}% (expected 100%). Every payout site normalises by the structure's own total, so the places still sum to the pool exactly - the structure itself is left as configured.`
            );
          }
        }
      }

      // Start table engines
      this.assertLifecycleCurrent(lifecycle);
      for (const [tableId, engine] of this.tableEngines) {
        this.admitManagedTableEngine(tableId, engine);
        this.startManagedTableEngine(engine, 'TournamentthistournamentIdslic.Table_engine_error');
      }
      await this.drainTableEngineStartJobs();
      this.assertLifecycleCurrent(lifecycle);

      /**
       * Start blind timer — AT THE ADVERTISED START, not at seating.
       *
       * `startBlindTimer` clamps its override to at most one level's duration,
       * so the lead cannot be expressed as "level 1 plus a minute". It is
       * expressed as what it is: the clock is armed when the cards are, which
       * is the same instant `holdDealingUntil` releases the felt above. Arming
       * it here would hand level 1 to the pre-seat minute and every level after
       * it would run a minute out of step with the structure the lobby printed.
       *
       * Guarded on `this.running` because a stand-down between here and then
       * (see the start() stand-down paths) must not arm a clock on a tournament
       * that is no longer being managed by this process.
       */
      if (this.preStartLeadMs > 0) {
        const structure = tournament.blind_structure || [];
        this.setLifecycleTimeout(() => {
          this.startBlindTimer(structure);
        }, this.preStartLeadMs);
      } else {
        this.startBlindTimer(tournament.blind_structure || []);
      }

      // Start elimination checker
      this.startEliminationChecker();
      await this.reconcileTournamentEntryWindow('engine.start');
      this.assertLifecycleCurrent(lifecycle);
      if (this.addOnPeriodTriggered && !this.prizePoolFinalized) {
        // triggerAddOnPeriod can open before scheduler registration. Upgrade
        // the initial safety work to urgent so a large resume/start fleet
        // cannot consume the whole offer window before its first retry.
        this.requestEliminationSweep();
      }

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] RUNNING - ${this.tableEngines.size} tables`
      );
    } catch (err) {
      if (
        err instanceof TournamentLifecycleAbortedError ||
        !this.lifecycleEpoch.isCurrent(lifecycle)
      ) {
        return;
      }
      reportError(err, 'TournamentthistournamentIdslic.Start_failed');
      this.running = false;
      this.unregisterEliminationScheduler();
    }
  }

  async resume(): Promise<void> {
    if (this.teardownPromise) await this.teardownPromise;
    if (!this.tournamentLeaseAuthorityIsCurrent()) {
      this.expireTournamentLeaseAuthority();
      return;
    }
    if (this.lifecycleOperation) return this.lifecycleOperation;
    this.stopFenceApplied = false;
    this.shutdownDrainFenceApplied = false;
    const lifecycle = this.lifecycleEpoch.begin();
    this.running = true;
    this.armTournamentLeaseExpiryTimer();
    const operation = this.resumeLifecycle(lifecycle);
    this.lifecycleOperation = operation;
    try {
      await operation;
    } finally {
      if (this.lifecycleOperation === operation) this.lifecycleOperation = null;
    }
  }

  private async resumeLifecycle(lifecycle: TournamentLifecycleToken): Promise<void> {
    console.log(`[Tournament:${this.tournamentId.slice(0, 8)}] Resuming...`);

    try {
      const { data: tournament } = await supabase
        .from('tournaments')
        .select('*')
        .eq('id', this.tournamentId)
        .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
      this.assertLifecycleCurrent(lifecycle);

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
      this.tournamentEntryWindowClosed = this.prizePoolFinalized;
      this.tournamentEntryCloseAnnounced = false;
      this.tournamentEntryRepricePending = false;
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
      this.assertLifecycleCurrent(lifecycle);

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
        this.assertLifecycleCurrent(lifecycle);

        if ((liveEntrants || 0) > 0) {
          console.warn(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Resuming with NO open tables - rebuilding for ${liveEntrants} entrant(s) instead of abandoning the tournament`
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
           * resume() proceeds, so bounded scheduler passes get their chance to
           * seat the field and finish the event.
           */
          try {
            await this.createTablesAndSeatPlayers(tournament);
            this.assertLifecycleCurrent(lifecycle);
            // Table construction never starts a dealer implicitly. The resume
            // rebuild path has no start() launch loop, so explicitly launch
            // every recovered engine before this generation is admitted.
            for (const [tableId, engine] of this.tableEngines) {
              if (engine.isRunning()) continue;
              this.admitManagedTableEngine(tableId, engine);
              this.startManagedTableEngine(
                engine,
                'TournamentthistournamentIdslic.Resume_rebuilt_table_error'
              );
            }
          } catch (rebuildErr) {
            if (rebuildErr instanceof TournamentLifecycleAbortedError) throw rebuildErr;
            reportError(rebuildErr, 'Tournament.resume_table_rebuild_failed');
          }
        }
      } else {
        for (const table of tables) {
          const engine = this.createManagedTableEngine(table.id);
          engine.setHub(tableStateHub); // Phase 1.1 PR-2
          this.wireEliminationWake(engine);
          this.tableEngines.set(table.id, engine);
          this.admitManagedTableEngine(table.id, engine);
          this.startManagedTableEngine(engine, 'TournamentthistournamentIdslic.Resume_table_error');
        }
        // Re-apply a button that was DRAWN but never dealt. Awaited before the
        // first hand can plausibly land, and a no-op for every table that has
        // already played one.
        await this.restoreDrawnFirstButtons(
          tables as Array<{ id: string; first_button_seat?: number | null }>
        );
        this.assertLifecycleCurrent(lifecycle);
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
      this.assertLifecycleCurrent(lifecycle);

      // A resumed manager is not admitted until every table start it launched
      // (including rebuild/adoption starts) has reached a settled state.
      await this.drainTableEngineStartJobs();
      this.assertLifecycleCurrent(lifecycle);

      // Restore blind level
      this.currentLevel = tournament.current_level || 0;
      // Reset hand-for-hand state on resume so it can be triggered again
      this.handForHandActive = false;
      this.handForHandAnnounced = false;
      // TOURNEY-AUDIT 2026-07-24: restore add-on/finalization flags so a
      // restart mid-add-on doesn't re-broadcast ADDON_PERIOD_START or skip
      // finalizeAfterAddOn forever (they previously reset to defaults).
      this.addOnPeriodTriggered = !!tournament.addon_period_triggered;
      if (this.addOnPeriodTriggered && !this.prizePoolFinalized) {
        this.scheduleAddOnPeriodEnd(tournament.addon_period_ends_at);
      }
      // Initialize broadcast channel on resume
      this.broadcastChannel = null;
      this.broadcastReady = false;
      // TOURNEY-AUDIT 2026-07-24: resume the level clock MID-LEVEL using the
      // persisted level_started_at instead of granting a fresh full level on
      // every restart (which nearly froze blind escalation across restarts).
      {
        /**
         * THROUGH resolveBlindLevel, NOT AN INDEX (2026-08-31, Phase 2.3).
         *
         * This was the one caller that ignored resolveBlindLevel's own closing
         * instruction ("callers must read levels through THIS function rather
         * than indexing the array"). Past the end of a persisted structure --
         * which every deep Spin and every long duel reaches, the ladders are
         * 10-12 rows -- the index is undefined and this fell back to level 0,
         * so a restarted late-stage game timed its level off the FIRST row of
         * the ladder. Engine restarts are frequent (auto-deploy on server/**),
         * and the resumed clock is what decides when the next escalation
         * lands.
         */
        const levelData =
          this.resolveBlindLevel(tournament.blind_structure || [], this.currentLevel) ||
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
      await this.reconcileTournamentEntryWindow('engine.resume');
      this.assertLifecycleCurrent(lifecycle);
      if (this.addOnPeriodTriggered && !this.prizePoolFinalized) {
        // The persisted window may have less than a minute left. Do not leave
        // its first retry behind the full initial safety queue.
        this.requestEliminationSweep();
      }
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
            `[Tournament:${this.tournamentId.slice(0, 8)}] Resumed DURING a break - re-pausing for the remaining ${Math.round(remainingMs / 1000)}s`
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
          const rebreakTimer = this.setLifecycleTimeout(() => {
            return this.resumeFromBreak();
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
          this.assertLifecycleCurrent(lifecycle);
        }
      }

      /* Rebuild the add-on's two non-money timers only after table engines and
         any overlapping synchronized break have been restored. Both phases
         come from the persisted window, so a deploy cannot move the break or
         grant another entitlement. A pool finalized just before the old
         process died receives a bounded, detached tail replay: no funding RPC
         is reachable from it and resume itself never waits. */
      if (this.addOnPeriodTriggered) {
        const addOnStartedMs = Date.parse(String(tournament.addon_period_started_at ?? ''));
        const addOnEndsMs = Date.parse(String(tournament.addon_period_ends_at ?? ''));
        const validAddOnDeadline =
          Number.isFinite(addOnStartedMs) &&
          Number.isFinite(addOnEndsMs) &&
          addOnEndsMs > addOnStartedMs;
        if (
          !this.prizePoolFinalized &&
          tournament.add_on_available === true &&
          validAddOnDeadline
        ) {
          this.scheduleAddOnBreak(tournament.addon_period_ends_at);
        } else if (this.prizePoolFinalized && validAddOnDeadline) {
          const durablePool =
            tournament.prize_pool === null || tournament.prize_pool === undefined
              ? Number.NaN
              : Number(tournament.prize_pool);
          if (Number.isFinite(durablePool) && durablePool >= 0) {
            this.scheduleFinalizedAddOnTailReplay(durablePool);
          } else {
            reportError(
              new Error(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Restart found a finalized add-on without a readable durable prize_pool`
              ),
              'TournamentManagerBase.addon_final_tail_resume_pool_unreadable'
            );
          }
        }
      }

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Resumed - ${this.tableEngines.size} tables, level ${this.currentLevel}`
      );
    } catch (err) {
      if (
        err instanceof TournamentLifecycleAbortedError ||
        !this.lifecycleEpoch.isCurrent(lifecycle)
      ) {
        return;
      }
      reportError(err, 'TournamentthistournamentIdslic.Resume_failed');
      this.running = false;
      this.unregisterEliminationScheduler();
    }
  }

  private applyManagerMutationFence(clearLeaseExpiry: boolean): Promise<void> | null {
    const lifecycleOperation = this.lifecycleOperation;
    // The synchronous half is the ownership fence. No asynchronous boundary
    // may occur before the generation is invalidated and every delayed
    // callback is cancelled.
    this.running = false;
    this.lifecycleEpoch.abort();
    if (clearLeaseExpiry) this.clearTournamentLeaseExpiryTimer();
    this.clearManagedTableEngineRecoveries();
    this.clearLifecycleTimers();
    if (this.blindTimer) {
      this.clearLifecycleTimeout(this.blindTimer);
      this.blindTimer = null;
    }
    this.unregisterEliminationScheduler();
    for (const timer of [
      this.addOnPeriodEndTimer,
      this.addOnResumeBroadcastRetryTimer,
      this.addOnBreakStartTimer,
      this.addOnBreakEndTimer,
      this.addOnFinalTailReplayTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    this.addOnPeriodEndTimer = null;
    this.addOnResumeBroadcastRetryTimer = null;
    this.addOnBreakStartTimer = null;
    this.addOnBreakEndTimer = null;
    this.addOnFinalTailReplayTimer = null;
    this.addOnPeriodOpening = false;
    this.addOnPeriodFinalizing = false;
    this.addOnBreakActive = false;
    this.addOnBreakEndsAtMs = 0;
    this.addOnBreakOwnsLevelClock = false;
    this.addOnBreakOwnsPause = false;
    this.addOnResumeBroadcastRetryAttempts = 0;
    this.addOnFinalTailReplayAttempts = 0;
    // Cleanup hand-for-hand sync
    this.stopHandForHandSync();
    if (this.handForHandRePauseTimer) {
      this.clearLifecycleTimeout(this.handForHandRePauseTimer);
      this.handForHandRePauseTimer = null;
    }
    return lifecycleOperation;
  }

  /**
   * Revoke manager callbacks without revoking the exact tournament authority
   * still needed by hands already in progress. GameServer keeps heartbeating
   * this generation and its child engines until all tables park between hands.
   */
  beginServerShutdownDrain(): void {
    if (this.teardownPromise || this.stopFenceApplied || this.shutdownDrainFenceApplied) return;
    this.shutdownDrainFenceApplied = true;
    this.applyManagerMutationFence(false);
  }

  /** Final shutdown fence, applied only after the between-hands drain. */
  fenceForServerShutdown(): void {
    if (this.teardownPromise) return;
    this.applyStopFence();
  }

  private applyStopFence(): Promise<void> | null {
    const lifecycleOperation = this.lifecycleOperation;
    if (this.stopFenceApplied) return lifecycleOperation;
    this.stopFenceApplied = true;
    return this.applyManagerMutationFence(true);
  }

  stop(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;

    const lifecycleOperation = this.applyStopFence();
    const teardown = (async () => {
      // Initiate every current engine stop before awaiting lifecycle startup.
      // A start may be waiting indefinitely for players (or still loading its
      // first row); stop synchronously settles ready=false and releases that
      // wait. Awaiting lifecycleOperation first formed a dependency cycle in
      // which neither side could ever complete.
      const enginesAtFence = [...this.tableEngines.values()];
      // Observe rejections NOW, before any scheduler/startup drain can wait.
      // A table may reject quickly after a failed settlement. Delaying this
      // attachment until after the drains raised a process-wide unhandled
      // rejection even though the manager later inspected that same failure.
      const initialEngineStops = Promise.allSettled(enginesAtFence.map((engine) => engine.stop()));

      // Unregister aborts the scheduler signal synchronously. Keep this manager
      // quarantined until the physical promise actually unwinds; otherwise a
      // replacement can mutate the same tournament while an old Supabase await
      // is still returning. Finishing code initiates stop without awaiting it
      // when it is itself inside this set, avoiding a self-deadlock.
      await this.drainEliminationSchedulerJobs();

      // The engine-ready edge above lets an in-flight start/resume observe the
      // aborted token and unwind. No late engine can survive the final snapshot
      // below: every lifecycle-owned continuation is drained first.
      if (lifecycleOperation) await lifecycleOperation.catch(() => undefined);

      // Timer callbacks and recovery operations already in flight are part of
      // this generation too. Drain them to a fixed point, then stop the final
      // engine snapshot (which also covers a candidate created before a stale
      // continuation observed the abort).
      await this.drainLifecycleJobs();
      this.clearLifecycleTimers();

      const engines = [...this.tableEngines.entries()];
      const stopResults = await Promise.allSettled(engines.map(([, engine]) => engine.stop()));
      await initialEngineStops;
      await this.drainTableEngineRunJobs();
      const stopFailures: unknown[] = [];
      for (let i = 0; i < engines.length; i++) {
        const [tableId, engine] = engines[i];
        const result = stopResults[i];
        if (result.status === 'rejected') {
          if (!engine.hasReleasedProcessOwnership()) {
            stopFailures.push(result.reason);
            continue;
          }
          reportError(result.reason, 'Tournament.table_engine_stop_cleanup_failed', { tableId });
        }

        // Release both registries only for the exact engine that completed
        // teardown. GameServer performs its own identity CAS, so a successor
        // registered while this await was pending survives untouched.
        this.gameServer.unregisterTournamentTableEngine(tableId, engine);
        if (this.tableEngines.get(tableId) === engine) this.tableEngines.delete(tableId);
      }
      if (stopFailures.length > 0) {
        throw new AggregateError(
          stopFailures,
          `Tournament ${this.tournamentId} failed to stop ${stopFailures.length} table engine(s)`
        );
      }

      if (this.broadcastChannel) {
        const channel = this.broadcastChannel;
        this.broadcastChannel = null;
        this.broadcastReady = false;
        try {
          await Promise.resolve(channel.unsubscribe());
        } catch {
          /* a failed channel release cannot resurrect a stopped manager */
        }
      }
    })();
    const trackedTeardown = teardown.finally(() => {
      if (this.teardownPromise === trackedTeardown) this.teardownPromise = null;
    });
    this.teardownPromise = trackedTeardown;
    return trackedTeardown;
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
    /**
     * ═══════════════════════════════════════════════════════════════════════
     *  A CREDIT MAY FUND AN EMPTY SEAT. IT MAY NOT RESCUE A LOSING ONE.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * `stack < target` is the right question BEFORE a hand is dealt and the
     * wrong one after it. Every seat that is losing is below the starting
     * stack by definition, so once play is under way this raised the loser
     * back to a full stack and MINTED the difference onto the felt.
     *
     * Measured on production 2026-08-31, spins completed in 24 hours:
     *
     *     2,168 games at a 300 stack   418 drifted, worst +470
     *       305 games at a 1,000 stack  84 drifted, worst +1,603
     *
     * and NOT ONE of the 502 exceeded twice the starting stack - exactly the
     * ceiling of topping up the two players who can be behind. That is the
     * signature of this line and nothing else.
     *
     * A Spin's prize is buy_in x multiplier, so no money is created directly.
     * What is created is a different WINNER: the engine decides the game on
     * chips, and a player who was busting got their stack back. On an MTT,
     * where finishing position is the payout, it moves real money.
     *
     * All four callers are pre-deal by intent - start(), the post-reveal beat,
     * its safety net, and resume(), whose own note scopes it to "a process
     * restart INSIDE THAT WINDOW". None of them checked, and resume() runs on
     * every restart forever, which is why this fired on one game in five.
     *
     * So the question is now asked against the state of the game:
     *   - no hand dealt yet  -> fund anything short of the target, unchanged;
     *   - play under way     -> fund ONLY a seat still sitting on zero, which
     *                           is the stranded reservation the resume path
     *                           exists for. A losing stack is left alone.
     *
     * If the hand read itself fails, take the conservative branch and say so.
     * The stranded-at-zero case is still rescued either way; the only thing
     * given up is raising a placeholder tier, which the next call redoes.
     *
     * ═══════════════════════════════════════════════════════════════════════
     *  AND A SEAT AT ZERO DURING PLAY IS A BUST, NOT A RESERVATION
     *  (chip-std Lane F, 2026-09-02)
     * ═══════════════════════════════════════════════════════════════════════
     *
     * The "fund ONLY a seat still sitting on zero" branch above was the next
     * mint. Every one of the 23 games sampled from the two alerts after
     * #2333 broke its chip total across a restart gap, and the two shapes
     * that survived were: a busted seat (0, elimination not yet finalised
     * when SIGTERM arrived) revived at `starting_chips` on resume
     * (`0573b719`, +1000; `40be4b3b`, `d1bbea54`, +300 each), and a game
     * whose hand_history rows had not landed before the restart, which this
     * probe read as "no hand dealt yet" and topped every short seat up
     * (`3a2fee36`: a seat holding 620 on a 300 board, +320).
     *
     * The decision now lives in `selectSeatsToFund` (seatStackCredit.ts),
     * where those games are the fixtures. Play under way means a hand was
     * recorded OR any seat holds more than the target - chips are conserved,
     * so a seat above the target is proof of play that no lost history row
     * can hide. Once play is under way nothing is funded. Before play, the
     * credit is also capped by the tournament's chip supply.
     */
    const { data: dealtRows, error: dealtErr } = await supabase
      .from('hand_history')
      .select('id')
      .eq('tournament_id', this.tournamentId)
      .limit(1);

    if (dealtErr) {
      reportError(
        new Error(`seat stack credit could not tell whether play had started: ${dealtErr.message}`),
        'Tournament.' + this.tournamentId.slice(0, 8) + '.seat_stack_dealt_probe_failed'
      );
    }

    const handRecorded = dealtErr ? true : (dealtRows?.length ?? 0) > 0;

    // The chip supply: what the roster says was ever issued. A failed read
    // means "no ceiling" rather than "no credit" - the reveal beat must still
    // be able to fund a healthy reservation on a flaky read, and the decision
    // above already refuses everything once play is under way.
    let chipSupply: number | null = null;
    const { data: roster, error: rosterErr } = await supabase
      .from('tournament_players')
      .select('rebuys, add_on')
      .eq('tournament_id', this.tournamentId);
    if (rosterErr) {
      reportError(
        new Error(
          `seat stack credit could not read the roster for a supply ceiling: ${rosterErr.message}`
        ),
        'Tournament.' + this.tournamentId.slice(0, 8) + '.seat_stack_supply_read_failed'
      );
    } else {
      const rows = (roster ?? []) as Array<{ rebuys: number | null; add_on: boolean | null }>;
      chipSupply = tournamentChipSupply({
        entrants: rows.length,
        startingChips: target,
        rebuyCount: rows.reduce((n, r) => n + Math.max(0, Number(r.rebuys) || 0), 0),
        addonCount: rows.filter((r) => r.add_on === true).length,
        rebuyChips: tournament?.rebuy_chips,
        addonChips: tournament?.addon_chips,
        bonusChips: 0,
      });
    }

    const decision = selectSeatsToFund({
      seats: (seatRows ?? []).map((r: any) => ({ id: String(r.id), stack: Number(r.stack) })),
      target,
      handRecorded,
      chipSupply,
    });

    if (decision.refused) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] seat stack credit REFUSED: the felt holds ` +
            `${decision.refused.feltTotal} and the tournament issued ${decision.refused.chipSupply}; ` +
            `raising short seats to ${target} would mint chips, so nothing was written`
        ),
        'Tournament.seat_stack_credit_exceeds_supply'
      );
      return 0;
    }

    // Strictly RAISE, never lower: the legitimate case is a reservation seat
    // holding 0 (or a smaller placeholder tier) waiting on the drawn stack.
    // An early-bird seat (starting chips + bonus, 2026-08-22) sits ABOVE the
    // plain starting stack, and flattening it here would destroy the bonus.
    const stale = decision.fund;
    if (stale.length === 0) return 0;
    const { error } = await supabase.from('table_seats').update({ stack: target }).in('id', stale);
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
    /* THE LEAD-IN IS COUNTED ONCE (2026-08-31 audit).
       This read `this.spinRevealAt + spinRevealToDealMs()`, and
       spinRevealToDealMs() ALREADY contains LEAD_IN_MS by way of
       spinRevealTotalMs - whose own doc calls itself "total wall time from
       the last buy-in". So the lead-in was added twice and the deal was held
       one full LEAD_IN_MS (1s) longer than the sequence it is waiting for.
       Harmless in direction - it never dealt early - but it is a second of
       dead air on every spin, and the drift meant the spec and the engine
       disagreed about what the hold means.
       The whole sequence is measured from the ANCHOR, because the lead-in is
       its first beat: anchor -> lead-in -> countdown -> spin -> flash -> hold
       -> post-reveal beats -> deal. The other two sites below are already
       correct: they set revealAt = now, so `now + spinRevealToDealMs()` is
       the same measurement taken from their own anchor. */
    this.spinHoldUntil = anchor + spinRevealToDealMs();
  }

  /**
   * The reveal instant and the hold deadline the broadcast actually uses.
   *
   * Normally these are the values stamped at the paid gate, so the wheel runs
   * its full sequence measured from the third payment. Two escape hatches:
   *
   *   - NO ANCHOR (a freeroll Spin, whose paid gate never runs because there is
   *     nothing to pay): fall back to the old behaviour, `Date.now()`.
   *   - THE WORK OVERRAN: the stamp is in the past by more than the lead-in,
   *     so honouring it would hand the client a sequence that has already
   *     partly run. The reveal is re-stamped from now, and the overrun is
   *     REPORTED.
   *
   * ─── WHY THE THRESHOLD IS NOT "A COUNTDOWN'S WORTH" (round 16) ────────────
   *
   * Dan, live 2026-08-30: "IT DID SPIN ABOUT 20 SECONDS LATER, NEVER FINISH
   * AND 'ANNOUNCE THE AMOUNT'."
   *
   * The old test was `spinHoldUntil - now < COUNTDOWN_MS` — re-anchor only
   * once fewer than 3 of the 14.8 seconds remained. Everything between those
   * two numbers was shipped to the client as a PARTIALLY ELAPSED reveal, and
   * the client honours it exactly as told:
   *
   *     const elapsed = Math.max(0, Date.now() - data.revealAtMs);
   *     const at = (offsetMs) => Math.max(0, offsetMs - elapsed);
   *
   * so every beat already behind `elapsed` fires at once. A start 10s late
   * put `revealAt` ~9s in the past: the countdown, the chase and the flash
   * all collapsed into the same instant and the player saw a blur and a
   * result card — a wheel that "spun" and never announced. It was worst
   * exactly when it mattered most, because a late start is the case a player
   * is already annoyed about.
   *
   * ANIMATION LAW (CLAUDE.md 10.6, binding): "Every animation and its sound
   * plays every time it is owed, FOR ITS FULL DURATION." A wheel shortened
   * because the SERVER was slow is the law's plainest violation — the player
   * is charged for the engine's lateness in the one moment the format sells.
   *
   * So the rule is now the honest one: if the hold cannot still cover the
   * WHOLE sequence, re-anchor to now. The catch-up arithmetic on the client
   * stays exactly as it is, and keeps doing the job it was written for — a
   * player who refreshes mid-spin rejoins the shared moment already in
   * progress. What it no longer has to absorb is the engine's own delay.
   */
  /**
   * Process-wide overrun aggregator. STATIC on purpose: the overrun is a
   * property of the ENGINE being late, not of any one tournament, so a
   * per-instance limiter would report once per spin exactly as before.
   */
  private static readonly spinOverruns = new SpinOverrunReporter();

  protected resolveSpinReveal(): { revealAt: number; holdUntil: number } {
    const now = Date.now();
    if (this.spinRevealAt <= 0) {
      this.spinRevealAt = now;
      this.spinHoldUntil = now + spinRevealToDealMs();
      this.spinRevealLagMs = 0;
      return { revealAt: this.spinRevealAt, holdUntil: this.spinHoldUntil };
    }
    this.spinRevealLagMs = spinRevealLag({ now, revealAt: this.spinRevealAt });
    /* ONCE IT IS PUBLIC, IT DOES NOT MOVE (round 18). The early emit puts
       these exact numbers on three screens; re-anchoring afterwards would
       leave the second broadcast disagreeing with the wheels already turning,
       which is the precise desynchronisation the anchor exists to prevent. */
    if (this.spinRevealEmitted) {
      return { revealAt: this.spinRevealAt, holdUntil: this.spinHoldUntil };
    }
    /* HAS THE WHEEL'S OWN START ALREADY PASSED? That is the only question,
       because the client skips exactly the beats behind `Date.now() -
       revealAt` and nothing else. Asked through spinRevealWindow rather than
       inline: this used to be `this.spinHoldUntil - now < spinRevealToDealMs()`,
       which meant the same thing only while the hold was stamped from
       `spinRevealAt`. When the double-counted lead-in was removed on
       2026-08-31 the hold became `anchor + toDeal` and the comparison
       collapsed to `anchor < now` — true for every spin ever run, so the
       anchor was discarded every time and the overrun was reported ~1,500
       times a day. See spinRevealWindow.ts for the full account. */
    const wouldSkipABeat = spinRevealWouldSkipABeat({ now, revealAt: this.spinRevealAt });
    if (wouldSkipABeat) {
      /* AGGREGATED, NOT SILENCED (2026-08-31). This fired once per spin, on
         88-97% of ~2,500 spins a day, which is over a thousand identical
         reports daily out of one call site - loud enough to bury every other
         error in the stream. The per-spin number now lives at full
         resolution on poker_spin_reveal_lag_p50_ms and
         poker_spin_reveal_past_lead_in; what survives here is one report per
         incident, opening immediately and then carrying the count. See
         spinOverrunReporter.ts. */
      const overrun = TournamentManagerBase.spinOverruns.record(this.spinRevealLagMs, now);
      if (overrun) {
        reportError(
          new Error(`[Tournament:${this.tournamentId.slice(0, 8)}] ${describeOverrun(overrun)}`),
          'Tournament.spin_reveal_window_overrun'
        );
      }
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
            `[Tournament:${this.tournamentId.slice(0, 8)}] Could not check hand history for table ${table.id.slice(0, 8)} (${error.message}) - leaving the drawn button alone`
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
      const timer = this.setLifecycleTimeout(() => {
        if (!stillLive()) return;
        return fn().catch((err) =>
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
        } catch (err) {
          /* Still never fatal - a lost beat must not stop a game. But it is
             REPORTED now (2026-09-02). This was a bare `catch { }`, so when
             beat 1 failed the player's chips simply appeared in the next state
             diff with no cue and no trace, which is the exact outcome the
             comment above says this scheduling exists to prevent. An animation
             that silently does not play is a bug by the animation law (10.6);
             one that silently does not play AND leaves no evidence cannot even
             be found. */
          reportError(err, 'Tournament.' + this.tournamentId.slice(0, 8) + '.spin_chips_emit');
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
          void this.trackLifecycleJob(
            Promise.resolve(
              supabase.from('tables').update({ first_button_seat: seat }).eq('id', tableId)
            )
              .then(({ error }: { error: { message?: string } | null }) => {
                if (error) {
                  console.warn(
                    `[Tournament:${this.tournamentId.slice(0, 8)}] Drawn button seat ${seat} not persisted for table ${tableId.slice(0, 8)} (${error.message}) - a restart before the first hand would revert it to the lowest seat`
                  );
                }
              })
              .catch((err: unknown) => {
                // Detached from the reveal beat, but owned by its lifecycle.
                console.warn(
                  `[Tournament:${this.tournamentId.slice(0, 8)}] Drawn button persist threw: ${(err as Error)?.message ?? err}`
                );
              })
          );
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
    const { data: players, error: playersErr } = await supabase
      .from('tournament_players')
      .select('user_id, chips')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'playing');

    if (playersErr) throw new Error(`Tournament roster read failed: ${playersErr.message}`);
    if (!players || players.length === 0) throw new Error('No players');

    // What this tournament ALREADY has.
    // max_players is read too: an ADOPTED table keeps the capacity it was
    // built with, which need not match the maxPerTable computed below (the
    // config may have changed, or the deck clamp may have lowered it). The
    // seating loop honours each table's own ceiling — see the capacity note
    // there.
    const { data: existingTables, error: existingTablesErr } = await supabase
      .from('tables')
      .select('id, max_players')
      .eq('tournament_id', this.tournamentId)
      .in('status', ['running', 'waiting'])
      .order('created_at', { ascending: true });
    if (existingTablesErr) {
      throw new Error(`Tournament table inventory read failed: ${existingTablesErr.message}`);
    }

    const { data: liveSeatRows, error: liveSeatRowsErr } = await supabase
      .from('table_seats')
      .select('user_id, table_id, seat_number, tables!inner(tournament_id)')
      .is('left_at', null)
      .eq('tables.tournament_id', this.tournamentId);
    if (liveSeatRowsErr) {
      throw new Error(`Tournament live-seat inventory read failed: ${liveSeatRowsErr.message}`);
    }

    const alreadySeated = new Set((liveSeatRows ?? []).map((r: any) => r.user_id));
    const occupiedSeats = new Map<string, Set<number>>();
    for (const r of liveSeatRows ?? []) {
      const row = r as any;
      if (!occupiedSeats.has(row.table_id)) occupiedSeats.set(row.table_id, new Set());
      occupiedSeats.get(row.table_id)!.add(row.seat_number);
    }

    for (const t of existingTables ?? []) {
      if (this.tableEngines.has(t.id)) continue;
      const engine = this.createManagedTableEngine(t.id);
      engine.setHub(tableStateHub);
      this.wireEliminationWake(engine);
      this.tableEngines.set(t.id, engine);
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
     * Tournament tables took table_size verbatim, and table_size knows nothing
     * about how many hole cards the game deals.
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
     *
     * 2026-08-31: the ceiling used to be `clampSeatsForVariant`, which is the
     * CASH seat law — a house rule that keeps a table small enough to run it
     * twice, not an arithmetic limit. Applying it here made a tournament pay
     * for boards it can never deal (Run It Twice is hard-disabled on tournament
     * tables) and shrank real events: PLO4 8 -> 9, PLO5 7 -> 9, PLO6 6 -> 7,
     * PLO8 8 -> 9, and a table_size 10 NLH MTT lost its tenth seat to
     * DEFAULT_MAX_SEATS. The ceiling is now the deck and only the deck:
     * floor((52 - 5) / holeCards) — nlh/flh 23, short_deck 15, pineapple 15,
     * plo4/plo8/flo8 11, plo5 9, plo6 7. The cash cap is untouched.
     */
    const seatVariant = (tournament.game_type || '').toLowerCase();
    const deckSafe = Math.min(maxPerTable, maxSeatsTheDeckAllows(seatVariant));
    if (deckSafe !== maxPerTable) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] ${seatVariant || 'nlh'} seats ${maxPerTable} -> ${deckSafe} (the deck seats ${maxSeatsTheDeckAllows(seatVariant)} at this variant)`
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
     * different door, because the deck ceiling clamps `max_players` and this
     * loop then walked straight past it.
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
      /**
       * THE LEVEL THIS TABLE IS BEING BORN INTO, NOT LEVEL ONE (2026-09-01).
       *
       * This loop runs whenever a tournament needs MORE tables than it has --
       * late registration, a rebalance -- which by definition happens after
       * the clock has started. It stamped `stakes` from blindStructure[0]
       * regardless, so a table created at level 8 advertised the level 1
       * blinds for the rest of its life. 197 tables across 60 tournaments in
       * the last three days were created after their tournament started, and
       * every one of them carries level 1.
       *
       * `stakes` is a display string (the lobby reads it; the engine takes its
       * blinds from the tournament level, never from this row), and the lobby
       * shows buy-in rather than stakes on a tournament row -- so this is a
       * lie that is currently hard to see rather than one anybody has
       * complained about. It is still a lie, and it is the last place in this
       * file that reached into the structure by index instead of asking
       * resolveBlindLevel, which is the closing hazard Phase 2.3 went through
       * the rest of the file to remove.
       */
      const firstLevel = this.resolveBlindLevel(blindStructure, this.currentLevel) ||
        blindStructure[0] || { smallBlind: 10, bigBlind: 20 };

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
        throw new Error(
          `Tournament table ${i + 1} was not created: ${error?.message || 'insert returned no row'}`
        );
      }

      const engine = this.createManagedTableEngine(table.id);
      engine.setHub(tableStateHub); // Phase 1.1 PR-2
      this.wireEliminationWake(engine);
      this.tableEngines.set(table.id, engine);
    }

    // Round-robin seat ONLY the players who are not already sitting somewhere
    // in this tournament. Re-seating a seated player is what produced the
    // duplicate-seat rows described above.
    const tableIds = [...this.tableEngines.keys()];
    const toSeat = players.filter((p: any) => !alreadySeated.has(p.user_id));
    if (toSeat.length < players.length) {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] ${players.length - toSeat.length} player(s) already seated - seating the remaining ${toSeat.length}`
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
       * write. A player who has acquired a seat since the snapshot is skipped.
       * An unreadable answer aborts this launch attempt; its incomplete receipt
       * makes the next admission retry reconstruct and prove the same setup,
       * while a guess here could create a double stack.
       */
      const claim = await mayTakeSeat(supabase, this.tournamentId, toSeat[i].user_id);
      if (!claim.allowed) {
        if (claim.unknown) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Not seating ${toSeat[i].user_id.slice(0, 8)} - ${claim.reason}. Aborting this launch attempt rather than risking a second live seat.`
            ),
            'Tournament.seat_claim_unreadable'
          );
          throw new Error(
            `Tournament seat claim for ${toSeat[i].user_id} was unreadable: ${claim.reason}`
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
         * this unreachable. A partially built launch remains REGISTERING and
         * its incomplete receipt re-enters this idempotent method; completing
         * now would admit a dealer with a paid player missing from the felt.
         */
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] No seat within capacity for ${toSeat.length - i} player(s) across ${tableIds.length} table(s) - refusing launch completion rather than writing past max_players`
          ),
          'Tournament.seating_capacity_exhausted'
        );
        throw new Error('Tournament launch seating capacity was exhausted');
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
        // Un-burn the seat. If we don't, this seat is permanently unavailable in `occupiedSeats`
        // even though it was never written to the database, which leads to `seating_capacity_exhausted`
        // when we skip too many players.
        taken.delete(seatNumber);

        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Failed to seat ${toSeat[i].user_id.slice(0, 8)}: ${seatErr.message}`
          ),
          'TournamentthistournamentIdslic.Failed_to_seat_playersiuser_id'
        );
        throw new Error(`Tournament seat insert failed: ${seatErr.message}`);
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
        throw new Error(`Tournament roster seat linkage failed: ${rosterErr.message}`);
      }
    }

    // Update player counts
    for (const tableId of tableIds) {
      const { count, error: countErr } = await supabase
        .from('table_seats')
        .select('*', { count: 'exact', head: true })
        .eq('table_id', tableId)
        .is('left_at', null);
      if (countErr || count == null) {
        throw new Error(
          `Tournament table ${tableId} live-seat count failed: ${countErr?.message || 'count unavailable'}`
        );
      }
      const { error: countWriteErr } = await supabase
        .from('tables')
        .update({ current_players: count })
        .eq('id', tableId);
      if (countWriteErr) {
        throw new Error(
          `Tournament table ${tableId} player-count write failed: ${countWriteErr.message}`
        );
      }
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
   * SPIN LEVELS 2026-08-21: level length in ms, format-normalized. Blind
   * structures carry their length as `durationMinutes` (MTT/SNG configs),
   * `duration_minutes` (snake-case writers), or `duration` in SECONDS (the
   * spin spec, mirrored client/server). The timer arms read ONLY
   * `durationMinutes || 10`, so every spin level silently became 10 minutes
   * - observed live: spins started 02:27Z levelled up at exactly +10:00
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
    // an accelerated tournament halves every remaining level - ceil(min/2).
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

    /* SPIN OVERFLOW STAYS ON THE SPIN LADDER (2026-08-30 audit). A spin's
       persisted structure is 12 rows of spinBlindsForLevel's ~1.4x cadence;
       the generic escalation below DOUBLES per level, so a deep 100x that
       outran the 12 rows used to jump from the gentle ladder to 2x every
       level. spinBlindsForLevel is deterministic and continues the same
       cadence indefinitely, so overflow levels are read from it instead -
       identical across restarts for the same reason the generic path is. */
    {
      const t = this.tournamentCache;
      const isSpin =
        String(t?.variant ?? '').toLowerCase() === 'spin' ||
        String(t?.tournament_type ?? '').toUpperCase() === 'SPIN';
      if (isSpin) {
        const b = spinBlindsForLevel(i + 1);
        const lastRow = blindStructure[blindStructure.length - 1] ?? {};
        return {
          ...lastRow,
          level: i + 1,
          smallBlind: b.small,
          bigBlind: b.big,
          ante: 0,
        };
      }
    }

    const lastLevel = blindStructure[lastPlayableIndex(blindStructure)];
    const escalated = escalatedBlindLevel(
      lastLevel,
      i,
      // The PERSISTED length. Nothing mutates this array any more; that is what
      // makes the answer identical across a restart.
      blindStructure.length,
      // Format-normalized, and halved for an accelerated MTT past late reg —
      // engine state, which is why the pure module takes it as an argument.
      this.levelDurationMs(lastLevel) / 60000,
      /**
       * THE LADDER'S OWN CADENCE, NOT A DOUBLING (2026-08-31).
       *
       * This used to double per level, which on production meant 95.7% of MTTs
       * spent their late game on a curve faster than HYPER_TURBO. The ratio is
       * now measured from the structure the tournament was actually advertised
       * with, clamped to [1.15, 1.6] inside observedStepRatio. Derived from the
       * PERSISTED array, so it is the same number after a restart — the
       * anchoring contract in the note above is preserved exactly.
       */
      observedStepRatio(blindStructure.map((l: any) => Number(l?.bigBlind)))
    );

    return this.capLevelToTournamentChips(escalated);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  NO BLIND MAY EXCEED THE CHIPS THAT EXIST (2026-08-31)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Deep ladders make the overflow path rare; this makes its failure mode
   * impossible. Chips are conserved, so the supply is `starting_chips ×
   * entrants` plus whatever rebuys and add-ons added — and a big blind larger
   * than that supply is not a blind, it is a coin flip on the button.
   *
   * `chipsInPlayEstimate` is deliberately an ESTIMATE that errs HIGH: the entry
   * count includes everyone who ever entered and each rebuy/add-on is counted
   * at a full starting stack. Erring high caps less aggressively, which is the
   * safe direction — this guard exists to stop the absurd case (a blind larger
   * than the tournament), not to fine-tune a healthy ladder. An unknown total
   * caps nothing at all.
   */
  protected capLevelToTournamentChips<T extends Record<string, unknown>>(level: T): T {
    const total = this.chipsInPlayEstimate();
    if (total === null) return level;

    const capped = capLevelToChipsInPlay(level as any, total);
    if (!capped.capped) return level;

    if (!this.blindCapReported) {
      this.blindCapReported = true;
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Blind cap engaged - level would have been ` +
          `${Number((level as any).smallBlind)}/${Number((level as any).bigBlind)} against ~${Math.round(total)} chips in play; ` +
          `capped to ${capped.smallBlind}/${capped.bigBlind} so the event keeps at least 20 big blinds on the felt`
      );
    }

    return {
      ...level,
      smallBlind: capped.smallBlind,
      bigBlind: capped.bigBlind,
      ante: capped.ante,
      blindCapped: true,
    } as unknown as T;
  }

  /** Logged once per manager so a long event does not spam the cap message. */
  protected blindCapReported = false;

  /**
   * Total chips the tournament has ever issued, or null when it cannot be
   * known. Never guessed: a null caps nothing.
   */
  protected chipsInPlayEstimate(): number | null {
    const start = Number(this.tournamentCache?.starting_chips);
    if (!Number.isFinite(start) || start <= 0) return null;

    const entrants = Number(this.entrantCountForChipCap);
    if (!Number.isFinite(entrants) || entrants < 1) return null;

    const rebuyChips = Number(this.tournamentCache?.rebuy_chips) || start;
    const addonChips = Number(this.tournamentCache?.addon_chips) || start;
    const rebuys = Number(this.rebuysGrantedForChipCap) || 0;
    const addons = Number(this.addonsGrantedForChipCap) || 0;

    return start * entrants + rebuyChips * rebuys + addonChips * addons;
  }

  /**
   * Entrant count for the chip cap, refreshed by the elimination sweep at most
   * once a minute (`refreshChipCapInputs`).
   *
   * A HIGH-WATER MARK, never a live count. `tournaments.current_players` drains
   * as players bust — it read 2 on a 115-entrant event at the finish — and a
   * draining entrant count would shrink the chip supply the cap is measured
   * against, tightening the cap as the tournament progresses and throttling the
   * blinds exactly when they should be climbing. Same defect shape the payout
   * structure documents for its own field size: never a live seat count.
   */
  protected entrantCountForChipCap = 0;
  protected rebuysGrantedForChipCap = 0;
  protected addonsGrantedForChipCap = 0;

  protected startBlindTimer(blindStructure: any[], remainingOverrideMs?: number): void {
    if (blindStructure.length === 0) return;
    // Never leave two level clocks running for the same tournament. Callers
    // normally arrive with blindTimer already null (it has just fired, or
    // pauseForBreak cleared it), but a double-arm doubles the escalation rate
    // for the rest of the tournament and is invisible until the blinds run
    // away, so it is worth one clearTimeout to make it impossible.
    if (this.blindTimer) {
      this.clearLifecycleTimeout(this.blindTimer);
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
    this.blindTimer = this.setLifecycleTimeout(() => {
      // Without the catch, a throw inside advanceBlindLevel becomes an
      // unhandled rejection AND the level silently fails to advance with no
      // trace of why.
      return this.advanceBlindLevel(blindStructure).catch((err: unknown) => {
        console.warn(
          `[Tournament:${this.tournamentId.slice(0, 8)}] advanceBlindLevel threw: ${(err as Error)?.message ?? err}`
        );
      });
    }, armMs);
    // Persist the level clock (wall-clock start of THIS level's remaining
    // window) so a restart resumes the level mid-flight. Detached from the
    // caller, but still drained by this exact lifecycle before replacement.
    void this.trackLifecycleJob(
      Promise.resolve(
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
        })
    );
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
    const lifecycle = this.lifecycleEpoch.current();
    {
      {
        if (!this.lifecycleIsCurrent(lifecycle)) return;

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
        if (this.isOnBreak()) {
          this.savedBlindTimerRemaining = 1000;
          console.log(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Level was due during a break - holding it until play resumes`
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
          if (!this.lifecycleIsCurrent(lifecycle)) return;
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

          /* A SECOND `level_up`, ON A TRANSPORT NOBODY LISTENS TO, DELETED
             2026-09-09.

             A `tableStateHub.emitEvent(tableId, { type: 'level_up', new_level,
             previous_level, small_blind, ... })` stood here, and its comment
             said clients depend on it "to trigger the level-up popup + sound +
             haptic per Bible V8 section 5". They do not, and never did: every
             one of the four client handlers (TablePage, TournamentPage,
             TournamentLobbyPage, RealtimeChannelService) reads the
             TOURNAMENT-TOPIC broadcast a few lines below, which carries
             `level` / `blinds` / `smallBlind` / `bigBlind` / `ante`. Nothing in
             this repo reads `new_level` at all - the only other matches are two
             unrelated XP migrations - so the popup, the sound and the haptic
             this comment claimed to be responsible for were already being
             driven entirely by the broadcast at :6276.

             It also fired BEFORE `tournaments.current_level` was persisted just
             below, so anything that HAD adopted it would have been racing the
             row it describes.

             Deleted rather than repaired: the announcement already reaches every
             client, and a second producer of the same popup on a different
             transport is a duplicate cue waiting to happen, not coverage. */
        }

        const { error: levelErr } = await supabase
          .from('tournaments')
          .update({ current_level: this.currentLevel })
          .eq('id', this.tournamentId);
        if (!this.lifecycleIsCurrent(lifecycle)) return;
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
        //
        // (b) IS FIXED HERE AND NOW, 2026-09-09, EVEN THOUGH THE BLOCK IS DEAD.
        // Leaving the unscoped UPDATE inside a `const X = false` branch is a
        // loaded trap: whoever flips the flag gets the cross-table corruption
        // back in the same commit, and the comment that warned them is the same
        // comment that told them re-enabling was possible. The write-back is
        // table-scoped now (see `seatTableByUser` below), so the flag no longer
        // guards a defect - it guards an unfinished feature.
        //
        // Still outstanding before this may be re-enabled, and (a) is the real
        // one: a genuine denomination-removal schedule (the small blind is NOT
        // a denomination) and a chips-in-play conservation assertion.
        const CHIP_RACE_ENABLED = false;
        const prevLevelData =
          this.resolveBlindLevel(blindStructure, prevLevel) || blindStructure[0];
        const prevSmallBlind = prevLevelData?.smallBlind || level.smallBlind;
        if (CHIP_RACE_ENABLED && level.smallBlind > prevSmallBlind) {
          try {
            // Gather all tournament player stacks across all tables
            const playerStacks = new Map<string, number>();
            /* WHICH TABLE each stack was read from. `playerStacks` is keyed by
               user_id because that is what ChipRaceEngine.executeChipRace takes,
               and the table it came from is exactly the thing the old write-back
               below had thrown away. Kept alongside so the UPDATE can be scoped
               to the seat that was actually raced and to no other. */
            const seatTableByUser = new Map<string, string>();
            for (const tableId of this.tableEngines.keys()) {
              const { data: seats } = await supabase
                .from('table_seats')
                .select('user_id, stack')
                .eq('table_id', tableId)
                .is('left_at', null);
              if (!this.lifecycleIsCurrent(lifecycle)) return;
              for (const seat of seats || []) {
                if (seat.stack > 0) {
                  playerStacks.set(seat.user_id, seat.stack);
                  seatTableByUser.set(seat.user_id, tableId);
                }
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
              // Update table_seats with new stacks after chip race.
              // SCOPED BY TABLE. Without `.eq('table_id', ...)` this matched
              // every live seat that user holds - their cash game, another
              // tournament - and wrote this tournament's raced stack over all
              // of them. A seat we cannot attribute to a table is SKIPPED and
              // reported rather than written unscoped: an unraced stack is a
              // discrepancy, an overwritten one somewhere else is theft.
              for (const [userId, newStack] of playerStacks) {
                const seatTableId = seatTableByUser.get(userId);
                if (!seatTableId) {
                  reportError(
                    new Error(
                      `[Tournament:${this.tournamentId.slice(0, 8)}] chip race produced a stack for ${userId.slice(0, 8)} with no table to write it to; skipped rather than written across every seat they hold`
                    ),
                    'TournamentManagerBase.chip_race_seat_table_unknown'
                  );
                  continue;
                }
                await supabase
                  .from('table_seats')
                  .update({ stack: newStack })
                  .eq('table_id', seatTableId)
                  .eq('user_id', userId)
                  .is('left_at', null);
                if (!this.lifecycleIsCurrent(lifecycle)) return;
              }
              await this.broadcast('chip_race', {
                removedDenomination: prevSmallBlind,
                newSmallestDenomination: level.smallBlind,
                playersAffected: result.players.filter((p) => p.chipsAwarded > 0).length,
              });
              if (!this.lifecycleIsCurrent(lifecycle)) return;
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
        if (!this.lifecycleIsCurrent(lifecycle)) return;

        // Entry closure is one database decision for level and minute windows.
        // On a level event this call observes the current_level write above;
        // on a minutes-only event it simply confirms the still-open window and
        // leaves the one DB-relative lifecycle timer armed.
        await this.reconcileTournamentEntryWindow('engine.level_change');
        if (!this.lifecycleIsCurrent(lifecycle)) return;

        // Schedule the next level (waits the new level's duration, then
        // advances) — unless a break began while this transition was in flight,
        // in which case the clock belongs to resumeFromBreak. Arming a live
        // timer here is what let a level advance during a break; see the guard
        // at the top of this method for the full defect.
        if (this.isOnBreak()) {
          this.savedBlindTimerRemaining = this.levelDurationMs(level);
        } else {
          this.startBlindTimer(blindStructure);
        }
      }
    }
  }

  private addOnBreakDurationMs(): number {
    const configured = Number(
      (this.tournamentCache as { addon_break_minutes?: number } | null)?.addon_break_minutes ?? 1
    );
    const minutes = Math.min(
      10,
      Math.max(1, Number.isFinite(configured) ? Math.floor(configured) : 1)
    );
    return minutes * 60_000;
  }

  /** The persisted window's final segment is its one add-on break. */
  private addOnBreakStartMs(endsAt: string | null | undefined): number {
    const endMs = Date.parse(String(endsAt ?? ''));
    return Number.isFinite(endMs) ? endMs - this.addOnBreakDurationMs() : Number.NaN;
  }

  private armAddOnBreakEnd(endMs: number): void {
    if (this.addOnBreakEndTimer) this.clearLifecycleTimeout(this.addOnBreakEndTimer);
    this.addOnBreakEndTimer = this.setLifecycleTimeout(
      () => {
        this.addOnBreakEndTimer = null;
        return this.finishAddOnBreak().catch((error) =>
          reportError(error, 'TournamentManagerBase.addon_break_finish_failed')
        );
      },
      Math.max(0, endMs - Date.now())
    );
  }

  /**
   * Reconstruct the add-on break from the durable window. No second flag or
   * entitlement is needed: breakStart = persisted end - configured break.
   * Calling this after resume or thaw therefore restores the same phase rather
   * than granting a new one.
   */
  private scheduleAddOnBreak(endsAt: string | null | undefined): void {
    if (this.addOnBreakStartTimer) {
      this.clearLifecycleTimeout(this.addOnBreakStartTimer);
      this.addOnBreakStartTimer = null;
    }
    if (this.addOnBreakEndTimer) {
      this.clearLifecycleTimeout(this.addOnBreakEndTimer);
      this.addOnBreakEndTimer = null;
    }

    const endMs = Date.parse(String(endsAt ?? ''));
    const breakStartMs = this.addOnBreakStartMs(endsAt);
    if (!Number.isFinite(endMs) || !Number.isFinite(breakStartMs) || endMs <= breakStartMs) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Cannot schedule add-on break from deadline ${String(endsAt)}`
        ),
        'TournamentManagerBase.addon_break_deadline_invalid'
      );
      return;
    }

    if (endMs <= Date.now()) {
      if (this.addOnBreakActive) {
        this.dispatchLifecycleCallback(
          () =>
            this.finishAddOnBreak().catch((error) =>
              reportError(error, 'TournamentManagerBase.addon_break_finish_failed')
            ),
          'TournamentManagerBase.addon_break_finish_failed'
        );
      }
      return;
    }
    if (breakStartMs <= Date.now()) {
      this.dispatchLifecycleCallback(
        () =>
          this.beginAddOnBreak(endMs).catch((error) =>
            reportError(error, 'TournamentManagerBase.addon_break_begin_failed')
          ),
        'TournamentManagerBase.addon_break_begin_failed'
      );
      return;
    }

    this.addOnBreakStartTimer = this.setLifecycleTimeout(() => {
      this.addOnBreakStartTimer = null;
      return this.beginAddOnBreak(endMs).catch((error) =>
        reportError(error, 'TournamentManagerBase.addon_break_begin_failed')
      );
    }, breakStartMs - Date.now());
  }

  private async beginAddOnBreak(endMs: number): Promise<void> {
    const lifecycle = this.captureLifecycleToken();
    if (
      !lifecycle ||
      !this.lifecycleIsCurrent(lifecycle) ||
      this.prizePoolFinalized ||
      endMs <= Date.now()
    ) {
      return;
    }
    const maintenanceFrozen = isMaintenanceFrozen();
    this.addOnBreakEndsAtMs = endMs;
    for (const engine of this.tableEngines.values()) engine.holdDealingUntil(endMs);
    if (this.addOnBreakActive) {
      this.armAddOnBreakEnd(endMs);
      return;
    }
    this.addOnBreakActive = true;
    this.addOnBreakOwnsPause = !this.onBreak && !this.handForHandActive;
    this.addOnBreakOwnsLevelClock = !this.onBreak;
    this.armAddOnBreakEnd(endMs);

    if (this.addOnBreakOwnsLevelClock) this.suspendLevelClock();
    if (this.addOnBreakOwnsPause) {
      const remainingMs = Math.max(1_000, endMs - Date.now());
      for (const engine of this.tableEngines.values()) {
        try {
          engine.pauseAfterHand(remainingMs + TournamentManagerBase.LAST_HAND_GRACE_MS, {
            beforeNextHand: true,
          });
        } catch (error) {
          reportError(error, 'TournamentManagerBase.addon_break_pause');
        }
      }
    }

    if (maintenanceFrozen) {
      // Adopt the durable pause while every dealer is already parked, but do
      // not announce or offer money during maintenance. The thaw callback
      // shifts the same deadline and re-enters this method to extend the hold.
      return;
    }

    await this.broadcast('addon_break', {
      breakDurationMinutes: Math.max(1, Math.ceil((endMs - Date.now()) / 60_000)),
      breakEndsAt: new Date(endMs).toISOString(),
    });
    if (!this.lifecycleIsCurrent(lifecycle) || isMaintenanceFrozen()) return;

    // The same boolean entitlement is used at opening and at the break. The
    // query excludes horses who already took it, so this cannot grant a second
    // add-on; it only gives every still-playing horse its promised timing. The
    // field-sized offer remains admitted by the process-wide scheduler.
    this.lastAddOnOfferAt = Date.now() - TournamentManagerBase.ADD_ON_RETRY_MS;
    this.requestEliminationSweep();
    this.scheduleAddOnRetry();
  }

  private async finishAddOnBreak(): Promise<void> {
    if (!this.addOnBreakActive) return;
    if (isMaintenanceFrozen()) {
      // Keep the pause authority until thaw has shifted and re-read the window;
      // otherwise MaintenanceBreak would resume these tables from under it.
      return;
    }

    const ownsPause = this.addOnBreakOwnsPause;
    const ownsLevelClock = this.addOnBreakOwnsLevelClock;
    this.addOnBreakActive = false;
    this.addOnBreakEndsAtMs = 0;
    this.addOnBreakOwnsLevelClock = false;
    this.addOnBreakOwnsPause = false;
    if (this.addOnBreakEndTimer) {
      this.clearLifecycleTimeout(this.addOnBreakEndTimer);
      this.addOnBreakEndTimer = null;
    }
    if (!this.running) return;

    if (ownsPause && !this.onBreak && !this.handForHandActive) {
      for (const engine of this.tableEngines.values()) {
        try {
          engine.resumeDealing();
        } catch (error) {
          reportError(error, 'TournamentManagerBase.addon_break_resume');
        }
      }
    }

    if (ownsLevelClock && !this.onBreak) {
      const blindStructure = this.tournamentCache?.blind_structure || [];
      const remaining = this.savedBlindTimerRemaining;
      this.savedBlindTimerRemaining = 0;
      this.startBlindTimer(blindStructure, remaining > 0 ? remaining : undefined);
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
    if (
      isMaintenanceFrozen() ||
      !this.tournamentCache?.add_on_available ||
      !this.eliminationMutationAllowed()
    ) {
      return;
    }
    try {
      const persistedEndMs = Date.parse(String(this.tournamentCache.addon_period_ends_at ?? ''));
      if (
        this.addOnPeriodTriggered &&
        Number.isFinite(persistedEndMs) &&
        persistedEndMs <= Date.now()
      ) {
        // The exact deadline timer is the normal edge. This scheduler path is
        // its bounded causal recovery when that read/RPC failed or thaw did.
        await this.drivePersistedAddOnDeadline(false);
        return;
      }

      const { data: rows, error: rowsErr } = await supabase
        .from('tournament_players')
        .select('user_id, add_on')
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'playing');
      if (!this.eliminationMutationAllowed()) return;
      if (rowsErr || !rows || rows.length === 0) {
        if (rowsErr) this.requestUrgentEliminationSweepAfter(TournamentManagerBase.ADD_ON_RETRY_MS);
        return;
      }

      const withoutAddOn = rows
        .filter((r: { add_on?: boolean | null }) => !r.add_on)
        .map((r: { user_id: string }) => r.user_id);
      if (withoutAddOn.length === 0) return;

      const { data: tableRows, error: tableRowsErr } = await supabase
        .from('tables')
        .select('id')
        .eq('tournament_id', this.tournamentId)
        .in('status', ['waiting', 'running', 'RUNNING', 'active']);
      if (!this.eliminationMutationAllowed()) return;
      if (tableRowsErr || !tableRows) {
        reportError(
          tableRowsErr ?? new Error('add-on table snapshot returned no rows'),
          'Tournament.addon_tables_unreadable'
        );
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.ADD_ON_RETRY_MS);
        return;
      }
      const seatRead = await selectInChunks<{ user_id: string }>(
        tableRows.map((row: { id: string }) => row.id),
        (batch) =>
          supabase.from('table_seats').select('user_id').in('table_id', batch).is('left_at', null),
        `Tournament.addOnSeats(${this.tournamentId.slice(0, 8)})`
      );
      if (!this.eliminationMutationAllowed()) return;
      if (!seatRead.complete) {
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.ADD_ON_RETRY_MS);
        return;
      }
      const seated = new Set(seatRead.rows.map((r) => r.user_id));
      const candidates = withoutAddOn.filter((id) => seated.has(id));
      if (candidates.length === 0) return;

      /* CHUNKED, AND AN UNREADABLE FIELD IS NOT AN EMPTY ONE (2026-09-03).
         At the add-on break of a 500-to-1,000 entrant MTT `candidates` is most
         of the field, past the ~675-id ceiling PostgREST accepts in a URL. The
         error was discarded and an empty result returned early - which is what
         "no horses qualify" looks like, so fleet add-ons silently stopped
         happening in exactly the big fields where they matter. This method has
         a deploy-gate pin precisely because it has silently died three times
         before. */
      const horseRead = await selectInChunks<{ id: string }>(
        candidates,
        (batch) => supabase.from('profiles').select('id').in('id', batch).eq('is_horse', true),
        `Tournament.addOnHorses(${this.tournamentId.slice(0, 8)})`
      );
      if (!this.eliminationMutationAllowed()) return;
      if (!horseRead.complete) {
        this.requestUrgentEliminationSweepAfter(TournamentManagerBase.ADD_ON_RETRY_MS);
        return;
      }
      let eligibleHorseRows = horseRead.rows;
      if (this.tournamentCache.addon_from_start === true) {
        const breakStartMs = this.addOnBreakStartMs(this.tournamentCache.addon_period_ends_at);
        if (!Number.isFinite(breakStartMs)) {
          reportError(
            new Error(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Free Buy horse add-ons have no durable break deadline`
            ),
            'Tournament.free_buy_addon_break_unreadable'
          );
          return;
        }
        // Dan's split is WHEN, not WHETHER: the deterministic 35% tranche may
        // buy before the break; every remaining live horse buys once it starts.
        if (Date.now() < breakStartMs) {
          eligibleHorseRows = eligibleHorseRows.filter((horse) =>
            horseAddsOnImmediately(horse.id, this.tournamentId)
          );
        }
      }
      const pendingHorseRows = eligibleHorseRows
        .filter((horse) => !this.addOnAttemptedHorseIds.has(horse.id))
        .sort((a, b) => a.id.localeCompare(b.id));
      const start = Math.min(this.addOnBatchCursor, Math.max(0, pendingHorseRows.length - 1));
      const horseRows = pendingHorseRows.slice(
        start,
        start + TournamentManagerBase.SWEEP_MUTATION_BATCH_SIZE
      );
      if (horseRows.length === 0) return;
      this.addOnBatchCursor =
        start + horseRows.length >= pendingHorseRows.length ? 0 : start + horseRows.length;
      if (pendingHorseRows.length > horseRows.length) this.requestEliminationSweep();

      let taken = 0;
      const declined = new Map<string, number>();
      for (const h of horseRows) {
        if (isMaintenanceFrozen() || !this.eliminationMutationAllowed()) return;
        const { data, error } = await supabase.rpc('process_tournament_rebuy', {
          p_tournament_id: this.tournamentId,
          p_user_id: h.id,
          p_rebuy_type: 'addon',
          // null: let the server price it (add-ons are charged at face value).
          p_cost: null,
          p_chips: null,
          p_current_level: this.currentLevel,
        });
        if (!this.eliminationMutationAllowed()) return;
        if (error) {
          declined.set(error.message, (declined.get(error.message) || 0) + 1);
          // Ambiguous transport failure can follow a committed idempotent
          // purchase. Keep it retryable inside this same offer window; the
          // canonical RPC safely answers already-taken on replay.
          this.requestUrgentEliminationSweepAfter(TournamentManagerBase.UNRESOLVED_BUST_RETRY_MS);
          continue;
        }
        // A clean grant or semantic refusal has made a final decision for this
        // window, so later bounded batches can reach the rest of the field.
        this.addOnAttemptedHorseIds.add(h.id);
        if ((data as { success?: boolean } | null)?.success === true) taken++;
      }

      // Quiet when nothing happened: this is called repeatedly across the
      // window, so an unconditional line would be pure noise.
      if (taken > 0 || declined.size > 0) {
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] ADD-ONS: ${taken} taken` +
            (declined.size > 0
              ? ` - declined: ${[...declined.entries()].map(([m, n]) => `${m} x${n}`).join(', ')}`
              : '')
        );
      }
    } catch (err) {
      reportError(err, 'Tournament.tournament_addon_threw');
    }
  }

  protected async triggerAddOnPeriod(): Promise<void> {
    if (
      isMaintenanceFrozen() ||
      this.addOnPeriodTriggered ||
      this.addOnPeriodOpening ||
      this.prizePoolFinalized
    ) {
      return;
    }
    const lifecycle = this.captureLifecycleToken();
    if (!lifecycle || !this.lifecycleIsCurrent(lifecycle)) return;
    this.addOnPeriodOpening = true;
    let durableWindowProven = false;

    try {
      // TOURNEY-AUDIT 2026-07-24: persist the flag so a restart mid-add-on
      // restores it (resume() reads addon_period_triggered) instead of
      // re-broadcasting ADDON_PERIOD_START and losing finalizeAfterAddOn.
      /* FREE BUY (Dan 2026-09-04): "PLAYERS CAN ADD ON AS SOON AS THEY SIT
         DOWN, AND ALSO AT THE BREAK." Read with "ONE HOUR FOR LATE REG, THEN
         THE ADD ON PERIOD", that is not two windows - it is ONE window that
         opens when the event starts and shuts after the break. Two windows
         would need a second add-on per player, and `tournament_players.add_on`
         is a boolean: one add-on each, taken whenever the player likes inside
         the window.

         A normal event keeps the 60-second window it has always had. */
      const requestedStart = new Date().toISOString();
      const requestedStartMs = Date.parse(requestedStart);
      const fromStart = !!(this.tournamentCache as { addon_from_start?: boolean } | null)
        ?.addon_from_start;
      const lateRegMs =
        (((this.tournamentCache as { late_reg_mins?: number } | null)?.late_reg_mins ??
          60) as number) * 60_000;
      const advertisedStartMs = Date.parse(String(this.tournamentCache?.start_time ?? ''));
      if (fromStart && !Number.isFinite(advertisedStartMs)) {
        throw new Error('Free Buy add-on window has no readable advertised tournament start');
      }
      const requestedEndMs = fromStart
        ? advertisedStartMs + lateRegMs + this.addOnBreakDurationMs()
        : requestedStartMs + 60_000;
      if (!Number.isFinite(requestedEndMs) || requestedEndMs <= requestedStartMs) {
        throw new Error('the requested add-on window does not end after it starts');
      }
      const requestedEnd = new Date(requestedEndMs).toISOString();
      const projection =
        'addon_period_triggered, addon_period_started_at, addon_period_ends_at, add_on_available, prize_pool_finalized, status';

      /* The in-memory latch is deliberately still false. Two database facts
         must be proven first: this exact row accepted the bounded window, and
         a fresh read sees it. The false->true match also makes a lost response
         replayable without extending an already-open offer. */
      const { data: opened, error: openError } = await supabase
        .from('tournaments')
        .update({
          addon_period_triggered: true,
          addon_period_started_at: requestedStart,
          addon_period_ends_at: requestedEnd,
        })
        .eq('id', this.tournamentId)
        .eq('addon_period_triggered', false)
        .eq('prize_pool_finalized', false)
        .eq('add_on_available', true)
        .in('status', ['REGISTERING', 'RUNNING'])
        .select(projection)
        .maybeSingle();
      // Always read after the write attempt. A timeout can mean "the database
      // committed but the response was lost"; throwing here would leave the
      // in-memory latch false even though the durable window is already open.
      const { data: proven, error: proofError } = await supabase
        .from('tournaments')
        .select(projection)
        .eq('id', this.tournamentId)
        .maybeSingle();
      if (!this.lifecycleIsCurrent(lifecycle)) return;
      if (proofError || !proven) {
        throw new Error(
          `could not prove the persisted add-on window: ${proofError?.message ?? 'row not found'}` +
            (openError ? `; write response was also lost: ${openError.message}` : '')
        );
      }

      const startedAt = String(proven.addon_period_started_at ?? '');
      const endsAt = String(proven.addon_period_ends_at ?? '');
      const startMs = Date.parse(startedAt);
      const endMs = Date.parse(endsAt);
      if (
        proven.addon_period_triggered !== true ||
        proven.add_on_available !== true ||
        proven.prize_pool_finalized === true ||
        !['REGISTERING', 'RUNNING'].includes(String(proven.status)) ||
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        endMs <= startMs ||
        (opened &&
          (Date.parse(String(opened.addon_period_started_at ?? '')) !== startMs ||
            Date.parse(String(opened.addon_period_ends_at ?? '')) !== endMs))
      ) {
        throw new Error('the persisted add-on window failed its exact read-back proof');
      }

      /* A transport error does not tell us whether the UPDATE committed. If
         the fresh row contains the exact timestamps this process proposed,
         this process still owns the one-shot effects. A real compare-and-set
         loser sees a different persisted window and adopts only its timer. */
      const openedByThisProcess =
        !!opened || (!!openError && startMs === requestedStartMs && endMs === requestedEndMs);

      this.addOnPeriodTriggered = true;
      durableWindowProven = true;
      this.addOnAttemptedHorseIds.clear();
      this.addOnBatchCursor = 0;
      if (this.tournamentCache) {
        this.tournamentCache.addon_period_started_at = startedAt;
        this.tournamentCache.addon_period_ends_at = endsAt;
      }

      // Schedule the durable close before any notification or table-side
      // effect. A Realtime failure must not strand an open offer forever.
      this.scheduleAddOnPeriodEnd(endsAt);
      this.scheduleAddOnBreak(endsAt);

      // A freeze that began while the CAS/read-back was in flight owns every
      // operational effect. The committed window is safe and thaw will adopt
      // its shifted deadline; do not announce or offer against the frozen one.
      if (isMaintenanceFrozen()) return;

      const addonCost =
        this.tournamentCache?.addon_cost || this.tournamentCache?.buy_in_amount || 0;
      const addonChips =
        this.tournamentCache?.addon_chips || this.tournamentCache?.starting_chips || 0;
      const rebuyLevelCap =
        this.tournamentCache?.late_reg_levels ?? this.tournamentCache?.rebuy_levels ?? 8;
      const durationSeconds = Math.max(0, Math.ceil((endMs - Date.now()) / 1000));

      // A delayed/lost write response can be recovered after the short window
      // has already elapsed. Adopt its durable state and let the zero-delay
      // close run; do not announce or offer an expired add-on.
      if (durationSeconds <= 0) return;

      // Only the process whose compare-and-set returned the changed row, or
      // whose lost response is proven by its exact proposed timestamps, owns
      // the one-shot announcement and table pause. A true concurrent loser
      // adopts the persisted window and close timer without duplicating them.
      if (!openedByThisProcess) return;

      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] ADD-ON PERIOD START - ${durationSeconds} seconds remaining after level ${rebuyLevelCap}, cost: ${addonCost}, chips: ${addonChips}`
      );

      // The client receives the exact persisted offer, price and chip grant.
      // There is no rake on the purchase.
      try {
        await this.broadcast('ADDON_PERIOD_START', {
          message: 'The Add-On Period Has Begun',
          addOnCost: addonCost,
          addOnChips: addonChips,
          addOnFee: 0,
          durationSeconds,
          endsAt,
        });
      } catch (err) {
        // The offer exists independently of Realtime. Keep driving the
        // database-backed add-on path and its close timer.
        reportError(err, 'TournamentManagerBase.addon_period_broadcast');
      }
      if (!this.lifecycleIsCurrent(lifecycle) || isMaintenanceFrozen()) return;

      // Offer the add-on through the process-wide bounded scheduler. A large
      // field must never become an ungoverned loop on the engine event loop.
      this.lastAddOnOfferAt = Date.now() - TournamentManagerBase.ADD_ON_RETRY_MS;
      this.requestEliminationSweep();
      this.scheduleAddOnRetry();
    } catch (err) {
      /* Keep the latch false on any unproven write/read. A later level or hand
         edge can retry; if the write actually committed but its response was
         lost, the read-back branch adopts that existing window without moving
         its end time. */
      if (!durableWindowProven) this.addOnPeriodTriggered = false;
      reportError(err, 'Tournament.addon_period_open_failed');
    } finally {
      this.addOnPeriodOpening = false;
    }
  }

  /** Close the offer at its exact persisted end time. The persisted clock can
   * be the normal minute or the longer Free Buy window, and makes a restart resume the same
   * clock instead of granting a new window or leaving it open for a level. */
  protected scheduleAddOnPeriodEnd(endsAt: string | null | undefined): void {
    const parsed = Date.parse(String(endsAt || ''));
    if (!Number.isFinite(parsed)) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Cannot schedule an add-on close without a valid persisted deadline`
        ),
        'TournamentManagerBase.addon_period_deadline_invalid'
      );
      return;
    }
    this.armAddOnPeriodEndCheck(Math.max(0, parsed - Date.now()));
  }

  private armAddOnPeriodEndCheck(delayMs: number): void {
    if (this.addOnPeriodEndTimer) this.clearLifecycleTimeout(this.addOnPeriodEndTimer);
    this.addOnPeriodEndTimer = this.setLifecycleTimeout(
      () => {
        this.addOnPeriodEndTimer = null;
        return this.drivePersistedAddOnDeadline(false).catch((err) =>
          reportError(err, 'TournamentManagerBase.addon_period_finalize')
        );
      },
      Math.max(0, delayMs)
    );
  }

  private scheduleAddOnResumeBroadcastRetry(): void {
    if (
      !this.running ||
      this.prizePoolFinalized ||
      this.addOnResumeBroadcastRetryTimer ||
      this.addOnResumeBroadcastRetryAttempts >= 3
    ) {
      return;
    }
    const attempt = ++this.addOnResumeBroadcastRetryAttempts;
    this.addOnResumeBroadcastRetryTimer = this.setLifecycleTimeout(() => {
      this.addOnResumeBroadcastRetryTimer = null;
      return this.drivePersistedAddOnDeadline(true).catch((error) =>
        reportError(error, 'TournamentManagerBase.addon_period_thaw_retry_failed')
      );
    }, attempt * 1_000);
  }

  /**
   * A restart can land after fn_apply_prize_guarantee committed but before the
   * process repriced and announced END. Replay only that idempotent, non-money
   * tail. It is deliberately detached from resume() and bounded to three local
   * attempts, so table-engine restoration never waits on presentation work.
   */
  private scheduleFinalizedAddOnTailReplay(finalPool: number): void {
    if (
      !this.running ||
      !Number.isFinite(finalPool) ||
      finalPool < 0 ||
      this.addOnFinalTailReplayTimer ||
      this.addOnFinalTailReplayAttempts >= 3
    ) {
      return;
    }

    const attempt = ++this.addOnFinalTailReplayAttempts;
    this.addOnFinalTailReplayTimer = this.setLifecycleTimeout(
      async () => {
        this.addOnFinalTailReplayTimer = null;
        if (!this.running || isMaintenanceFrozen()) return;
        if (this.addOnPeriodFinalizing) {
          this.scheduleFinalizedAddOnTailReplay(finalPool);
          return;
        }

        this.addOnPeriodFinalizing = true;
        let retry = false;
        try {
          await this.finishAddOnTail(finalPool);
          this.addOnFinalTailReplayAttempts = 0;
        } catch (error) {
          retry = true;
          reportError(error, 'TournamentManagerBase.addon_final_tail_replay_failed');
        } finally {
          this.addOnPeriodFinalizing = false;
        }
        if (retry) this.scheduleFinalizedAddOnTailReplay(finalPool);
      },
      attempt === 1 ? 0 : attempt * 1_000
    );
  }

  /**
   * Finish the non-money work that follows a durably finalized add-on pool.
   *
   * The guarantee RPC can commit and lose its HTTP response. In that case the
   * tournaments row is the receipt, and this tail must be safe to run from the
   * later read-back as well as from the ordinary success response. Repricing
   * writes the same deterministic entitlement, END is a state-setting client
   * event, and clearing an absent timer is harmless, so every step is
   * idempotent.
   */
  private async finishAddOnTail(finalPool: number, alreadyRepriced = false): Promise<void> {
    const lifecycle = this.captureLifecycleToken();
    if (!lifecycle || !this.lifecycleIsCurrent(lifecycle) || isMaintenanceFrozen()) return;
    if (!Number.isFinite(finalPool) || finalPool < 0) {
      throw new Error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] Cannot finish the add-on tail without a proven durable prize pool (${String(finalPool)})`
      );
    }

    // finalFieldSize(), used by the reprice, deliberately opens only after the
    // pool is final. The database flag was proven before this helper is called.
    this.prizePoolFinalized = true;
    if (this.tournamentCache) {
      this.tournamentCache.prize_pool = finalPool;
      this.tournamentCache.prize_pool_finalized = true;
    }

    if (!alreadyRepriced) {
      await this.recalculateEliminatedPrizes(finalPool);
      if (!this.lifecycleIsCurrent(lifecycle) || isMaintenanceFrozen()) return;
    }
    const delivered = await this.broadcast('ADDON_PERIOD_END', {});
    if (!this.lifecycleIsCurrent(lifecycle) || isMaintenanceFrozen()) return;
    await this.finishAddOnBreak();
    if (!this.lifecycleIsCurrent(lifecycle)) return;

    if (this.addOnPeriodEndTimer) {
      this.clearLifecycleTimeout(this.addOnPeriodEndTimer);
      this.addOnPeriodEndTimer = null;
    }
    if (this.addOnResumeBroadcastRetryTimer) {
      this.clearLifecycleTimeout(this.addOnResumeBroadcastRetryTimer);
      this.addOnResumeBroadcastRetryTimer = null;
    }
    if (this.addOnBreakStartTimer) {
      this.clearLifecycleTimeout(this.addOnBreakStartTimer);
      this.addOnBreakStartTimer = null;
    }
    if (this.addOnFinalTailReplayTimer) {
      this.clearLifecycleTimeout(this.addOnFinalTailReplayTimer);
      this.addOnFinalTailReplayTimer = null;
    }
    this.addOnResumeBroadcastRetryAttempts = 0;

    // broadcast() deliberately catches transport failures and reports them as
    // a false receipt so normal game work can continue. END is presentation
    // state that a restart must replay, though: surface the failed receipt
    // only after releasing the break and clearing stale timers, then let the
    // bounded finalized-tail driver try the same idempotent tail again.
    if (!delivered) {
      throw new Error(
        `[Tournament:${this.tournamentId.slice(0, 8)}] ADDON_PERIOD_END was not delivered`
      );
    }
  }

  /**
   * Re-read the deadline before acting on it. fn_thaw_platform moves an open
   * add-on window forward by the maintenance duration, so an in-memory timer
   * armed before :55 is evidence only that it is time to ask the database.
   * It is never authority to close the shifted offer.
   */
  private async drivePersistedAddOnDeadline(rebroadcastAfterThaw: boolean): Promise<void> {
    const lifecycle = this.captureLifecycleToken();
    if (!lifecycle || !this.lifecycleIsCurrent(lifecycle)) return;

    const { data: state, error } = await supabase
      .from('tournaments')
      .select(
        'addon_period_triggered, addon_period_started_at, addon_period_ends_at, add_on_available, prize_pool, prize_pool_finalized, status'
      )
      .eq('id', this.tournamentId)
      .maybeSingle();
    if (!this.lifecycleIsCurrent(lifecycle)) return;
    if (error || !state) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Could not re-read the persisted add-on deadline (${error?.message ?? 'row not found'})`
        ),
        'TournamentManagerBase.addon_period_deadline_read_failed'
      );
      // A transient read failure must not discard the only close edge. Keep
      // the retry inside the process-wide work budget rather than polling one
      // timer per tournament.
      this.requestAddOnDeadlineRetry(5_000);
      // The caller asked us to deliver the shifted thaw deadline. A failed
      // read must retain that intent rather than converting its retry into an
      // ordinary close-only check.
      if (rebroadcastAfterThaw) this.scheduleAddOnResumeBroadcastRetry();
      return;
    }

    if (state.prize_pool_finalized === true) {
      // A successful database transaction can outlive a lost RPC response.
      // Accept only the row's finalized flag plus its readable pool as the
      // receipt, then complete the same idempotent tail as the success path.
      const durablePool =
        state.prize_pool === null || state.prize_pool === undefined
          ? Number.NaN
          : Number(state.prize_pool);
      if (!Number.isFinite(durablePool) || durablePool < 0) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Add-on pool is finalized but its durable prize_pool is unreadable (${String(state.prize_pool)})`
          ),
          'TournamentManagerBase.addon_period_final_pool_unreadable'
        );
        if (rebroadcastAfterThaw) this.scheduleAddOnResumeBroadcastRetry();
        return;
      }
      if (isMaintenanceFrozen()) {
        // The thaw callback runs before MaintenanceBreak clears its in-process
        // gate. Defer this non-window tail to the next event-loop turn; the
        // callback itself still fails closed if the gate has not lifted.
        if (rebroadcastAfterThaw) this.scheduleFinalizedAddOnTailReplay(durablePool);
        return;
      }
      if (this.addOnPeriodFinalizing) return;
      this.addOnPeriodFinalizing = true;
      try {
        await this.finishAddOnTail(durablePool);
        if (!this.lifecycleIsCurrent(lifecycle)) return;
      } catch (tailError) {
        reportError(tailError, 'TournamentManagerBase.addon_period_final_tail_failed');
        this.scheduleFinalizedAddOnTailReplay(durablePool);
      } finally {
        this.addOnPeriodFinalizing = false;
      }
      return;
    }
    if (
      state.addon_period_triggered !== true ||
      state.add_on_available !== true ||
      !['REGISTERING', 'RUNNING'].includes(String(state.status))
    ) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Persisted add-on window is no longer an active tournament contract`
        ),
        'TournamentManagerBase.addon_period_contract_invalid'
      );
      return;
    }

    const endsAt = String(state.addon_period_ends_at ?? '');
    const endMs = Date.parse(endsAt);
    const startMs = Date.parse(String(state.addon_period_started_at ?? ''));
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      reportError(
        new Error(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Persisted add-on window has an invalid start/end pair`
        ),
        'TournamentManagerBase.addon_period_deadline_invalid'
      );
      return;
    }

    this.addOnPeriodTriggered = true;
    if (this.tournamentCache) {
      this.tournamentCache.addon_period_started_at = String(state.addon_period_started_at);
      this.tournamentCache.addon_period_ends_at = endsAt;
    }
    this.scheduleAddOnBreak(endsAt);

    const remainingMs = endMs - Date.now();
    if (remainingMs > 0) {
      this.armAddOnPeriodEndCheck(remainingMs);
      if (rebroadcastAfterThaw) {
        const addOnCost =
          this.tournamentCache?.addon_cost || this.tournamentCache?.buy_in_amount || 0;
        const addOnChips =
          this.tournamentCache?.addon_chips || this.tournamentCache?.starting_chips || 0;
        const delivered = await this.broadcast('ADDON_PERIOD_START', {
          message: 'The Add-On Period Has Resumed',
          addOnCost,
          addOnChips,
          addOnFee: 0,
          durationSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
          endsAt,
          resumedAfterMaintenance: true,
        });
        if (!this.lifecycleIsCurrent(lifecycle)) return;
        if (delivered) {
          if (this.addOnResumeBroadcastRetryTimer) {
            this.clearLifecycleTimeout(this.addOnResumeBroadcastRetryTimer);
            this.addOnResumeBroadcastRetryTimer = null;
          }
          this.addOnResumeBroadcastRetryAttempts = 0;
        } else {
          this.scheduleAddOnResumeBroadcastRetry();
        }
        // MaintenanceBreak clears the freeze immediately after this thaw
        // callback returns. Queue the offer with the shared scheduler now; if
        // it is admitted before that edge, tryTournamentAddOns fails closed
        // and its ordinary bounded retry retains the work.
        this.lastAddOnOfferAt = Date.now() - TournamentManagerBase.ADD_ON_RETRY_MS;
        this.requestEliminationSweep();
        this.scheduleAddOnRetry();
      }
      return;
    }

    // The old timer can fire while the platform is parked, before the thaw
    // transaction has shifted this row. Never close or announce the end from
    // pre-thaw time; ask the same durable record again after the break.
    if (isMaintenanceFrozen()) {
      return;
    }
    await this.finalizeAfterAddOn();
    if (!this.lifecycleIsCurrent(lifecycle)) return;
  }

  /** Called by the platform thaw after fn_thaw_platform commits and before
   * the first table resumes. Active offers re-arm and every subscribed client
   * receives the new absolute deadline instead of counting down the old one. */
  public async resyncAddOnPeriodAfterMaintenanceThaw(): Promise<void> {
    if (!this.running || !this.addOnPeriodTriggered) return;
    await this.drivePersistedAddOnDeadline(true);
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
   * leaves the row un-finalized so a later idempotent guarantee attempt can
   * re-drive it; the tournament keeps playing either way, because tournaments
   * run.
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
        /** 2026-08-29: which bank funded the overlay — 'union' or 'club'. */
        bank_type?: string;
        bank_entity_id?: string;
      };
      if (error || res.ok !== true) {
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Prize guarantee could not be funded (${error?.message ?? res.reason ?? 'unknown'}) - the pool is NOT being bumped locally; no chips are being created`
          ),
          'Tournament.prize_guarantee_unfunded'
        );
        return null;
      }
      const rawPool = res.prize_pool;
      const pool = Number(res.prize_pool);
      if (
        (typeof rawPool !== 'number' && typeof rawPool !== 'string') ||
        (typeof rawPool === 'string' && !/^[0-9]+(?:[.][0-9]+)?$/.test(rawPool)) ||
        !Number.isFinite(pool) ||
        pool < 0 ||
        !Number.isSafeInteger(Math.round(pool * 100)) ||
        Math.round(pool * 100) / 100 !== pool
      ) {
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
        // 2026-08-29: overlays fund from the UNION bank for a union-affiliated
        // club and the club treasury only for a standalone club. The RPC says
        // which bank paid; naming the wrong one in a money log is how the next
        // reconciliation chases a debit in a wallet that never moved.
        const bank =
          res.bank_type === 'union' ? `union bank ${res.bank_entity_id ?? ''}` : 'club treasury';
        console.log(
          `[Tournament:${this.tournamentId.slice(0, 8)}] Guarantee FUNDED via ${source}: overlay ${overlay} debited from the ${bank} (now ${res.treasury_after ?? 'unknown'}), pool ${pool}`
        );
      }
      return pool;
    } catch (err) {
      reportError(err, 'Tournament.prize_guarantee_threw');
      return null;
    }
  }

  protected async finalizeAfterAddOn(): Promise<boolean> {
    const lifecycle = this.captureLifecycleToken();
    if (!lifecycle || !this.lifecycleIsCurrent(lifecycle)) return false;
    if (this.prizePoolFinalized) return true;
    if (this.addOnPeriodFinalizing) return false;
    if (isMaintenanceFrozen()) return false;
    this.addOnPeriodFinalizing = true;

    try {
      console.log(
        `[Tournament:${this.tournamentId.slice(0, 8)}] ADD-ON PERIOD ENDED at level ${this.currentLevel} - finalizing prize pool`
      );

      const { data, error } = await supabase.rpc('fn_close_tournament_addon_period', {
        p_tournament_id: this.tournamentId,
        p_source: 'engine.addon_period_end',
      });
      if (!this.lifecycleIsCurrent(lifecycle)) return false;
      const result = (data ?? {}) as {
        ok?: boolean;
        reason?: string;
        prize_pool?: number | string;
        ends_at?: string;
      };
      if (error || result.ok !== true) {
        this.prizePoolFinalized = false;
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Atomic add-on close refused: ${error?.message ?? result.reason ?? 'unknown'}`
          ),
          'Tournament.addon_period_close_refused'
        );
        // Re-read the same durable window after an ambiguous response. This
        // is a causal continuation of the live offer, never a second money
        // implementation or a periodic reconstruction sweep.
        if (result.reason === 'addon_period_open' && result.ends_at) {
          this.scheduleAddOnPeriodEnd(result.ends_at);
        } else {
          this.requestAddOnDeadlineRetry(5_000);
        }
        return false;
      }

      const finalPool = Number(result.prize_pool);
      if (!Number.isFinite(finalPool)) {
        this.prizePoolFinalized = false;
        reportError(
          new Error(
            `[Tournament:${this.tournamentId.slice(0, 8)}] Atomic add-on close returned no readable prize pool`
          ),
          'Tournament.addon_period_close_unreadable_pool'
        );
        this.requestAddOnDeadlineRetry(5_000);
        return false;
      }
      this.prizePoolFinalized = true;
      if (this.tournamentCache) {
        this.tournamentCache.prize_pool = finalPool;
        this.tournamentCache.prize_pool_finalized = true;
        if (Array.isArray((result as TournamentEntryWindowResult).payout_structure)) {
          this.tournamentCache.payout_structure = (
            result as TournamentEntryWindowResult
          ).payout_structure;
        }
      }
      if (isMaintenanceFrozen()) return false;

      // The add-on RPC wrote the same durable close receipt as the ordinary
      // entry-window close. Re-enter the one receipt consumer so a lost add-on
      // response or a crash during early-finisher top-ups is replayable.
      const repriced = await this.reconcileTournamentEntryWindow('engine.addon_period_reprice');
      if (!this.lifecycleIsCurrent(lifecycle)) return false;
      if (!repriced) {
        this.scheduleFinalizedAddOnTailReplay(finalPool);
        return false;
      }

      await this.finishAddOnTail(finalPool, true);
      if (!this.lifecycleIsCurrent(lifecycle)) return false;
      return true;
    } catch (err) {
      reportError(err, 'TournamentManagerBase.addon_period_finalize_failed');
      const cachedPool = this.tournamentCache?.prize_pool;
      const durablePool =
        cachedPool === null || cachedPool === undefined ? Number.NaN : Number(cachedPool);
      if (this.prizePoolFinalized && Number.isFinite(durablePool) && durablePool >= 0) {
        this.scheduleFinalizedAddOnTailReplay(durablePool);
      } else {
        this.requestAddOnDeadlineRetry(5_000);
      }
      return false;
    } finally {
      this.addOnPeriodFinalizing = false;
    }
  }

  /** Local belt; process-wide admission guarantees no concurrent generation. */
  protected isProcessingEliminations = false;

  // ── Implemented by TournamentManagerEliminations (layer 2/3) ──
  protected abstract startEliminationChecker(): void;
  protected abstract recalculateEliminatedPrizes(finalPrizePool: number): Promise<boolean>;
}
