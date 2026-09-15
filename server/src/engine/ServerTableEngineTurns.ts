/**
 * ServerTableEngine, layer 3/8 — turn timers, time bank, heartbeat, player actions.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { HandController } from './HandController.js';
import {
  isPotLimitVariant,
  isFixedLimitVariant,
  fixedLimitBetSize,
  fixedLimitStreetBounds,
  potLimitBettingPot,
  isFixedLimitCapped,
  substituteOnCappedStreet,
  type BettingStructure,
} from './BettingStructure.js';
import { horseVariantRulesFor } from './VariantRules.js';
import type {
  HandStage,
  ActionType,
  HorseDecision,
  SeatPlayer,
  AuthoritativeActionState,
  AcceptedActionOrigin,
  ActionRecord,
} from '../types.js';

import { HorseLogic, resolveHorseStyle, type HorseGameStateV2 } from './HorseLogic.js';
import { getTournamentBrainContextSnapshot } from '../services/TournamentBrainContext.js';
import {
  buildTournamentMState,
  TOURNAMENT_CONTEXT_INCOMPLETE,
  type TournamentAnteType,
  type TournamentMZone,
} from './HorseTournamentPreflop.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { deadlineScheduler } from './DeadlineScheduler.js';
import { ServerActionValidator } from './ServerActionValidator.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import * as EngineMetrics from '../observability/engineInstruments.js';
import type { ValidationContext } from './ServerActionValidator.js';
import { supabase } from '../services/supabase.js';
import type { HandEvent, SeatedPlayer } from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { ServerTableEngineSeating } from './ServerTableEngineSeating.js';
// Static watchdog thresholds live on the Base class (single source of truth).
import { ServerTableEngineBase } from './ServerTableEngineBase.js';
import { noteFire } from './BrainTelemetry.js';
import {
  createHorseExecutionWitness,
  retireHorseExecutionWitness,
  settleHorseExecutionWitness,
  type HorseExecutionRetirement,
  type HorseAcceptedAction,
} from './HorseExecutionWitness.js';
import {
  buildHorseDecisionKey,
  getLiveHorseDecisionWorker,
  HorseDecisionAbortedError,
  type FastHorseDecisionResult,
  type LiveHorseDecisionSnapshot,
} from './horseDecision/index.js';

/**
 * Why a decision did NOT earn a V44 second look (2026-09-06).
 *
 * Named rather than boolean because the five gates fail for opposite causes
 * and want opposite fixes - see ServerTableEngineTurns.secondLookPlan.
 */
export type SecondLookDecline =
  | 'not_facing_bet'
  | 'small_pot'
  | 'action_shape'
  | 'no_think_time'
  | 'governor';

export type SecondLookPlan =
  | { ok: true; afterMs: number }
  | { ok: false; reason: SecondLookDecline };

type CappedActionState = AuthoritativeActionState & {
  /** Null means this table has no per-hand commitment cap. */
  commitmentCapRemaining: number | null;
};

/**
 * Apply the table's per-hand commitment ceiling to the HandController's legal
 * menu. HandController owns poker rules; the table owns this host-configured
 * ceiling, so this is the only composition step shared by HTTP and horses.
 */
export function applyTableCommitmentCap(
  source: AuthoritativeActionState,
  player: Pick<SeatPlayer, 'stack' | 'bet' | 'totalInvested'>,
  capEnabled: boolean,
  capBB: number,
  bigBlind: number
): CappedActionState {
  const legalActions = [...source.legalActions];
  const capChips = capEnabled && capBB > 0 && bigBlind > 0 ? capBB * bigBlind : 0;
  if (capChips <= 0) {
    return { ...source, legalActions, commitmentCapRemaining: null };
  }

  const cents = (value: number): number => Math.round(value * 100) / 100;
  const capRemaining = cents(Math.max(0, capChips - (Number(player.totalInvested) || 0)));
  let boundedActions = legalActions;
  let minRaiseTo = source.minRaiseTo;
  let maxRaiseTo = source.maxRaiseTo;

  // A cap-bounded wager leaves chips in front of the player; it is never an
  // all-in. The authoritative action path performs the same conversion.
  if (player.stack > capRemaining + 0.005) {
    boundedActions = boundedActions.filter((action) => action !== 'all_in');
  }
  // Forced/dead contributions can leave two players with different whole-hand
  // totals even when their live street bets match. A full call that crosses
  // the caller's cap is not converted into a partial call: that would invent
  // a non-all-in under-call and corrupt action completion/side-pot semantics.
  if (source.toCall > capRemaining + 0.005) {
    boundedActions = boundedActions.filter((action) => action !== 'call');
  }

  const wagerAction = boundedActions.includes('raise')
    ? 'raise'
    : boundedActions.includes('bet')
      ? 'bet'
      : null;
  if (wagerAction) {
    const capTo = wagerAction === 'raise' ? player.bet + capRemaining : capRemaining;
    maxRaiseTo = cents(Math.min(maxRaiseTo ?? capTo, capTo));
    if (minRaiseTo === null || maxRaiseTo < minRaiseTo - 0.005) {
      boundedActions = boundedActions.filter((action) => action !== wagerAction);
      minRaiseTo = null;
      maxRaiseTo = null;
    }
  } else {
    minRaiseTo = null;
    maxRaiseTo = null;
  }

  return {
    ...source,
    legalActions: boundedActions,
    minRaiseTo,
    maxRaiseTo,
    commitmentCapRemaining: capRemaining,
  };
}

/**
 * Compose the host's preflop all-in-or-fold rule into the same immutable menu
 * the worker and Phase 7 evaluate. This only removes actions; in particular it
 * never resurrects an all-in already removed by the commitment cap.
 */
export function applyAllInOrFoldActionState(
  source: CappedActionState,
  enabled: boolean,
  stage: HandStage
): CappedActionState {
  if (!enabled || stage !== 'preflop') return source;
  const allowed = new Set<ActionType>(
    source.toCall > 0.005 ? ['fold', 'all_in'] : ['check', 'all_in']
  );
  return {
    ...source,
    legalActions: source.legalActions.filter((action) => allowed.has(action)),
    minRaiseTo: null,
    maxRaiseTo: null,
  };
}

/**
 * One telemetry key per gate, fired as LITERALS.
 *
 * A lookup table would be tidier and would break the ledger law
 * (HorseDataLedger.test.ts greps the source for each registered receipt's
 * firing site). That law is right: a receipt reachable only through an
 * indirection is a receipt nobody can find from its name, which is how a key
 * outlives the code that fired it. So this is a switch, and every key is one
 * grep from its gate.
 */
export function noteSecondLookDecline(reason: SecondLookDecline): void {
  switch (reason) {
    case 'not_facing_bet':
      noteFire('v44_declined_not_facing_bet');
      return;
    case 'small_pot':
      noteFire('v44_declined_small_pot');
      return;
    case 'action_shape':
      noteFire('v44_declined_action_shape');
      return;
    case 'no_think_time':
      noteFire('v44_declined_no_think_time');
      return;
    case 'governor':
      noteFire('v44_declined_governor');
      return;
  }
}

/** Why a horse turn was abandoned; see poker_horse_turns_abandoned_total. */
type HorseTurnAbandonReason =
  | 'aborted'
  | 'superseded'
  | 'hand_replaced'
  | 'lifecycle_locked'
  | 'seat_moved'
  | 'lease_lost';

/** How far the turn got before the fence refused it. `commit` is the
 *  expensive one: the decision was computed and then dropped. */
type HorseTurnAbandonStage =
  | 'schedule'
  | 'fallback'
  | 'fast_result'
  | 'deep_start'
  | 'deep_result'
  | 'commit';

export abstract class ServerTableEngineTurns extends ServerTableEngineSeating {
  /** Previous zone is table-owned state and is embedded in every worker snapshot. */
  private readonly horseTournamentMZones = new Map<string, TournamentMZone>();

  /**
   * True only after an externally-computed runout payout may have touched the
   * HandController and before that controller has emitted HAND_COMPLETE.
   *
   * The no-seat watchdog normally calls continueRunout as a recovery. That is
   * safe while a runout is only parked, but it would distribute the pot again
   * after Run It Twice has already credited its winners. The runout layer owns
   * this fence; the turn layer reads it because the watchdog is the only
   * lower-layer continuation that can bypass the runout error boundary.
   */
  protected runoutPayoutMutationUnsafe = false;

  /**
   * Dan 2026-08-20: a queued pre-action (auto-check / auto-fold / auto-call)
   * used to fire synchronously at 0ms the instant the turn arrived — the seat
   * never visibly took its turn, and with several players holding pre-actions
   * a whole street resolved instantly and looked like they had been skipped.
   *
   * Shorter than a horse's think time because the player already decided, but
   * never zero: the seat lights up, holds a readable beat, and only then does
   * the action land.
   *
   * Instance field, not a static, so a test can drive pre-action ORDER without
   * spending its real-world seconds.
   *
   * Dan 2026-09-07: still never zero — the reasoning above still holds, a seat
   * that never visibly takes its turn looks skipped — but 900ms was buying far
   * more than "readable". 250ms is a beat: the spotlight lands, the eye
   * registers it, the action follows. Everything above 250 was dead air, and
   * with several pre-actions queued it compounded across a whole street.
   */
  protected preActionVisibleMs = 250;

  // ═══════════════════════════════════════════════════════════════════════════════
  // TURN TIMER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * FAULT INJECTION — deliberately reproduce the freeze this engine's watchdog
   * exists to recover from, so recovery can be PROVEN rather than assumed.
   *
   * Every recovery path shipped on 2026-08-15 was written against a bug report
   * and unit tests. Two of them turned out to be broken in ways only a drill
   * would reveal (the watchdog could not reach its kill tier; Docker never
   * restarts unhealthy containers). Untested recovery is not recovery.
   *
   * This reproduces the precise shape the real defects produced: a seat that is
   * the current actor, with NO clock armed and no pending action. The watchdog
   * should notice within one heartbeat and re-arm the clock (Tier 1).
   *
   * Returns a description of what was broken, for the drill log. Callers are
   * responsible for the safety gate — see handlers/faultInjection.ts, which
   * refuses to run when any human is seated.
   */
  injectTurnStall(): {
    tableId: string;
    seat: number;
    hadClock: boolean;
    hadHorseTimer: boolean;
    handNumber: number;
  } {
    const state = this.handController?.getState();
    const seat = state?.currentPlayerSeat ?? -1;
    const player = state?.players.find((p) => p.seat === seat);
    const hadClock = player ? this.preciseTimer.hasTimer(this.tableId, player.user_id) : false;
    const hadHorseTimer = !!this.horseActionTimer;

    // Provenance travels with the engine state, not the free-form detail. The
    // next watchdog recovery may be a re-arm, forced action or full rebuild;
    // whichever path actually runs must be recorded as a drill.
    this.pendingRecoveryEventClass = 'fault_injection';

    // 1. Kill the clock — this is what every real freeze had in common.
    this.preciseTimer.clearTable(this.tableId);
    // 1b. Suppress the pending horse action too. Removing only the enforcement
    //     clock is NOT a freeze: the horse's think-time timer still fires and
    //     the table carries on, which is exactly what the first drill showed.
    //     A real freeze is "nobody is going to act AND no clock will force it".
    this.cancelHorseDecisionWork();
    // 2. Backdate progress past the stall threshold so the next heartbeat trips
    //    the watchdog immediately rather than after a 45s wait.
    this.lastProgressAtMs = Date.now() - (ServerTableEngineBase.WATCHDOG_STALL_MS + 5_000);
    this.watchdogTrips = 0;

    console.warn(
      `[ServerTableEngine:${this.tableId}] FAULT INJECTED: turn stall at seat ${seat} ` +
        `(clock removed, progress backdated). Watchdog should recover this.`
    );
    return { tableId: this.tableId, seat, hadClock, hadHorseTimer, handNumber: this.handCount };
  }

  /**
   * Cancel every turn deadline this table owns.
   *
   * 2026-08-15: this was an EMPTY FUNCTION with a comment explaining that the
   * work happened elsewhere. Four call sites believed it cancelled timers and
   * none of them did anything:
   *   - ServerTableEngineBase.stop()            (engine teardown)
   *   - ServerTableEngineDealing HAND_COMPLETE  (hand cleanup)
   *   - ServerTableEngineRunout                 ("pause all timers during the
   *                                              insurance/RIT decision window")
   *   - ServerTableEngineTurns handlePlayerAction
   * The runout case is the one that bit: the engine believed it had paused the
   * clock for an insurance offer and had not, so a seat could be auto-folded
   * mid-offer by a timer nobody thought was still armed.
   *
   * preciseTimer.clearTable cancels only the `turn:<playerId>` entries this
   * class owns — it deliberately leaves the heartbeat and the TimeBankEngine's
   * separate `timebank:<playerId>` deadlines alone.
   */
  /** V14: how far into an auto-granted time bank a horse may tank. The bank
   *  grants ~20s per use, so this leaves a wide safety margin against the
   *  bank expiring and auto-folding the hand. */
  /** V44: the second look runs every Monte Carlo read at this multiple. */
  static readonly SECOND_LOOK_DEPTH = 6;
  /** V44: a pot smaller than this, in big blinds, is not worth a second look. */
  static readonly SECOND_LOOK_MIN_POT_BB = 20;
  /** V44: a think time shorter than this cannot fit a second look. */
  static readonly SECOND_LOOK_MIN_THINK_MS = 1500;

  /**
   * V44: whether a decision earns a second look, and when. Pure; exported
   * for tests. A second look is for a CLOSE spot: hero is facing a bet, the
   * pot is worth reading, the fast answer was a call, fold or all-in (the
   * shapes the equity sample decides), there is think time to spend, and
   * the equity governor is not already shedding load.
   */
  static secondLookPlan(
    decision: { action: string; thinkTime: number },
    toCall: number,
    pot: number,
    bigBlind: number,
    thinkTimeMs: number,
    governorScale: number
  ): SecondLookPlan {
    /*
     * ═══ A DECLINE IS AN OBSERVATION (2026-09-06) ═════════════════════════
     *
     * This returned a bare null, and on 2026-09-05 the daily audit reported
     * `v44_second_look fired 0 times against 2,121,841 decides (0.000%,
     * ledger expects >= 0.100%)`. The ledger caught the dead layer, which is
     * what it is for - and then nobody could say WHICH of the five gates was
     * closing, because a null carries no reason.
     *
     * Five gates, and they fail for opposite causes. `governor` means the box
     * is saturated and the answer is capacity. `no_think_time` means the
     * horses are acting too fast for a second look to fit and the answer is
     * the tempo model. `small_pot` or `action_shape` mean the layer is simply
     * rarer than the ledger's 0.1% expectation and the answer is the
     * expectation. Guessing between those is how a layer stays dark for a
     * week; the reason is one string, and it turns tomorrow's audit line into
     * a diagnosis.
     */
    if (toCall <= 0) return { ok: false, reason: 'not_facing_bet' };
    if (pot < ServerTableEngineTurns.SECOND_LOOK_MIN_POT_BB * Math.max(bigBlind, 0.01))
      return { ok: false, reason: 'small_pot' };
    if (decision.action !== 'call' && decision.action !== 'fold' && decision.action !== 'all_in')
      return { ok: false, reason: 'action_shape' };
    if (thinkTimeMs < ServerTableEngineTurns.SECOND_LOOK_MIN_THINK_MS)
      return { ok: false, reason: 'no_think_time' };
    if (governorScale < 1) return { ok: false, reason: 'governor' };
    return { ok: true, afterMs: Math.min(400, Math.floor(thinkTimeMs / 3)) };
  }

  /**
   * V44: what the deep replay is allowed to change. Only a call/fold/all-in
   * that differs from the fast answer; a bet or raise from the replay is a
   * sizing question the sample did not decide, and is ignored.
   */
  static secondLookVerdict(
    fast: { action: string; amount?: number },
    deep: { action: string; amount?: number; policyFallback?: HorseDecision['policyFallback'] }
  ): { action: string; amount?: number } | null {
    if (deep.policyFallback !== undefined) return null;
    if (deep.action !== 'call' && deep.action !== 'fold' && deep.action !== 'all_in') return null;
    if (deep.action === fast.action) return null;
    return { action: deep.action, amount: deep.amount };
  }

  private static readonly HORSE_MAX_BANK_BURN_MS = 9000;

  protected clearTurnTimer(): void {
    this.preciseTimer.clearTable(this.tableId);
    // V13: this function's own doc says "every turn deadline this table owns",
    // and it left the horse's think timer armed. injectTurnStall right above
    // already clears both, for exactly this reason. The exposed caller is the
    // insurance/RIT runout pause: currentPlayerSeat is not necessarily cleared
    // there, so a think timer armed before the pause could fire an action INTO
    // the paused window — the same class of bug this function was written to
    // fix, reintroduced for the other timer.
    this.cancelHorseDecisionWork();
  }

  /**
   * Last-resort clock. Depends on nothing but the seat and the timer, so it
   * still works when the normal turn-change path has thrown partway through.
   */
  protected forceArmTurnTimer(seat: number, seconds: number): void {
    const p = this.seatedPlayers.find((sp) => sp.seat_number === seat);
    if (!p) return;
    this.startTurnTimer(p.user_id, seat, seconds);
  }

  /**
   * TABLE WATCHDOG (Dan 2026-08-15: "the game keeps freezing... this will
   * literally kill any users from joining or playing with us").
   *
   * Before this existed the engine had NO liveness check of any kind — the only
   * signal was `isRunning()`, a boolean that cannot go false when the loop dies.
   * On 2026-08-15 that let ten cash tables (including Dan's own NLH 2/5, hand
   * #1320) sit frozen at preflop for 18+ minutes with funded seats, invisible to
   * discovery.
   *
   * Every freeze this recovers from is a bug somewhere else. The watchdog exists
   * so that such a bug costs ONE HAND rather than a table. It escalates and
   * never touches chips directly:
   *   Tier 1  the seat simply lost its clock         -> give it one back
   *   Tier 2  still stalled                          -> force check-if-free/fold,
   *                                                     which restarts the whole
   *                                                     event cascade
   *   Tier 3  unrecoverable in-process               -> kill the engine so
   *                                                     GameServer rebuilds it
   * Runs on the 10s heartbeat tick.
   */
  protected override runTableWatchdog(): void {
    if (!this.lifecycleCanMutate()) return;
    const idleMs = this.msSinceProgress();

    // A table paused ON PURPOSE (hand-for-hand / FSM 'paused') is healthy no
    // matter how long it has been idle. Killing it here is what used to deal
    // a hand INTO hand-for-hand after the rebuild lost the pause flag. If the
    // pause outlives any plausible coordination window, report it loudly —
    // once per window, never a kill: forcing play during a legitimate pause
    // is a tournament-integrity failure, a long pause is only an incident.
    //
    // 2026-09-11: "paused" means the pause has TAKEN EFFECT (isParkedByDesign).
    // The maintenance break (:53) and the tournament break (:55) raise their
    // flags on tables still playing a hand; standing down for that hand meant a
    // seat that lost its clock in the last-hand window could never be rescued,
    // never parked, and kept the restart certificate shut for the whole break.
    if (this.isParkedByDesign()) {
      const pausedMs = this.msPaused();
      if (
        pausedMs > ServerTableEngineBase.PAUSE_ALARM_MS &&
        Date.now() - this.lastPauseAlarmAtMs > ServerTableEngineBase.PAUSE_ALARM_MS
      ) {
        this.lastPauseAlarmAtMs = Date.now();
        reportError(
          new Error(
            'Table paused-by-design for ' +
              Math.round(pausedMs / 60000) +
              'min - hand-for-hand/break coordinator may have lost the resume signal'
          ),
          'ServerTableEngine.' + this.tableId + '.paused_too_long',
          { handCount: this.handCount }
        );
        this.recordRecoveryEvent(
          'paused_too_long',
          'paused ' + Math.round(pausedMs / 1000) + 's without resume'
        );
      }
      return;
    }

    // Case B: no live hand, but the table is dealable and nothing is starting.
    if (!this.handController) {
      // Mirror dealingLoop's own activePlayers predicate exactly, so the
      // watchdog's idea of "this table should be dealing" cannot disagree
      // with the loop's. A table where everyone is sitting out is idle by
      // design and must not be restarted.
      const dealable = this.seatedPlayers.filter(
        (p) =>
          p.stack > 0 &&
          // Tournament sit-outs are dealt in (blind-off) — the watchdog must
          // agree with the dealing loop or it would restart an "idle" table.
          (this.isTournamentTable() ||
            !this.disconnectEngine.isSittingOut(this.tableId, p.user_id)) &&
          !this.waitingForBB.has(p.user_id)
      ).length;
      if (dealable >= this.minPlayersToDeal() && idleMs > ServerTableEngineBase.WATCHDOG_IDLE_MS) {
        /**
         * ── Dan 2026-08-22: "games randomly break, stop running or freeze" ──
         *
         * This branch used to read "no hand has started for 90s" as "the
         * dealing loop is dead". Those are not the same statement, and the
         * live fleet proved it: 1,603 kills in six hours, EVERY running cash
         * table killed 22-30 times, each after an average of three hands.
         * hand_history shows the shape exactly — normal 8-45s hand spacing,
         * then 107s, 107s, 114s, 87s: two 90s trips plus a rebuild, forever,
         * on fully funded tables with nothing wrong with them.
         *
         * The between-hands path is five Supabase round trips, none of which
         * marked progress. Database slowness is CORRELATED across tables, so
         * one slow minute stalled the whole fleet at once, killed every engine
         * at once, and the rebuild storm then loaded the database harder than
         * the slowness that started it. The watchdog was the engine of the
         * outage it was built to prevent.
         *
         * So ask the loop, not the calendar. `msSinceLoopPhase()` is the time
         * since the loop last MOVED. Wedged in one step is a dead loop and is
         * killed as before, now naming the step it died in. Still cycling is
         * an alive loop: it gets the five-minute horizon and, if it really
         * never deals, a kill under its own name rather than this one.
         */
        const loopWedged = this.msSinceLoopPhase() > ServerTableEngineBase.WATCHDOG_IDLE_MS;
        if (!loopWedged && idleMs <= ServerTableEngineBase.WATCHDOG_LOOP_ALIVE_IDLE_MS) return;

        this.watchdogTrips++;
        reportError(
          new Error(
            'Table idle ' +
              Math.round(idleMs / 1000) +
              's with ' +
              dealable +
              ' dealable seats - dealing loop ' +
              (loopWedged ? 'is wedged at ' : 'is cycling without dealing, at ') +
              this.describeLoopPhase()
          ),
          'ServerTableEngine.' + this.tableId + '.watchdog_loop_dead',
          {
            handCount: this.handCount,
            trips: this.watchdogTrips,
            loopPhase: this.loopPhase,
            loopPhaseMs: this.msSinceLoopPhase(),
          }
        );
        // The phase goes in the kill reason, so `engine_recovery_events.detail`
        // names the cause instead of repeating the symptom. Phase only, never
        // the elapsed seconds — a detail that is unique per row cannot be
        // grouped, and grouping is the entire point of recording it.
        if (this.watchdogTrips >= 2) {
          this.killForRestart(
            (loopWedged ? 'dealing_loop_dead' : 'loop_ticking_no_hands') + ':' + this.loopPhase
          );
        }
      }
      return;
    }

    if (idleMs <= ServerTableEngineBase.WATCHDOG_STALL_MS) return;

    const state = this.handController.getState();
    const seat = state.currentPlayerSeat;

    if (seat < 0) {
      // No actionable seat and no runout continuation fired. Finish the hand
      // rather than wait out the 10-minute safety void.
      this.watchdogTrips++;
      reportError(
        new Error(
          'Hand #' +
            this.handCount +
            ' stalled ' +
            Math.round(idleMs / 1000) +
            's with no current seat'
        ),
        'ServerTableEngine.' + this.tableId + '.watchdog_no_seat'
      );
      if (this.runoutPayoutMutationUnsafe) {
        // An external runout resolver has already started applying its payout.
        // continueRunout would execute the ordinary distribution and can pay
        // the same pot twice. This generation must be recovered from its
        // authoritative hand snapshot instead.
        this.killForRestart('runout_stalled_after_payout_mutation');
        return;
      }
      try {
        (this.handController as any).continueRunout?.();
      } catch {
        /* fall through to the kill tier */
      }
      if (this.watchdogTrips >= 3) this.killForRestart('stalled_no_seat');
      return;
    }

    const p = state.players.find((x) => x.seat === seat);
    if (!p) {
      // currentPlayerSeat points at a seat that is not in the hand state. There
      // is nothing to re-arm and nothing to force — bailing silently here would
      // make the watchdog a no-op forever. Escalate straight to a rebuild.
      this.watchdogTrips++;
      reportError(
        new Error('Watchdog: currentPlayerSeat ' + seat + ' is not present in hand state'),
        'ServerTableEngine.' + this.tableId + '.watchdog_seat_missing'
      );
      if (this.watchdogTrips >= 3) this.killForRestart('current_seat_not_in_state');
      return;
    }
    // PreciseActionTimer keys on user_id (SeatPlayer.user_id in types.ts) — an
    // `id`/`userId` guess would always miss and pin the watchdog at Tier 1.
    const hasClock = this.preciseTimer.hasTimer(this.tableId, p.user_id);
    this.watchdogTrips++;

    reportError(
      new Error(
        'Hand #' +
          this.handCount +
          ' stalled ' +
          Math.round(idleMs / 1000) +
          's at seat ' +
          seat +
          ' (clock=' +
          hasClock +
          ', stage=' +
          state.stage +
          ', trip=' +
          this.watchdogTrips +
          ')'
      ),
      'ServerTableEngine.' + this.tableId + '.watchdog_turn_stalled'
    );

    if (this.watchdogTrips === 1 && !hasClock) {
      this.forceArmTurnTimer(seat, this.tableInfo?.action_time_seconds || 15);
      this.recordRecoveryEvent(
        'watchdog_rearm_clock',
        'seat ' + seat + ' had no clock after ' + Math.round(idleMs / 1000) + 's; re-armed'
      );
      // Handing the seat a clock IS the recovery — restart the stall window so
      // the next heartbeat (10s away) does not force a fold 7s before the 15s
      // clock we just granted would have expired. Deliberately NOT
      // markProgress(): that zeroes watchdogTrips, which would let Tier 1
      // re-arm forever and never escalate.
      this.lastProgressAtMs = Date.now();
      return;
    }

    if (this.watchdogTrips <= 3) {
      // Cancel any orphaned time-bank deadline for this seat first: forcing an
      // action outside handlePlayerAction leaves `timebank:<uid>` armed, and a
      // per-table turn FSM means that orphan can later steal a DIFFERENT seat's
      // time-bank expiry and suppress its auto-fold.
      try {
        this.timeBankEngine.playerActed(this.tableId, p.user_id);
      } catch {
        /* best-effort */
      }
      const toCall = Math.max(0, (state.currentBet || 0) - (p.bet || 0));
      const forced = toCall === 0 ? 'check' : 'fold';
      let applied = false;
      // A watchdog action supersedes every speculative unit owned by the
      // current horse turn. Cancel before performAction because it emits the
      // next TURN_CHANGE synchronously; cancelling afterwards could retire the
      // next seat's freshly scheduled work instead.
      this.cancelHorseDecisionWork();
      try {
        applied = this.handController.performAction(seat, forced as any, undefined, 'forced');
        if (!applied)
          applied = this.handController.performAction(seat, 'fold' as any, undefined, 'forced');
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.watchdog_force_action_failed');
      }
      // CRITICAL: markProgress() also zeroes watchdogTrips. Calling it after a
      // REJECTED force (the exact state a stale currentPlayerSeat produces)
      // reset the escalation ladder every cycle, so Tier 3 — the kill-and-
      // rebuild this whole watchdog exists to reach — was unreachable and the
      // table stayed frozen forever while logging a stall every 45s.
      if (applied) {
        this.recordRecoveryEvent(
          'watchdog_forced_action',
          'forced ' +
            forced +
            ' at seat ' +
            seat +
            ' after ' +
            Math.round(idleMs / 1000) +
            's stall'
        );
        this.markProgress();
      } else {
        reportError(
          new Error('Watchdog forced action REJECTED at seat ' + seat + ' - escalating to rebuild'),
          'ServerTableEngine.' + this.tableId + '.watchdog_force_rejected'
        );
      }
      return;
    }

    this.killForRestart('turn_unrecoverable');
  }

  /**
   * Resolve a seat that MUST stop being on the clock, preferring check over
   * fold (Bible V8 §1.7.4). Returns false only when the engine refuses both.
   *
   * 2026-08-15: HandController.performAction RETURNS FALSE on an illegal
   * action — it does not throw. Every call site that wrapped it in try/catch
   * and trusted the catch was silently doing nothing when the action was
   * rejected, leaving a seat with no clock and no action: a permanent freeze.
   * This helper is the single correct way to force a seat, so the bug cannot
   * be reintroduced one call site at a time.
   */
  protected forceResolveSeat(seat: number, preferCheck: boolean): boolean {
    if (!this.lifecycleCanMutate() || !this.handController) return false;
    // Expiry/disconnect recovery is authoritative and supersedes any pending
    // horse computation or delayed horse action for this turn. This must be
    // before performAction: that call synchronously emits the next turn.
    this.cancelHorseDecisionWork();
    const order: Array<'check' | 'fold'> = preferCheck ? ['check', 'fold'] : ['fold'];
    for (const a of order) {
      try {
        if (this.handController.performAction(seat, a as any, undefined, 'forced')) return true;
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.force_' + a + '_threw');
      }
    }
    return false;
  }

  protected startTurnTimer(
    userId: string,
    seat: number,
    durationSeconds: number,
    clockKind: 'primary' | 'time_bank' = 'primary'
  ): void {
    // Deliberately does NOT call clearTurnTimer(). Now that clearTurnTimer
    // actually cancels every turn deadline on the table, calling it on each
    // re-arm would wipe the deadline this method is about to set — and
    // startTurnTimer is re-entered by the time-bank auto-activation path
    // moments after a timer is armed. PreciseActionTimer.startTimer already
    // cancels any existing deadline for the same (table, player) key, so the
    // re-arm is idempotent without it.
    // NOTE: Do NOT reset timeBankActivatedThisTurn here — this method is also called
    // from activateTimeBank() to extend the timer. The flag is reset in handleTurnChange()
    // when a genuinely new turn begins.
    // Every arm owns its matching turn state, including reconnect and recovery
    // callers that bypass handleTurnChange. Leaving those clocks in `waiting`
    // skipped primary-bank eligibility and made expiry report invalid transitions.
    // A bank re-arm retains bank ownership; a refused expiry's replacement is a
    // primary clock again. This does not reset the per-turn bank allowance.
    const clockState = clockKind === 'time_bank' ? 'time_bank_active' : 'timer_running';
    if (this.turnFSM.state !== clockState) {
      if (this.turnFSM.canTransition(clockState)) this.turnFSM.transition(clockState);
      else this.turnFSM.forceState(clockState);
    }
    this.playerTurnStartTime = Date.now();
    this.playerTurnDuration = Math.max(0, durationSeconds);

    // Bible V8 §2.15: Log timer start
    this.currentHandTimerLog.push({
      playerId: userId,
      event: 'timer_start',
      timestamp: Date.now(),
      durationMs: durationSeconds * 1000,
    });

    // Safety fallback: if no duration, default to 15s to prevent infinite loops
    const safeDurationSeconds = this.playerTurnDuration > 0 ? this.playerTurnDuration : 15;

    // Phase 1.2: Register with PreciseActionTimer — this is now the SOLE timer.
    // The auto-fold/check logic runs as the onExpiry callback via DeadlineScheduler.
    // Bible V8 §6.1: 2-second grace period for network latency is baked into the
    // timer duration so the scheduler fires after the grace window.
    const GRACE_PERIOD_MS = 2000;
    const totalDurationMs = safeDurationSeconds * 1000 + GRACE_PERIOD_MS;

    // ── Law 1.16 `timer_countdown` (roadmap batch 6, 2026-08-21) ─────────
    // Authoritative countdown pulses at fixed thresholds of the DISPLAY
    // deadline (start + duration, no grace - the same deadline the snapshot
    // publishes as turn_deadline_ms), so clients can pin their ticking to
    // the engine's clock instead of deriving it. Idempotent per table via
    // eventId; thresholds beyond this turn's length are explicitly
    // cancelled so a longer previous turn cannot leak a stale pulse. Each
    // callback re-checks the turn identity (start stamp + seat) before
    // emitting, and a stale fire is a silent no-op.
    const displayDeadlineMs = this.playerTurnStartTime + safeDurationSeconds * 1000;
    const countdownStartStamp = this.playerTurnStartTime;
    const COUNTDOWN_THRESHOLDS_MS = [10_000, 5_000, 3_000, 2_000, 1_000];
    for (const thresholdMs of COUNTDOWN_THRESHOLDS_MS) {
      const eventId = `timer_countdown:${thresholdMs}`;
      const fireAtMs = displayDeadlineMs - thresholdMs;
      if (fireAtMs <= Date.now()) {
        deadlineScheduler.cancel(this.tableId, eventId);
        continue;
      }
      deadlineScheduler.schedule({
        tableId: this.tableId,
        eventId,
        deadlineMs: fireAtMs,
        callback: () => {
          if (!this.running || !this.handController) return;
          if (this.playerTurnStartTime !== countdownStartStamp) return; // newer turn owns the clock
          const cdState = this.handController.getState();
          if (cdState.currentPlayerSeat !== seat) return;
          try {
            this.hub?.emitEvent(this.tableId, {
              type: 'timer_countdown',
              table_id: this.tableId,
              player_id: userId,
              seat,
              remaining_ms: Math.max(0, displayDeadlineMs - Date.now()),
              timestamp: Date.now(),
            });
          } catch {
            /* broadcast failure is non-fatal */
          }
        },
      });
    }

    const resolveTurnExpiry = (): void => {
      // === onExpiry callback — fires when DeadlineScheduler tick reaches deadline ===
      if (!this.lifecycleCanMutate() || !this.handController) return;

      const state = this.handController.getState();
      if (state.currentPlayerSeat !== seat) return;
      if (this.armRemainingReconnectProtection(userId)) return;

      // Bible V8 §6.2: Auto-activate time bank when primary timer expires
      // FIX: Guard against race condition where the player already submitted an action
      // and the FSM advanced to 'processing' or 'complete' before this timer callback fired.
      // Only attempt time bank auto-activation if the turn is still in 'timer_running'.
      // timeBankSuppressedThisTurn: the player dropped out of reconnect grace
      // during THIS turn. Falling through to onPrimaryTimerExpired here would
      // auto-activate (and, use-it-or-lose-it, fully spend) a bank they cannot
      // use. Skipping it leaves the ordinary deadline to resolve the seat
      // exactly as it would have anyway.
      if (
        !this.timeBankActivatedThisTurn &&
        !this.timeBankSuppressedThisTurn &&
        this.turnFSM.state === 'timer_running'
      ) {
        const autoActivated = this.timeBankEngine.onPrimaryTimerExpired(
          this.tableId,
          userId,
          () => {
            // Time bank itself expired — auto-fold/check
            // Bible V8 §3.3: Turn FSM — time_bank_active → expired → processing → complete
            // Guard: only transition if we're still in time_bank_active
            // 2026-08-15: turnFSM is PER TABLE, not per seat. An orphaned
            // timebank deadline (left behind by a watchdog force-action, a
            // disconnect auto-action or a reconnect re-arm) could fire while a
            // DIFFERENT seat was legitimately in time_bank_active, consume that
            // seat's FSM transitions and then bail — after which the real
            // seat's own expiry failed this guard and never folded, leaving the
            // pool-sized turn clock as the only enforcement.
            //
            // Seat identity is checked FIRST and is authoritative; the FSM is
            // advisory. A seat that is still the current player when its time
            // bank expires MUST be resolved, whatever the FSM says.
            if (!this.lifecycleCanMutate() || !this.handController) return;
            const tbState = this.handController.getState();
            if (tbState.currentPlayerSeat !== seat) return;
            if (this.armRemainingReconnectProtection(userId)) return;
            if (this.turnFSM.state === 'time_bank_active') {
              this.turnFSM.transition('expired');
              this.turnFSM.transition('processing');
            } else {
              console.warn(
                `[ServerTableEngine:${this.tableId}] Time bank expiry: FSM in '${this.turnFSM.state}' but seat ${seat} is still current - resolving anyway`
              );
            }

            const tbPlayer = tbState.players.find((p) => p.seat === seat);
            const tbToCall = tbPlayer ? Math.max(0, tbState.currentBet - (tbPlayer.bet ?? 0)) : 0;
            const tbCanCheck = tbToCall === 0;

            console.warn(
              `[ServerTableEngine:${this.tableId}] Player ${userId} time bank expired. ` +
                (tbCanCheck ? 'Auto-checking.' : 'Auto-folding.')
            );
            if (this.forceResolveSeat(seat, tbCanCheck)) {
              this.markProgress();
            } else {
              reportError(
                new Error('Time bank auto-action rejected at seat ' + seat + ' - re-arming clock'),
                'ServerTableEngine.' + this.tableId + '.timebank_auto_action_rejected'
              );
              this.forceArmTurnTimer(seat, this.tableInfo?.action_time_seconds || 15);
              return; // The replacement clock is running; no action completed.
            }

            // Bible V8 §3.3: Turn FSM — processing → complete
            this.turnFSM.transition('complete');

            // AUDIT FIX 2026-08-21: the 2026-07-19 fix added strike counting to
            // the PLAIN timer-expiry path only. But an AFK player with time-bank
            // uses left never reaches that path — the bank auto-activates and
            // expiry resolves HERE instead, so consecutiveTimeouts stayed at 0
            // forever and the player burned a full time bank every single hand
            // without ever being sat out (observed live: one player's timers
            // grinding at four stale tables at once). A time-bank expiry is a
            // timeout too — count it toward the auto-sit-out cap.
            this.disconnectEngine.recordConnectedTimeout(this.tableId, userId);
            this.noteHorseTurnTimeout(userId, 'timebank');

            this.engineTelemetry.recordTimerExpired(this.tableId);
            const tbUsesLeft = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
            const unlimitedTimeBanks = this.timeBankEngine.isUnlimited(this.tableId, userId);
            try {
              this.hub?.emitEvent(this.tableId, {
                type: 'time_bank_timeout',
                table_id: this.tableId,
                player_id: userId,
                uses_remaining: tbUsesLeft,
                timed_out_action: tbCanCheck ? 'check' : 'fold',
                show_buy_more: !unlimitedTimeBanks && tbUsesLeft <= 0,
                unlimited_activations: unlimitedTimeBanks,
              });
            } catch {
              /* broadcast failure is non-fatal */
            }
          }
        );

        if (autoActivated) {
          // Bible V8 §3.3: Turn FSM — timer_running → time_bank_active
          // FIX: Double-check FSM state before transitioning — another callback may have
          // advanced it to 'processing' between the outer guard and here (tight race window).
          if (this.turnFSM.state !== 'timer_running') {
            console.warn(
              `[ServerTableEngine:${this.tableId}] Time bank auto-activation skipped - FSM is '${this.turnFSM.state}' (expected timer_running). Turn already resolved.`
            );
            return;
          }
          this.turnFSM.transition('time_bank_active');
          this.timeBankActivatedThisTurn = true;
          // Bible V8 §2.15: Log time bank activation
          this.currentHandTimerLog.push({
            playerId: userId,
            event: 'time_bank_activated',
            timestamp: Date.now(),
            timeBankUsed: true,
          });
          // 2026-08-15: this used getRemainingSeconds() — the whole remaining
          // POOL (max_uses x 15s, i.e. 60s on every production table today, and
          // 1800s on the engine's own default config), not the 15s that
          // TimeBankEngine.activate() just armed. Two consequences: the
          // enforcement deadline (15s) disagreed with the turn timer, and
          // startTurnTimer stamps playerTurnDuration, which is what
          // turn_deadline_ms broadcasts — so the CLIENT was told it had 60
          // seconds and then auto-folded at 15. The manual activateTimeBank
          // path already reads currentUseSeconds correctly; this was the outlier.
          const bank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
          // Bible V8 §6.2: a bank grants 20s. The 15 that used to be the
          // fallback here is the DECISION clock, a different number.
          const grantedSeconds = bank?.currentUseSeconds ?? 20;
          const usesAfterActivation = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
          console.log(
            `[ServerTableEngine:${this.tableId}] Auto-activated time bank for ${userId} (${grantedSeconds}s granted, ${usesAfterActivation} uses left)`
          );
          // Restart turn timer with the granted time bank duration
          this.startTurnTimer(userId, seat, grantedSeconds, 'time_bank');

          // Broadcast time bank activation to other players
          try {
            supabase
              .channel(`table:${this.tableId}`)
              .send({
                type: 'broadcast',
                event: 'time_bank_activated',
                payload: {
                  player_id: userId,
                  table_id: this.tableId,
                  // The seconds actually granted for THIS use, matching the
                  // enforcement deadline. Broadcasting the whole pool told the
                  // client it had far longer than the clock would allow.
                  additional_seconds: grantedSeconds,
                  auto_activated: true,
                  uses_remaining: usesAfterActivation,
                  unlimited_activations: bank?.unlimitedActivations === true,
                },
              })
              .catch(() => {});
          } catch {
            /* broadcast failure is non-fatal */
          }

          // FIX 125 + 2026-04-14 spam fix: warn ONLY at the last 1 remaining
          // and at 0 (the very last one was just used). Was firing at <=5
          // which on a 4-max-uses table means every single use triggered the
          // warning. Tester reported "after every card" spam.
          if (
            bank?.unlimitedActivations !== true &&
            usesAfterActivation >= 0 &&
            usesAfterActivation <= 1
          ) {
            try {
              this.hub?.emitEvent(this.tableId, {
                type: 'time_bank_low',
                table_id: this.tableId,
                player_id: userId,
                uses_remaining: usesAfterActivation,
              });
            } catch {
              /* broadcast failure is non-fatal */
            }
          }

          return; // Time bank activated — don't auto-fold/check yet
        }
      }

      // No time bank available — auto-fold or auto-check
      // Bible V8 §2.15: Log timer expiry
      this.currentHandTimerLog.push({
        playerId: userId,
        event: 'timer_expired',
        timestamp: Date.now(),
      });
      // Bible V8 §3.3: Turn FSM — timer_running → expired → processing
      this.turnFSM.transition('expired');
      this.turnFSM.transition('processing');
      const player = state.players.find((p) => p.seat === seat);
      const amountToCall = player ? Math.max(0, state.currentBet - (player.bet ?? 0)) : 0;
      const canCheck = amountToCall === 0;

      console.warn(
        `[ServerTableEngine:${this.tableId}] Player ${userId} timed out. ` +
          (canCheck ? 'Auto-checking (no bet to call).' : `Auto-folding (${amountToCall} to call).`)
      );
      // By the time this callback runs the PreciseActionTimer entry has already
      // fired and been dropped. If the forced action is REJECTED the seat is
      // left with no clock and no action while the FSM below records it as
      // resolved — a terminal freeze. Re-arm rather than pretend it resolved.
      if (this.forceResolveSeat(seat, canCheck)) {
        this.markProgress();
      } else {
        reportError(
          new Error('Timeout auto-action rejected at seat ' + seat + ' - re-arming clock'),
          'ServerTableEngine.' + this.tableId + '.auto_action_rejected'
        );
        this.forceArmTurnTimer(seat, this.tableInfo?.action_time_seconds || 15);
        return; // Do not complete the new clock or announce an unaccepted action.
      }

      // Bible V8 §3.3: Turn FSM — processing → complete
      this.turnFSM.transition('complete');

      // AUDIT FIX 2026-07-19: count this timeout for a CONNECTED player so an
      // AFK player is auto-sat-out after the cap (was only counted on the
      // disconnect path — an app-open-but-idle player never got sat out).
      this.disconnectEngine.recordConnectedTimeout(this.tableId, userId);
      this.noteHorseTurnTimeout(userId, 'timer');

      this.engineTelemetry.recordTimerExpired(this.tableId);
      const usesLeft = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
      const unlimitedTimeBanks = this.timeBankEngine.isUnlimited(this.tableId, userId);
      try {
        this.hub?.emitEvent(this.tableId, {
          type: 'time_bank_timeout',
          table_id: this.tableId,
          player_id: userId,
          uses_remaining: usesLeft,
          timed_out_action: canCheck ? 'check' : 'fold',
          show_buy_more: !unlimitedTimeBanks && usesLeft <= 0,
          unlimited_activations: unlimitedTimeBanks,
        });
      } catch {
        /* broadcast failure is non-fatal */
      }
    };

    this.preciseTimer.startTimer(this.tableId, userId, totalDurationMs, () => {
      if (!this.timeBankEngine.isUnlimited(this.tableId, userId)) {
        resolveTurnExpiry();
        return;
      }

      // A Lifetime flag can change while a player remains seated. Revalidate
      // the cached unlimited entitlement before manufacturing another bank;
      // the read is bounded and fails closed to the player's real finite pool.
      void this.revalidateUnlimitedTimeBank(userId)
        .then(() => {
          if (this.playerTurnStartTime !== countdownStartStamp) return;
          try {
            resolveTurnExpiry();
          } catch (err) {
            reportError(err, 'ServerTableEngine.' + this.tableId + '.timebank_expiry_resolution');
          }
        })
        .catch((err: unknown) => {
          // A transport or unexpected revalidation failure must not strand the
          // turn behind a cached entitlement. Fail closed to the finite bank and
          // keep the same expiry resolution moving.
          this.timeBankEngine.setUnlimitedActivations(this.tableId, userId, false);
          reportError(err, 'ServerTableEngine.' + this.tableId + '.timebank_revalidation_failed');
          if (this.playerTurnStartTime !== countdownStartStamp) return;
          try {
            resolveTurnExpiry();
          } catch (resolveErr) {
            reportError(
              resolveErr,
              'ServerTableEngine.' + this.tableId + '.timebank_expiry_resolution'
            );
          }
        });
    });
  }

  /**
   * Activate Time Bank triggered by the client HTTP POST to `/timebank`
   * Bible V8 §6.2: Manual activate — delegates to TimeBankEngine (single source of truth)
   */
  public async activateTimeBank(
    userId: string
  ): Promise<{ success: boolean; error?: string; armed?: boolean; message?: string }> {
    // CLAUDE.md §5.7: every one of these strings reaches the player as a toast,
    // so they are Title Case with no em dashes.
    if (!this.lifecycleCanMutate()) {
      return { success: false, error: 'Table Ownership Changed. Please Reconnect.' };
    }
    if (!this.handController || !this.tableInfo) {
      return { success: false, error: 'No Active Hand At This Table' };
    }

    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);

    /* THE DISCARD IS A DECISION, SO IT CAN BUY TIME (2026-08-31).
       Everything below this line is written against `currentPlayerSeat`, and
       the Crazy Pineapple discard round has no turn - every seat decides at
       once - so the press landed on "Not Your Turn", and the one action most
       likely to make a player hesitate was the only one on the table with no
       way to think. Missing it folds the hand outright.

       Routed to the round's own per-seat deadline, which applies the same
       exhaustion rule, the same pool and the same per-street cap as a turn. */
    if (state.stage === 'pineapple_discard') {
      // The discard round has its own deadline path, but it shares the same
      // account entitlement. Revalidate a cached Lifetime flag here as well so
      // a downgrade cannot keep manufacturing banks through the early return.
      if (this.timeBankEngine.isUnlimited(this.tableId, userId)) {
        await this.revalidateUnlimitedTimeBank(userId);
        if (this.handController?.getState().stage !== 'pineapple_discard') {
          return { success: false, error: 'Not In The Discard Round' };
        }
      }
      return this.extendPineappleDiscard(userId);
    }

    if (!player || state.currentPlayerSeat !== player.seat) {
      return { success: false, error: 'Not Your Turn' };
    }

    if (this.timeBankActivatedThisTurn) {
      return { success: false, error: 'Your Time Bank Is Already Running' };
    }

    // Lifetime is not sticky session state. A downgrade or revocation while
    // seated must take effect before another manual activation is granted.
    if (this.timeBankEngine.isUnlimited(this.tableId, userId)) {
      await this.revalidateUnlimitedTimeBank(userId);
      const stateAfterRefresh = this.handController?.getState();
      if (!stateAfterRefresh || stateAfterRefresh.currentPlayerSeat !== player.seat) {
        return { success: false, error: 'Not Your Turn' };
      }
      if (this.timeBankActivatedThisTurn) {
        return { success: false, error: 'Your Time Bank Is Already Running' };
      }
    }

    // Bible V8 §6.2: Check via TimeBankEngine (single source of truth for pool + per-street limits)
    if (!this.timeBankEngine.hasTimeBank(this.tableId, userId)) {
      // VIP time banks 2026-08-17: a diamond top-up purchased mid-session
      // lives only in the DB. Refresh once before rejecting, then re-validate
      // the turn - the await may have raced the action.
      const refreshed = await this.refreshTimeBankFromDb(userId);
      if (!refreshed || !this.timeBankEngine.hasTimeBank(this.tableId, userId)) {
        return { success: false, error: 'No Time Bank Uses Remaining' };
      }
      const stateAfter = this.handController?.getState();
      if (!stateAfter || stateAfter.currentPlayerSeat !== player.seat) {
        return { success: false, error: 'Not Your Turn' };
      }
      if (this.timeBankActivatedThisTurn) {
        return { success: false, error: 'Your Time Bank Is Already Running' };
      }
    }

    // How much ordinary turn clock is still on the board.
    //
    // Dan 2026-08-23, binding: "It should not take a time bank or add more time
    // until you have truly used your entire 15 seconds." So this is no longer
    // an amount to stack the bank on top of — it is the EXHAUSTION TEST. While
    // it is above the epsilon the press costs nothing and grants nothing; it
    // only records the intent, which onPrimaryTimerExpired redeems the instant
    // the clock actually runs out.
    //
    // Captured BEFORE the engine call so the check and the timer armed further
    // down are derived from the same instant.
    const remainingBeforeBank = Math.max(
      0,
      this.playerTurnDuration - (Date.now() - this.playerTurnStartTime) / 1000
    );

    if (remainingBeforeBank > TimeBankEngine.CLOCK_EXHAUSTED_EPSILON_SECONDS) {
      if (!this.timeBankEngine.arm(this.tableId, userId)) {
        return { success: false, error: 'No Time Bank Uses Remaining' };
      }
      console.log(
        `[ServerTableEngine:${this.tableId}] Player ${userId} armed a time bank with ${Math.round(remainingBeforeBank)}s still on the clock. Nothing spent yet.`
      );
      return {
        success: true,
        armed: true,
        message: 'Time Bank Armed. It Starts When Your Clock Runs Out',
      };
    }

    // Activate via TimeBankEngine — it handles pool depletion, the per-street
    // limit, the exhaustion check and event emission.
    const activation = this.timeBankEngine.tryActivate(
      this.tableId,
      userId,
      () => {
        // This callback fires when the manual time bank expires
        if (!this.lifecycleCanMutate() || !this.handController) return;
        const tbState = this.handController.getState();
        if (tbState.currentPlayerSeat !== player.seat) return;
        if (this.armRemainingReconnectProtection(userId)) return;

        const tbPlayer = tbState.players.find((p) => p.seat === player.seat);
        const tbToCall = tbPlayer ? Math.max(0, tbState.currentBet - (tbPlayer.bet ?? 0)) : 0;
        const tbCanCheck = tbToCall === 0;

        this.turnFSM.transition('expired');
        this.turnFSM.transition('processing');
        // performAction returns FALSE on an illegal action - it does not throw
        // (see the doc block on forceResolveSeat). The previous try/catch here
        // therefore never reached its fold fallback: a rejected `check` left the
        // seat with no action, no re-armed clock and no markProgress, hanging
        // the hand until the stall watchdog. forceResolveSeat is the path the
        // AUTO time-bank expiry already uses; this was the last site that had
        // not been migrated to it.
        if (this.forceResolveSeat(player.seat, tbCanCheck)) {
          this.markProgress();
        } else {
          reportError(
            new Error(
              'Manual time bank auto-action rejected at seat ' + player.seat + ' - re-arming clock'
            ),
            'ServerTableEngine.' + this.tableId + '.manual_timebank_auto_action_rejected'
          );
          this.forceArmTurnTimer(player.seat, this.tableInfo?.action_time_seconds || 15);
          return;
        }
        this.turnFSM.transition('complete');

        /* THIS EXPIRY COUNTS TOO (2026-09-09). Both sibling expiry paths - the
           ordinary turn clock and the AUTO time-bank - call this, for the
           reason AUDIT FIX 2026-07-19 gives: a connected player who lets the
           clock run out is AFK, and the consecutive-timeout ladder is the only
           thing that eventually sits them out. This path recorded telemetry and
           broadcast `time_bank_timeout` but never told the ladder, so a player
           who pressed the time-bank button and walked away could never reach
           the cap: every hand cost the table a full clock plus a full bank, and
           the seat stayed in for ever. */
        this.disconnectEngine.recordConnectedTimeout(this.tableId, userId);

        // FIX 149: Wire telemetry — manual time bank expiry
        this.engineTelemetry.recordTimerExpired(this.tableId);

        // FIX 124c: Manual time bank expired → broadcast timeout event (same as FIX 124b for auto path)
        const tbUsesLeft = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
        const unlimitedTimeBanks = this.timeBankEngine.isUnlimited(this.tableId, userId);
        try {
          this.hub?.emitEvent(this.tableId, {
            type: 'time_bank_timeout',
            table_id: this.tableId,
            player_id: userId,
            uses_remaining: tbUsesLeft,
            timed_out_action: tbCanCheck ? 'check' : 'fold',
            show_buy_more: !unlimitedTimeBanks && tbUsesLeft <= 0,
            unlimited_activations: unlimitedTimeBanks,
          });
        } catch {
          /* broadcast failure is non-fatal */
        }
      },
      remainingBeforeBank
    );

    if (activation !== 'activated') {
      // Title Case, no em dashes (CLAUDE.md §5.7). Each reason is distinct so
      // the player is not told "depleted" when they simply used both banks on
      // this street and still own plenty.
      const reason =
        activation === 'street_limit'
          ? 'You Have Already Used Two Time Banks On This Street'
          : activation === 'already_active'
            ? 'Your Time Bank Is Already Running'
            : activation === 'clock_not_exhausted'
              ? 'Your Clock Is Still Running'
              : 'No Time Bank Uses Remaining';
      return { success: false, error: reason };
    }

    this.timeBankActivatedThisTurn = true;

    // Get bank info for the broadcast
    const bank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
    const bankSeconds = bank ? bank.currentUseSeconds : 20;

    // A bank RESETS the clock; it does not extend it. remainingBeforeBank is
    // within the exhaustion epsilon by the time we get here, so there is
    // nothing left to add and the enforcement countdown armed inside
    // TimeBankEngine is this same number.
    const newDuration = bankSeconds;

    console.log(
      `[ServerTableEngine:${this.tableId}] Player ${userId} spent a time bank. Clock reset to ${bankSeconds}s.`
    );

    this.startTurnTimer(userId, player.seat, newDuration, 'time_bank');

    // Broadcast time bank activation to other players
    try {
      supabase
        .channel(`table:${this.tableId}`)
        .send({
          type: 'broadcast',
          event: 'time_bank_activated',
          payload: {
            player_id: userId,
            table_id: this.tableId,
            additional_seconds: bankSeconds,
            uses_remaining: bank?.usesRemaining ?? 0,
            total_remaining: bank?.remainingSeconds ?? 0,
            unlimited_activations: bank?.unlimitedActivations === true,
            auto_activated: false,
          },
        })
        .catch((err) => reportError(err, 'ServerTableEngine.time_bank_broadcast_failed'));
    } catch (err) {
      // A cosmetic broadcast must never break the turn it decorates — but it
      // must not vanish either. This was the one bare `catch (e) {}` left in
      // the engine: an unused binding, no comment, no report, swallowing every
      // synchronous throw from the legacy Realtime path.
      reportError(err, 'ServerTableEngine.time_bank_broadcast_threw');
    }

    // FIX 125 + 2026-04-14 spam fix: warn ONLY at the last 1 remaining (or 0
    // = just used last one). Previous <=5 condition spammed on 4-max tables.
    const manualUsesLeft = bank?.usesRemaining ?? 0;
    if (bank?.unlimitedActivations !== true && manualUsesLeft >= 0 && manualUsesLeft <= 1) {
      try {
        this.hub?.emitEvent(this.tableId, {
          type: 'time_bank_low',
          table_id: this.tableId,
          player_id: userId,
          uses_remaining: manualUsesLeft,
        });
      } catch {
        /* broadcast failure is non-fatal */
      }
    }

    // Phase X5 (2026-04-29) — Bible V8 §1.16 time_bank_activated public event
    // distinct from time_bank_low/timeout. Broadcast lets opponents see the
    // "TIMEBANK" indicator on the acting player's seat ring (not just the
    // hero who triggered it).
    try {
      this.hub?.emitEvent(this.tableId, {
        type: 'time_bank_activated',
        table_id: this.tableId,
        player_id: userId,
        seat: player.seat,
        uses_remaining: manualUsesLeft,
        // Dan 2026-08-21 (item 2): the client extends its countdown from this
        // number. Without it the hub path fell back to a hard-coded default,
        // so a bank of any other length was displayed wrong.
        secondsGranted: bankSeconds,
        usesRemaining: manualUsesLeft,
        unlimitedActivations: bank?.unlimitedActivations === true,
        timestamp: Date.now(),
      });
    } catch {
      /* broadcast failure is non-fatal */
    }

    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // MISSING ENDPOINTS — Bible V8 Required (heartbeat, preaction, sitout, state)
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * POST /heartbeat — Bible V8 §6.3: Reset disconnect timer for a player
   */
  public heartbeat(
    userId: string,
    /**
     * PHASE 2 (2026-08-31): the client reporting that it has actually DRAWN
     * the action controls for this player. Optional - older clients omit it,
     * and the silent-client canary falls back to its weaker signal rather
     * than treating them as suspect.
     *
     * It rides the heartbeat instead of getting a route of its own because
     * the heartbeat already runs on a timer, is already authenticated, and
     * already resolves the table engine. A second endpoint would be a second
     * thing to keep alive for the sake of one boolean.
     */
    opts?: {
      turnRendered?: boolean;
      /**
       * 2026-09-04 (second sweep, Dan: "my rebuy said it failed to load ...
       * and booted me"). The client is showing this player the bust-rebuy
       * dialog right now. BUSTED_GRACE_MS starts on the first dealing-loop
       * tick that sees a 0 stack - BEFORE the dialog has even rendered - so a
       * player reading the sheet, retrying a balance read, or picking an
       * amount was stood up under it. A seat whose owner is at the cashier is
       * being defended, and the sweep waits while this is fresh.
       */
      rebuyPromptOpen?: boolean;
    }
  ): {
    success: boolean;
    connected: boolean;
    gracePeriodRemaining: number;
  } {
    /* 2026-09-04 (disconnect audit item 5): a SEATED player the FSM has never
       met is registered here rather than ignored. registerPlayer() runs at
       the deal, so a seat taken since boot at a table below the deal minimum
       was untracked: every heartbeat returned early, /heartbeat answered
       `connected: true` for a key it did not have, and the abandoned-seat
       rule (which reads disconnectedAt) could never see them go. The same
       on-demand registration sitOut() and notifyPageLeft() already do. A
       spectator's heartbeat still registers nothing. */
    this.registerSeatedPlayerOnDemand(userId);
    this.disconnectEngine.heartbeat(this.tableId, userId);
    if (opts?.turnRendered) {
      this.disconnectEngine.noteTurnRendered(this.tableId, userId);
    }
    if (opts?.rebuyPromptOpen) this.rebuyPromptOpenAt.set(userId, Date.now());
    const connected = this.disconnectEngine.isConnected(this.tableId, userId);
    return { success: true, connected, gracePeriodRemaining: 0 };
  }

  /**
   * CONNECTIVITY UPGRADE (2026-08-22): transport-level disconnect signal.
   * Called by EngineWebSocketServer when a player's LAST live socket for this
   * table closes. Millisecond-latency counterpart to the 30s stale-heartbeat
   * sweep: the disconnect countdown / auto-action ladder starts immediately
   * instead of the table burning a full action clock on a player who is gone.
   * A reconnect (WS onConnect -> heartbeat) cancels it just as fast.
   */
  /**
   * POST /away — Dan 2026-08-23: the CLIENT is telling us it is going away
   * (pagehide, tab close, app frozen by the OS), rather than us inferring it
   * from silence.
   *
   * That distinction is why this skips the transport grace window that
   * `notifyTransportDisconnect` opens: a socket dying is ambiguous, but "I am
   * leaving" is not. The player keeps their seat — they are simply AWAY, so
   * the one-SB-one-BB cap applies and they are stood up and cashed out once
   * it is spent. Coming back (any heartbeat) clears it at no cost.
   */
  public notifyPageLeft(userId: string): void {
    /* 2026-09-04: register on demand, as sitOut() does (DisconnectEngine.ts,
       "chicken-and-egg deadlock"). markPageLeft() silently returned for a
       player the FSM had never met - a seat taken since boot at a table that
       has not dealt (registerPlayer runs at the deal), which is exactly the
       quiet table where an abandoned seat matters most. The beacon was
       answered {tracked: true} and nothing was tracked. Only a SEATED player
       is registered; a spectator's beacon is still a no-op. */
    this.registerSeatedPlayerOnDemand(userId);
    this.disconnectEngine.markPageLeft(this.tableId, userId);
  }

  public notifyTransportDisconnect(userId: string): void {
    // 2026-08-22: markTransportGone, not markDisconnected. The socket dying is
    // not the player leaving — their HTTP heartbeat is a second transport, and
    // concluding on the first one alone fired a disconnect banner, a sound and
    // a haptic buzz at players who never went anywhere.
    // 2026-09-04: registered on demand for the same reason as heartbeat() -
    // the socket of a seat taken since boot at a quiet table closing was
    // invisible to the FSM, so the seat could never become MISSING.
    this.registerSeatedPlayerOnDemand(userId);
    this.disconnectEngine.markTransportGone(this.tableId, userId);
  }

  /**
   * Register a player with the presence FSM if - and only if - they hold a
   * seat at this table. The FSM normally meets a player at the deal
   * (registerPlayer in dealHand); every signal that can arrive BEFORE a deal
   * (heartbeat, socket close, /away, /sitout) routes through here so a quiet
   * table tracks its seats the way a dealing one does. Idempotent:
   * registerPlayer is a no-op for a known key.
   */
  protected registerSeatedPlayerOnDemand(userId: string): void {
    if (this.seatedPlayers.some((p) => p.user_id === userId)) {
      this.disconnectEngine.registerPlayer(this.tableId, userId);
    }
  }

  /**
   * POST /preaction — Bible V8 §4.15: Set or clear a pre-action
   *
   * ── THE ARM IS ACKNOWLEDGED WITH THE ENGINE'S OWN NUMBER (2026-08-30) ────
   *
   * The response now carries `armedToCall`: the price the ENGINE recorded at
   * set time (`toCallAtSet`), computed from its own authoritative state.
   *
   * Why this matters, and why it is not a broadcast. The client suppresses
   * the ActionPanel while an armed pre-action is one the engine can still
   * honour (src/lib/preActionPanelGate.ts), and until now it judged that
   * against a price IT snapshotted in the browser at the moment of the tap.
   * Two independent snapshots of the same number, taken at two moments, on
   * two machines — they agree almost always, and the "almost" is a player
   * seeing the panel flash on a hand where the engine was going to act, or
   * (worse) not seeing it on a hand where the engine had already invalidated
   * the arm. Handing back the engine's number collapses that to ONE number.
   *
   * It is returned in the reply to the hero's OWN request, so no other seat
   * learns anything: this is deliberately not the table-wide broadcast that
   * would hand villains the tell the engine's visible pre-action beat exists
   * to mask.
   */
  public setPreAction(
    userId: string,
    action: string,
    maxCallAmount?: number
  ): { success: boolean; error?: string; armedToCall?: number } {
    if (!this.handController) {
      return { success: false, error: 'No active hand' };
    }
    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not found at this table' };
    }

    if (action === 'clear') {
      this.preActionEngine.clearPreAction(this.tableId, userId);
      return { success: true };
    }

    // Validate the pre-action type
    const validPreActions = [
      'auto_fold',
      'auto_check_fold',
      'auto_check',
      'auto_call',
      'auto_call_any',
    ];
    if (!validPreActions.includes(action)) {
      return { success: false, error: `Invalid pre-action: ${action}` };
    }

    /**
     * Dan 2026-08-28 (CRITICAL): record the price the player is looking at
     * RIGHT NOW, computed by the engine from its own authoritative state —
     * never trusted from the client. PreActionEngine invalidates an
     * `auto_call` whose price has risen past this by the time it fires, so
     * "Call 15" can never call a raise to more than 15 even when the client
     * sends no maxCallAmount at all.
     */
    const toCallAtSet = Math.max(0, state.currentBet - (player.bet ?? 0));
    this.preActionEngine.setPreAction(
      this.tableId,
      userId,
      action as any,
      maxCallAmount,
      toCallAtSet
    );

    // LIVE E2E FIX 2026-08-15: a pre-action armed AFTER the player's turn had
    // already started used to sit queued until their NEXT turn — the only
    // execution hook was handleTurnChange step 1, which had already run. Live
    // repro: hero armed CALL ANY as a bet landed and the turn began; nothing
    // fired and the turn timer ran. Real poker rooms convert the armed
    // pre-action into an immediate action in that case. If it is currently
    // this player's turn and they can still act, resolve the pre-action now
    // and route it through the normal serialized action path
    // (handlePlayerAction: validation, lock, timer clear, broadcast).
    if (
      player.seat === state.currentPlayerSeat &&
      !player.is_folded &&
      !player.is_all_in &&
      !player.is_sitting_out
    ) {
      const toCall = Math.max(0, state.currentBet - (player.bet ?? 0));
      const preResult = this.preActionEngine.executePreAction(
        this.tableId,
        userId,
        toCall === 0,
        toCall,
        player.stack
      );
      if (preResult.executed && preResult.action) {
        const acted = this.handlePlayerAction(
          userId,
          preResult.action,
          preResult.amount,
          undefined,
          'pre_action'
        );
        if (acted.success) {
          console.log(
            `[ServerTableEngine:${this.tableId}] Pre-action armed mid-turn executed immediately: ${userId} -> ${preResult.action}${preResult.amount ? ` ${preResult.amount}` : ''}`
          );
        } else {
          console.warn(
            `[ServerTableEngine:${this.tableId}] Immediate pre-action ${preResult.action} rejected: ${acted.error}`
          );
        }
      }
    }

    /* The engine's own recorded price rides back to the hero (see the note on
       this method). One number, not two snapshots that can disagree. */
    return { success: true, armedToCall: toCallAtSet };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // REAL PLAYER ACTION — Accept actions from HTTP endpoint
  // ═══════════════════════════════════════════════════════════════════════════════

  /**
   * Handle an action from a REAL player (not a horse).
   * Called from the HTTP /action endpoint when a player clicks fold/call/raise.
   */
  handlePlayerAction(
    userId: string,
    action: string,
    amount?: number,
    actionContext?: string | null,
    trustedOrigin?: 'pre_action'
  ): { success: boolean; error?: string; code?: string; hint?: Record<string, unknown> } {
    if (!this.lifecycleCanMutate()) {
      return {
        success: false,
        error: 'Table ownership changed - reconnect',
        code: 'TABLE_LEASE_EXPIRED',
      };
    }
    // HTTP always supplies a context (null for an old bundle). Only trusted
    // in-process callers omit this argument. Check before clocks or chips move.
    if (
      actionContext !== undefined &&
      (typeof actionContext !== 'string' || actionContext !== this.getActionContext())
    ) {
      return {
        success: false,
        code: actionContext === null ? 'ACTION_CONTEXT_REQUIRED' : 'STALE_ACTION',
        error:
          actionContext === null
            ? 'The table view is out of date. Reload to continue.'
            : 'The turn has changed. Review the table before acting again.',
      };
    }
    // Bible V8 §1.1.4: Serialize all actions — no parallel processing
    if (this.actionLock) {
      return { success: false, error: 'Action already being processed - try again' };
    }
    this.actionLock = true;
    try {
      return this._handlePlayerActionInner(
        userId,
        action,
        amount,
        actionContext !== undefined
          ? 'player'
          : trustedOrigin === 'pre_action'
            ? 'pre_action'
            : 'unknown'
      );
    } finally {
      this.actionLock = false;
    }
  }

  protected _handlePlayerActionInner(
    userId: string,
    action: string,
    amount?: number,
    origin: AcceptedActionOrigin = 'unknown'
  ): { success: boolean; error?: string; code?: string; hint?: Record<string, unknown> } {
    if (!this.handController) {
      return { success: false, error: 'No active hand' };
    }

    const state = this.handController.getState();

    // Find the player's seat
    const player = state.players.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not found at this table' };
    }

    // Verify it's this player's turn
    if (state.currentPlayerSeat !== player.seat) {
      return { success: false, error: 'Not your turn' };
    }

    // AUDIT FIX 2026-07-19: the player is present and acting — clear any
    // consecutive-timeout streak so a single AFK lapse doesn't accumulate
    // toward an auto-sit-out.
    this.disconnectEngine.recordPlayerActed(this.tableId, userId);

    const seat = player.seat;
    const toCall = Math.max(0, state.currentBet - player.bet);

    // Normalize actions
    let normalizedAction = action.toLowerCase();
    if (normalizedAction === 'allin' || normalizedAction === 'all-in') normalizedAction = 'all_in';
    if (normalizedAction === 'check' && toCall > 0) normalizedAction = 'call';
    if (normalizedAction === 'call' && toCall === 0) normalizedAction = 'check';
    if (normalizedAction === 'raise' && state.currentBet === 0) normalizedAction = 'bet';
    if (normalizedAction === 'bet' && state.currentBet > 0) normalizedAction = 'raise';

    // Bible V8 §4.14: PLO variants are pot-limit; flh/flo8 are fixed-limit
    // (2026-08-23). BettingStructure decides — this used to be an inline
    // `startsWith('plo')`, which silently made every non-PLO variant no-limit.
    // VARIANT OVERRIDE FOLLOW-UP 2026-08-28: read the LIVE HAND's variant, not
    // the table row. `activeHandVariant()` was introduced the same day for
    // exactly this, and its docblock names "the legal-action clamps in Turns"
    // as one of the four sites that must use it — getLegalActions (1512) and
    // the horse snapshot (1887) were converted, THIS clamp and its horse twin
    // below were missed. On a bomb-pot hand whose override differs from the
    // table's variant that mismatch is silent and expensive: a PLO table with
    // an nlh override clamped a player's shove down to the pot, and a
    // fixed-limit table with an nlh override REWROTE the wager to the table's
    // limit size — in both cases the player was committed to an amount they
    // never chose. The reverse (NLH table, PLO bomb) enforced no pot ceiling
    // here at all and left HandController to reject the action, burning the
    // player's clock on "Action rejected by engine".
    const variant = this.activeHandVariant();
    const isPotLimit = isPotLimitVariant(variant);
    const isFixedLimit = isFixedLimitVariant(variant);
    let potLimitMaxBet = Infinity;
    if (isPotLimit) {
      // FIX 142: Pot-limit max raise SIZE = pot + toCall (the pot after you call).
      // Previous formula (pot + toCall + toCall) was one toCall too permissive.
      // For a BET (toCall=0): maxBet = pot. For a RAISE: maxRaiseSize = pot + toCall.
      // This matches PokerEngine.calculateBettingState (FIX 121).
      potLimitMaxBet = potLimitBettingPot(state) + toCall;
    }

    // Fixed limit has exactly one legal wager size per street, so a client that
    // sends any other number is SNAPPED to it rather than rejected — a limit
    // client has no slider to be wrong with, and an old client sending a
    // no-limit sizing should still make a legal bet. Small bet preflop and
    // flop, big bet turn and river.
    const flBetSize = isFixedLimit
      ? fixedLimitStreetBounds(
          state.actionHistory,
          state.stage,
          fixedLimitBetSize(this.tableInfo?.big_blind ?? 2, state.stage),
          state.currentBet
        ).raiseSize
      : 0;

    /**
     * ── CAP: A PER-HAND CEILING ON WHAT A PLAYER CAN PUT IN ────────────────
     *
     * Dan 2026-08-25, table-creation parity. `cap_enabled` has been a toggle
     * since February with NO AMOUNT COLUMN ANYWHERE IN THE SCHEMA, so even a
     * reader could not have enforced it. `cap_bb` was added alongside this.
     *
     * A cap is a limit on TOTAL chips committed across the whole hand, not on
     * one street, so it is measured against `totalInvested` — which the engine
     * already maintains and broadcasts. `player.bet` is this street only, and
     * capping on that would let a player commit the cap four times over.
     *
     * CLAMPED, NOT REJECTED, exactly like the pot-limit ceiling above it and
     * for the same reason the fixed-limit snap gives: a client with a stale
     * cap value should still make a LEGAL bet rather than have its action
     * bounce. The amount is reduced to whatever is left under the ceiling.
     *
     * A player who reaches the cap is NOT all-in — their remaining stack stays
     * in front of them and plays the next hand. That is the whole point of a
     * cap game, and it is why the all-in promotions below have to be measured
     * against the capped figure rather than the raw stack.
     */
    const capBB = Number(this.tableInfo?.cap_bb) || 0;
    const capChips =
      this.tableInfo?.cap_enabled === true && capBB > 0
        ? capBB * (Number(this.tableInfo?.big_blind) || 0)
        : 0;
    /* What this player may still commit this hand. Infinity when uncapped, so
       every Math.min below is a no-op on an ordinary table. */
    const capRemaining =
      capChips > 0 ? Math.max(0, capChips - (Number(player.totalInvested) || 0)) : Infinity;

    /**
     * AN "ALL IN" AT A CAPPED TABLE IS NOT ALL OF YOUR CHIPS.
     *
     * `all_in` skips the amount clamps below entirely — validateAllIn returns
     * `sanitizedAmount: context.playerStack` unconditionally — so without this
     * a player could push their whole stack past a ceiling the host set, and
     * the cap would hold for every action EXCEPT the largest one.
     *
     * Rewritten into an ordinary bet or raise of exactly what the cap leaves,
     * so it goes through the same validation as any other sized action and
     * the remainder of the stack stays in front of the player.
     */
    if (normalizedAction === 'all_in' && capRemaining !== Infinity) {
      const stillAllowed = Math.min(player.stack, capRemaining);
      if (stillAllowed <= 0) {
        return { success: false, error: "You have committed this table's cap for this hand" };
      }
      // If the cap stops short of the live call while chips remain behind,
      // rewriting all-in to a sized raise would create the same illegal
      // non-all-in under-call the canonical menu removed. A genuinely short
      // stack may still put its final chips in; only the table cap is barred
      // from pretending the player is all-in.
      if (stillAllowed < player.stack && toCall > capRemaining + 0.005) {
        return {
          success: false,
          error: "Calling would exceed this table's per-hand commitment cap",
        };
      }
      if (stillAllowed < player.stack) {
        normalizedAction = state.currentBet > 0 ? 'raise' : 'bet';
        amount = state.currentBet > 0 ? player.bet + stillAllowed : stillAllowed;
      }
    }

    // Clamp amounts. Never synthesize a partial non-all-in call: unequal dead
    // or forced contributions mean the bettor can remain under its own cap
    // while the same street call would put this player over theirs.
    if (normalizedAction === 'call' && capRemaining !== Infinity && toCall > capRemaining + 0.005) {
      return {
        success: false,
        error: "Calling would exceed this table's per-hand commitment cap",
      };
    }
    if (normalizedAction === 'call') amount = toCall;
    if (normalizedAction === 'bet' && amount !== undefined) {
      amount = isFixedLimit ? flBetSize : Math.max(state.minRaise, amount);
      // Bible V8 §4.14: Cap at pot-limit max for PLO
      if (isPotLimit) {
        amount = Math.min(amount, potLimitMaxBet);
      }
      // Table cap: never more than this hand has left under the ceiling.
      amount = Math.min(amount, capRemaining);
      /* CAP FIX 2026-08-27: this used to promote to all_in whenever the amount
         reached min(stack, capRemaining) — so a bet CLAMPED BY THE CAP one
         line above was immediately turned back into an all-in, and
         HandController.performAction ignores `amount` for all_in and commits
         the ENTIRE stack (`this.state.pot += player.stack; player.stack = 0`).
         The rewrite at the top of this method was therefore a no-op round
         trip and the ceiling was defeated by the largest action it exists to
         bound. Only the STACK may promote: the player is all-in when they
         have no chips left, not when the cap says stop. */
      if (amount >= player.stack && player.stack <= capRemaining) {
        normalizedAction = 'all_in';
        amount = undefined;
      }
    } else if (normalizedAction === 'raise' && amount !== undefined) {
      const minRaiseTo = state.currentBet + state.minRaise;
      amount = isFixedLimit ? state.currentBet + flBetSize : Math.max(minRaiseTo, amount);

      // Bible V8 §4.14: Cap at pot-limit max for PLO (raise TO = currentBet + potLimitMaxBet)
      if (isPotLimit) {
        const potLimitRaiseTo = state.currentBet + potLimitMaxBet;
        amount = Math.min(amount, potLimitRaiseTo);
      }
      /* A raise is a TO figure, so the ceiling has to be expressed the same
         way: this street's bet plus whatever the cap leaves. */
      const capRaiseTo = capRemaining === Infinity ? Infinity : player.bet + capRemaining;
      amount = Math.min(amount, capRaiseTo);
      /* CAP FIX 2026-08-27: same defect on the raise path — a raise clamped to
         capRaiseTo reached maxRaiseTo and was promoted to a whole-stack shove.
         The stack must be the binding constraint for an all-in; when the cap
         is what bounds the wager it stays a sized raise. */
      const stackRaiseTo = player.stack + player.bet;
      const maxRaiseTo = Math.min(stackRaiseTo, capRaiseTo);
      if (amount >= maxRaiseTo && stackRaiseTo <= capRaiseTo) {
        normalizedAction = 'all_in';
        amount = undefined;
      }
    }

    // Step 4: Run ServerActionValidator for timing, duplicate suppression, and state validation
    const currentPlayer = state.players.find((p) => p.seat === state.currentPlayerSeat);
    const validationCtx: ValidationContext = {
      currentPlayerId: currentPlayer?.user_id ?? '',
      stage: state.stage,
      currentBet: state.currentBet,
      playerBet: player.bet,
      playerStack: player.stack,
      bigBlind: this.tableInfo?.big_blind ?? 2,
      minRaise: state.minRaise,
      pot: state.pot,
      canCheck: toCall === 0,
      actionDeadline: this.preciseTimer.getDeadline(this.tableId, userId),
      playerActedThisRound: false,
      isAllIn: player.is_all_in,
      isFolded: player.is_folded,
      numActivePlayers: state.players.filter((p) => !p.is_folded && !p.is_all_in).length,
    };

    const validation = this.actionValidator.validate(
      {
        tableId: this.tableId,
        handId: `${this.handCount}`,
        playerId: userId,
        action: normalizedAction as any,
        amount,
        timestamp: Date.now(),
      },
      validationCtx
    );

    if (!validation.valid) {
      return {
        success: false,
        error: validation.reason || 'Action validation failed',
        code: validation.code,
        hint: validation.hint as Record<string, unknown> | undefined,
      };
    }

    // Use sanitized action/amount from validator if provided
    if (validation.sanitizedAction) {
      normalizedAction = validation.sanitizedAction;
    }
    if (validation.sanitizedAmount !== undefined) {
      amount = validation.sanitizedAmount;
    }

    try {
      // Bible V8 §2.15: Log action received
      this.currentHandTimerLog.push({
        playerId: userId,
        event: 'action_received',
        timestamp: Date.now(),
        durationMs: Date.now() - this.playerTurnStartTime,
        timeBankUsed: this.timeBankActivatedThisTurn,
      });
      // Bible V8 §3.3: Turn FSM — timer_running/time_bank_active → action_received → processing
      this.turnFSM.transition('action_received');
      this.turnFSM.transition('processing');

      this.clearTurnTimer();
      this.preciseTimer.cancelTimer(this.tableId, userId); // Step 4: Cancel precise deadline
      // Bible V8 §6.2: If time bank was active, notify engine to deduct used time from pool.
      //
      // 2026-08-26: this was gated on timeBankActivatedThisTurn ALONE. The
      // ARM-ONLY branch of activateTimeBank returns early - with the message
      // "Time Bank Armed. It Starts When Your Clock Runs Out" - and never sets
      // that flag, because nothing has been spent yet. So a player who pressed
      // the button early and then acted inside their ordinary clock left
      // bank.armed = true behind them. On any LATER turn in the same street,
      // onPrimaryTimerExpired sees that stale intent and spends a use they did
      // not ask for; only resetStreetActivations cleared it, a whole street
      // later. playerActed is the thing that clears bank.armed, and
      // TimeBankEngine.manualcountdown.test.ts already pins that contract
      // ("player acted in time; the intent dies with it"). The engine was
      // right; this caller simply never reached it.
      if (this.timeBankActivatedThisTurn || this.timeBankEngine.isArmed(this.tableId, userId)) {
        this.timeBankEngine.playerActed(this.tableId, userId);
      }
      // ── THE CLOCK STARTS BEFORE THE ACTION IS APPLIED (2026-09-05) ────
      //
      // It used to start AFTER this call, and that made
      // poker_act_to_broadcast_ms measure the wrong thing entirely.
      // performAction emits PLAYER_ACTION synchronously, whose handler calls
      // broadcastCurrentState - so the broadcast for THIS action happened
      // inside this call, observed the clock left armed by the PREVIOUS
      // action, and recorded the gap between two actions. The published
      // "median 808ms act-to-broadcast" was really the median interval
      // between consecutive actions at a table, which is turn pacing and not
      // latency at all.
      //
      // Armed here, the observation inside performAction measures what the
      // name says: accepted -> every seat has it. Rejection disarms below,
      // so a refused action cannot leave a live clock for the next broadcast
      // to pick up.
      const actClockWasArmed = this.lastActionAcceptedAtMs;
      this.lastActionAcceptedAtMs = Date.now();
      const actionApplied = this.handController.performAction(
        seat,
        normalizedAction as any,
        amount,
        origin
      );
      if (!actionApplied) {
        // Restore whatever was pending; this action contributed nothing.
        this.lastActionAcceptedAtMs = actClockWasArmed;
      }
      // SWEEP #4 FIX (2026-07-23): performAction returns false (it does NOT throw)
      // when the engine rejects an action the validator let through — most reachably
      // a `raise` that cannot legally reopen betting against a sub-full-raise all-in
      // (HandController §4.14 canReopenBetting). The old code ignored the false return,
      // transitioned the FSM to 'complete', and returned success — but the turn/precise
      // timers were already cancelled above and no TURN_CHANGE fired, so the table froze
      // with no clock until the 10-minute HAND_SAFETY_TIMEOUT void (and the acting client
      // was told the action succeeded). Re-arm this player's turn and surface the rejection.
      if (!actionApplied) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Engine REJECTED action ${normalizedAction} from ${userId} - re-arming turn timer`
        );
        this.rearmTurnTimerIfCurrent(userId);
        return { success: false, error: 'Action rejected by engine', code: 'INVALID_ACTION' };
      }
      console.log(
        `[ServerTableEngine:${this.tableId}] Player ${userId} → ${normalizedAction}${amount ? ` ${amount}` : ''}`
      );

      // Bible V8 §3.3: Turn FSM — processing → complete
      this.turnFSM.transition('complete');

      // FIX 149: Wire telemetry — record that player acted within timer
      this.engineTelemetry.recordTimerActed(this.tableId);

      // ── ADDITIVE observability (#5): actions-processed counter + act→broadcast timer start ──
      try {
        EngineMetrics.actionsTotal.inc(1, { table_id: this.tableId });
        EngineMetrics.actionsFleetTotal.inc(1, {
          audience: this.humansSeated() > 0 ? 'human' : 'horse',
          format: this.tableFormat(),
        });
        // The act->broadcast clock is NOT armed here: by this line the
        // broadcast for this action has already gone out (performAction
        // drains PLAYER_ACTION synchronously). Arming here is what made the
        // metric measure inter-action gaps. See the note at performAction.
      } catch {
        /* metrics must never affect gameplay */
      }

      // FIX 137: Bible V8 §7.17 — snapshot hand state after a successful action.
      // C15: coalesced (see requestSnapshot). This used to be an unconditional
      // write per action; a busy street now collapses to about one write per
      // second per table, and the last state of the burst is still the one that
      // lands.
      this.requestSnapshot();

      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Action failed';
      console.warn(`[ServerTableEngine:${this.tableId}] Player action failed:`, errMsg);
      // ── ADDITIVE observability (#5): RPC/action error counter ──
      try {
        EngineMetrics.rpcErrorsTotal.inc(1, { method: 'action' });
      } catch {
        /* metrics must never affect gameplay */
      }
      // Return error to client — do NOT auto-fold. The player should see the error
      // and choose their next action. Auto-folding on invalid actions silently
      // destroys hands (e.g., a raise with wrong amount shouldn't fold the player).
      return { success: false, error: errMsg };
    }
  }

  /**
   * Get available actions for a specific player
   */
  getPlayerActions(userId: string): {
    canAct: boolean;
    actions: string[];
    toCall: number;
    minRaise: number;
    maxRaise: number;
    pot: number;
    /**
     * 2026-08-23: which betting structure the client should render. Without
     * this the client had to re-derive it from the variant string, which is
     * how `flh` would have drawn a no-limit slider on a fixed-limit table.
     */
    structure?: BettingStructure;
    /** Fixed limit only: the street's one legal wager size. */
    betSize?: number;
  } {
    const defaultResult = {
      canAct: false,
      actions: [],
      toCall: 0,
      minRaise: 0,
      maxRaise: 0,
      pot: 0,
    };
    if (!this.handController) return defaultResult;

    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);
    if (!player) return defaultResult;

    const authoritative = this.handController.getAuthoritativeActionState(userId);
    if (!authoritative) return { ...defaultResult, pot: state.pot };
    const bounded = applyTableCommitmentCap(
      authoritative,
      player,
      this.tableInfo?.cap_enabled === true,
      Number(this.tableInfo?.cap_bb) || 0,
      Number(this.tableInfo?.big_blind) || 0
    );

    return {
      canAct: bounded.canAct,
      actions: bounded.legalActions,
      toCall: bounded.toCall,
      minRaise: bounded.minRaiseTo ?? 0,
      maxRaise: bounded.maxRaiseTo ?? 0,
      pot: state.pot,
      structure: bounded.structure,
      betSize: bounded.fixedBetSize ?? undefined,
    };
  }

  /** Transfer the current decision to the unspent, server-owned outage deadline. */
  protected armRemainingReconnectProtection(userId: string): boolean {
    if (!this.handController || this.disconnectEngine.isConnected(this.tableId, userId))
      return false;
    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);
    if (
      !player ||
      player.seat !== state.currentPlayerSeat ||
      player.is_folded ||
      player.is_all_in ||
      player.is_sitting_out
    )
      return false;
    const deadline = this.disconnectEngine.getFsmState(this.tableId, userId)?.graceDeadlineMs;
    if (!deadline || deadline <= Date.now()) return false;
    // A running bank owns its accounting until its own expiry callback hands over.
    if (this.timeBankEngine.getPlayerBank(this.tableId, userId)?.isActive) return false;
    this.preciseTimer.cancelTimer(this.tableId, userId);
    this.disconnectEngine.onPlayerTurn(
      this.tableId,
      userId,
      Math.max(0, state.currentBet - (player.bet ?? 0)) === 0
    );
    const armed = this.disconnectEngine.armedAutoActionDeadlineMs(this.tableId, userId);
    this.playerTurnStartTime = Date.now();
    this.playerTurnDuration = Math.max(0, (armed - this.playerTurnStartTime) / 1000);
    this.timeBankSuppressedThisTurn = true;
    return true;
  }

  /** A mid-turn outage receives the same protection as an outage before the turn. */
  protected handlePlayerDisconnectedMidTurn(userId: string): void {
    if (!this.handController) return;
    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);
    if (!player || player.seat !== state.currentPlayerSeat) return;
    if (player.is_folded || player.is_all_in || player.is_sitting_out) return;

    // A bank that is already counting down is already spent, and its own
    // expiry handler owns this seat. Leave it strictly alone.
    const activeBank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
    if (activeBank?.isActive) return;

    // An armed-but-unredeemed intent dies with the decision it was made for.
    if (this.timeBankEngine.isArmed(this.tableId, userId)) {
      this.timeBankEngine.disarm(this.tableId, userId);
    }

    this.timeBankSuppressedThisTurn = true;
    this.armRemainingReconnectProtection(userId);
  }

  /**
   * AUDIT FIX 2026-07-19: re-arm the action timer when a player reconnects on
   * their own turn (the disconnect countdown was cancelled with no replacement
   * timer). No-op unless a hand is live and it's genuinely this player's turn.
   */
  protected rearmTurnTimerIfCurrent(userId: string): void {
    if (!this.handController) return;
    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);
    if (!player || player.seat !== state.currentPlayerSeat) return;
    if (player.is_folded || player.is_all_in || player.is_sitting_out) return;

    // Bible V8 §1.7.5 — the reconnect grace re-arms the ACTION CLOCK, but it
    // must not also hand back the TIME BANK.
    //
    // handleTurnChange() clears timeBankActivatedThisTurn (see "Reset anti-spam
    // lock for this NEW turn" at the end of that method) because it assumes a
    // genuinely new turn. A reconnect is the SAME turn. Left alone, a player
    // could go stale, reconnect, and collect a fresh action clock AND a fresh
    // time bank on every cycle — stretching a single turn to roughly 45-55s,
    // stopped only by the unrelated table stall watchdog.
    //
    // The clock re-arm itself is deliberately preserved: removing it would
    // reintroduce the bug AUDIT FIX 2026-07-19 closed, where a reconnecting
    // player had no timer at all and the hand hung to the 10-minute void.
    // 2026-08-18 — the same "two deadlines, the shorter one wins" bug that
    // §6.2.d closed for the manual button, on the path that fix did not cover.
    //
    // If a time bank is already RUNNING for this seat, `timebank:<uid>` is
    // counting down to a deadline that startTurnTimer cannot see: it is a
    // different PreciseActionTimer key, so re-arming the turn clock replaces
    // `<uid>` and leaves the bank countdown untouched. handleTurnChange then
    // re-stamps playerTurnStartTime, which is what turn_deadline_ms broadcasts,
    // so the client is told it has a fresh clock while the older, shorter bank
    // deadline is still armed underneath and folds them mid-countdown. A tab
    // that suspends on mobile and wakes three seconds before the bank expires
    // is shown twenty seconds and folded in three.
    //
    // The player already spent the bank; reconnecting must not buy more time
    // and must not lose them any either. Leaving both the countdown AND the
    // broadcast stamps exactly as activation set them keeps the two in
    // agreement and tells the client the truth. There is a live timer here by
    // definition, so the hang this method exists to prevent cannot occur.
    const activeBank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
    if (activeBank?.isActive) return;

    // Reconnecting the same decision consumes the remainder of its protection;
    // it must not mint another action clock on every heartbeat/close cycle.
    const protection = this.disconnectEngine.getFsmState(this.tableId, userId)?.reconnectDeadlineMs;
    if (protection !== undefined) {
      if (protection <= Date.now()) {
        if (
          this.forceResolveSeat(
            player.seat,
            Math.max(0, state.currentBet - (player.bet ?? 0)) === 0
          )
        ) {
          this.markProgress();
        } else {
          this.forceArmTurnTimer(player.seat, this.tableInfo?.action_time_seconds || 15);
        }
        return;
      }
      this.startTurnTimer(userId, player.seat, Math.max(0.001, (protection - Date.now()) / 1000));
      this.timeBankSuppressedThisTurn = true;
      return;
    }

    const timeBankAlreadyUsedThisTurn = this.timeBankActivatedThisTurn;
    // handleTurnChange is async. Calling it bare left a rejection unhandled and
    // - worse - left this seat with no clock at all, which is the precise hang
    // this method was added to prevent. The other call site
    // (ServerTableEngineHandEvents, "void this.handleTurnChange(...).catch")
    // has had the guard since it went async; this one never got it.
    void this.handleTurnChange(
      { type: 'TURN_CHANGE', seat: player.seat, availableActions: [] } as HandEvent,
      this.seatedPlayers
    ).catch((err) => {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.rearm_turn_change_threw');
      this.forceArmTurnTimer(player.seat, this.tableInfo?.action_time_seconds || 15);
    });

    this.timeBankActivatedThisTurn = timeBankAlreadyUsedThisTurn;
  }

  /**
   * Dan 2026-08-20: async because a queued pre-action now holds a visible beat
   * before it lands (see preActionVisibleMs). Callers treat this as
   * fire-and-forget — the clock it arms and the pre-action it may execute are
   * both self-contained — so the one call site voids the promise and keeps its
   * existing try/catch + forceArmTurnTimer fallback for a synchronous throw.
   */
  protected async handleTurnChange(event: HandEvent, players: SeatedPlayer[]): Promise<void> {
    if (event.type !== 'TURN_CHANGE' || !this.lifecycleCanMutate() || !this.handController) return;

    const seat = event.seat;
    const player = players.find((p) => p.seat_number === seat);
    if (!player) return;

    const state = this.handController.getState();
    const enginePlayer = state.players.find((p) => p.seat === seat);
    if (!enginePlayer) return;

    // Crazy Pineapple owns a simultaneous per-seat discard round with its own
    // worker request and deadline. currentPlayerSeat is deliberately parked at
    // -1 during that round; a reconnect or stale TURN_CHANGE must not turn an
    // old preflop seat into an ordinary betting decision while cards are being
    // discarded.
    if (state.stage === 'pineapple_discard') return;

    // STALE-HANDLER GUARD (2026-08-22), defense in depth with the caller's
    // check in ServerTableEngineHandEvents: never arm a clock or run
    // disconnect/pre-action logic for a seat that is no longer on the clock.
    if (state.currentPlayerSeat !== seat) return;

    // This accepted TURN_CHANGE is the ownership boundary for asynchronous
    // horse work. Retire the previous turn before any pre-action await or an
    // early disconnected-player return. Stale TURN_CHANGE events are rejected
    // above and therefore cannot cancel work belonging to the current seat.
    this.cancelHorseDecisionWork();

    // ═══════════════════════════════════════════════════════════════════════
    // UNIFIED TURN HANDLING — Horses and real players follow the EXACT same flow.
    // Bible V8: Horses MUST be indistinguishable from real players.
    // Same timer, same broadcast, same action path. NO EXCEPTIONS.
    // ═══════════════════════════════════════════════════════════════════════

    const actionTime = this.tableInfo?.action_time_seconds || 15;
    this.timeBankActivatedThisTurn = false; // Reset anti-spam lock for this NEW turn
    // A new turn (and a reconnect re-arm, which routes through here) always
    // restores normal time-bank behaviour.
    this.timeBankSuppressedThisTurn = false;

    // Bible V8 §3.3: Turn FSM — reset to waiting at turn start, then transition to timer_running
    if (this.turnFSM.state !== 'waiting') {
      this.turnFSM.forceState('waiting');
    }

    // Step 1: Check for queued pre-action before starting timer (applies to ALL players)
    const toCallForPreAction = Math.max(0, state.currentBet - enginePlayer.bet);
    const canCheckForPreAction = toCallForPreAction === 0;
    const preResult = this.preActionEngine.executePreAction(
      this.tableId,
      player.user_id,
      canCheckForPreAction,
      toCallForPreAction,
      enginePlayer.stack
    );
    if (preResult.executed && preResult.action) {
      // The `return` below skips Step 4 (startTurnTimer) entirely, so it may
      // ONLY be taken when the action genuinely landed. performAction returns
      // false on rejection (a pre-action resolved against a bet level the
      // engine then re-validates is the reachable case) — the old try/catch
      // never saw that and returned anyway, leaving the seat with no clock.
      //
      // ── Dan 2026-08-20: a pre-action is still an ACTION and must be seen ──
      //
      // This used to fire synchronously, at 0ms, the instant the turn arrived:
      // the seat lit up and its check/fold/call was already applied in the same
      // tick. The seat never visibly "took its turn" — with several players
      // holding pre-actions, a whole street resolved instantly and looked like
      // those players had been skipped.
      //
      // The player has already decided, so this is shorter than a horse's think
      // time — but it is never zero. The seat lights up, holds a readable beat,
      // and only then does the action land.
      // ═══ 2026-08-31: IDENTITY, not null-ness. The null-check below let a
      // pre-action from hand N land in hand N+1 whenever the hand was
      // replaced during the beat and the SAME seat happened to be on turn in
      // the new hand - the same player's next hand opens on the same seat, so
      // that is the common case, and their turn was consumed by an intent
      // they formed for a different hand. Same bug class as the stale-runout
      // race (#2318): a delayed continuation acting on whatever controller
      // the table holds when it wakes.
      const controllerAtBeat = this.handController;
      await this.sleep(this.preActionVisibleMs);
      // The hand can be replaced while we hold that beat.
      if (
        !this.lifecycleCanMutate() ||
        this.handController !== controllerAtBeat ||
        !controllerAtBeat
      )
        return;
      {
        const st = controllerAtBeat.getState();
        if (st.currentPlayerSeat !== seat) return;
      }
      let preApplied = false;
      try {
        preApplied = controllerAtBeat.performAction(
          seat,
          preResult.action as any,
          preResult.amount,
          'pre_action'
        );
      } catch (err) {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.preaction_threw');
      }
      if (preApplied) {
        console.log(
          `[ServerTableEngine:${this.tableId}] Pre-action executed: ${player.user_id} → ${preResult.action}${preResult.amount ? ` ${preResult.amount}` : ''}`
        );
        this.markProgress();
        return; // Pre-action handled the turn — no timer needed
      }
      console.warn(
        `[ServerTableEngine:${this.tableId}] Pre-action ${preResult.action} REJECTED at seat ${seat} - falling through to the turn timer`
      );
      // The engine's copy is already gone (single-shot); the client's arm is
      // not, and it is holding every "your turn" surface down on the strength
      // of it. Say so, with the reason, so the bar clears and the player is
      // prompted now rather than at the end of the client's grace window.
      this.pushPreActionToPlayer(player.user_id, { reason: 'rejected' });
    }

    // Step 2: Check disconnect state before starting timer (applies to ALL players)
    const playerCanAct = this.disconnectEngine.onPlayerTurn(
      this.tableId,
      player.user_id,
      canCheckForPreAction
    );
    if (!playerCanAct) {
      // Player is disconnected or sitting out — DisconnectEngine will handle
      // auto-action via callback.
      //
      // 2026-09-04 (disconnect audit, item 1): PUBLISH THE CLOCK THAT IS
      // REALLY RUNNING. The caller stamped the ordinary action_time deadline
      // before invoking us, and the broadcast that follows this return read
      // it - so every client drew a 15s ring for a seat the engine was about
      // to act for in 350ms (sat out), or watched a 15s ring hit zero and
      // then sat through the rest of a 30s countdown (disconnected). This
      // runs synchronously before that broadcast (nothing above yields on
      // this path), so the snapshot carries the deadline the engine holds.
      const armed = this.disconnectEngine.armedAutoActionDeadlineMs(this.tableId, player.user_id);
      if (armed > 0) {
        const now = Date.now();
        this.playerTurnStartTime = now;
        this.playerTurnDuration = Math.max(0, (armed - now) / 1000);
      }
      return;
    }

    // Step 3: Reconnect grace (applies to ALL players)
    const reconnectGrace = this.disconnectEngine.isInReconnectGrace(this.tableId, player.user_id);
    const effectiveActionTime = reconnectGrace ? actionTime + 5 : actionTime;
    if (reconnectGrace) {
      console.log(
        `[ServerTableEngine:${this.tableId}] Player ${player.user_id} in reconnect grace - extending timer by 5s (${effectiveActionTime}s total)`
      );
    }

    // Step 4: Start the authoritative turn timer — SAME for horses and real players
    // Bible V8 §3.3: Turn FSM — waiting → timer_running
    this.turnFSM.transition('timer_running');
    this.startTurnTimer(player.user_id, seat, effectiveActionTime);

    // Step 5: If this is a horse, schedule their action after a realistic think time
    // The horse uses the SAME timer as a real player — the action fires within that timer window.
    // Think times: 2-8 seconds (varies by decision complexity to simulate real play)
    if (player.is_horse) {
      this.scheduleHorseAction(player, seat, enginePlayer, state);
    }
  }

  /**
   * Schedule a horse's action with realistic think time.
   * The horse's turn timer is ALREADY running (same as real players).
   * The horse submits its action within that timer window, just like a human would.
   */
  /**
   * Phase 6: one explicit tournament snapshot. Supabase stays off the action
   * clock: this is a synchronous cache read plus authoritative local table
   * state. A miss is `warming` with TOURNAMENT_CONTEXT_INCOMPLETE, never `{}`.
   */
  private horseTournamentContext(
    player: SeatPlayer,
    players: SeatPlayer[],
    dealerSeat: number | undefined,
    activeVariant: string
  ): {
    format: 'cash' | 'mtt' | 'sng' | 'spin' | 'hu_sng';
    tournament?: NonNullable<HorseGameStateV2['tournament']>;
  } {
    if (!this.isTournamentTable()) return { format: 'cash' as const };
    const tid = this.tableInfo?.tournament_id ? String(this.tableInfo.tournament_id) : '';
    const snapshot = tid
      ? getTournamentBrainContextSnapshot(tid)
      : {
          context: null,
          status: 'incomplete' as const,
          issues: [TOURNAMENT_CONTEXT_INCOMPLETE, 'tournament_id_missing'],
          ageMs: null,
        };
    const tctx = snapshot.context;
    const fallbackFormat =
      (this.tableInfo?.max_players ?? 9) <= 2 ? ('hu_sng' as const) : ('mtt' as const);
    // HandController.state.players is the exact dealt roster. Tournament
    // sit-outs stay in that roster, post blinds/antes, receive cards and are
    // auto-folded when action reaches them. They therefore still belong in an
    // orbit-cost M calculation even though they are not actionable opponents.
    const dealtPlayers = players;
    const actionablePlayers = players.filter((candidate) => !candidate.is_sitting_out);
    const playersAtTable = Math.max(2, dealtPlayers.length);
    const currentSmallBlind = Math.max(0, Number(this.tableInfo?.small_blind) || 0);
    const currentBigBlind = Math.max(0, Number(this.tableInfo?.big_blind) || 0);
    const currentAnte = Math.max(0, Number(this.tableInfo?.ante) || 0);
    const localIssues = [...snapshot.issues];
    if (currentSmallBlind <= 0 || currentBigBlind <= 0) {
      localIssues.push('live_blinds_invalid');
    }
    if (dealtPlayers.length < 2) localIssues.push('live_seat_state_incomplete');
    if (
      !Number.isSafeInteger(dealerSeat) ||
      !dealtPlayers.some((candidate) => candidate.seat === dealerSeat)
    ) {
      localIssues.push('dealer_seat_missing');
    }
    if (
      tctx &&
      tctx.currentBigBlind > 0 &&
      Math.abs(tctx.currentBigBlind - currentBigBlind) > 0.005
    ) {
      localIssues.push('blind_level_cache_lag');
    }
    const contextStatus =
      localIssues.length === 0
        ? snapshot.status
        : snapshot.status === 'warming' || snapshot.status === 'stale'
          ? snapshot.status
          : 'incomplete';
    if (contextStatus !== 'complete' && !localIssues.includes(TOURNAMENT_CONTEXT_INCOMPLETE)) {
      localIssues.unshift(TOURNAMENT_CONTEXT_INCOMPLETE);
    }
    const anteType: TournamentAnteType =
      this.tableInfo?.big_blind_ante_enabled === true
        ? 'big_blind'
        : currentAnte > 0 || (contextStatus === 'complete' && (tctx?.nextAnte ?? 0) > 0)
          ? 'per_player'
          : 'none';
    const localSeatsPerTable = Math.min(
      10,
      Math.max(2, Math.floor(Number(this.tableInfo?.max_players) || playersAtTable))
    );

    // M and cover pressure use chips still behind. Chips already committed to
    // this pot cannot fund a future orbit or a new wager against hero.
    const stackBehind = Math.max(0, Number(player.stack) || 0);
    const previousZone = this.horseTournamentMZones.get(player.user_id) ?? null;
    const m = buildTournamentMState({
      stackChips: stackBehind,
      smallBlind: currentSmallBlind,
      bigBlind: currentBigBlind,
      ante: currentAnte,
      anteType,
      playersAtTable,
      // A stale/partial clock stays observable in contextIssues, but it must
      // not create projected urgency on the action clock. Current M is still
      // authoritative because its blinds and stacks come from this table.
      nextSmallBlind: contextStatus === 'complete' ? tctx?.nextSmallBlind : null,
      nextBigBlind: contextStatus === 'complete' ? tctx?.nextBigBlind : null,
      nextAnte: contextStatus === 'complete' ? tctx?.nextAnte : null,
      minutesToNextLevel: contextStatus === 'complete' ? tctx?.nextBlindInMin : null,
      opponentStacks: actionablePlayers
        .filter((candidate) => candidate.user_id !== player.user_id)
        .map((candidate) => ({
          userId: candidate.user_id,
          stackChips: Math.max(0, Number(candidate.stack) || 0),
        })),
      previousZone,
    });
    this.horseTournamentMZones.set(player.user_id, m.zone);
    const horseRecoveryCap =
      tctx?.horseRebuyCapByUser &&
      Object.prototype.hasOwnProperty.call(tctx.horseRebuyCapByUser, player.user_id)
        ? tctx.horseRebuyCapByUser[player.user_id]
        : null;

    return {
      // Tournament metadata may name a Spin/MTT/HU structure only after the
      // complete-context contract holds. Otherwise use the local seat-shape
      // fallback so a stale remote label cannot widen ranges.
      format: contextStatus === 'complete' ? (tctx?.format ?? fallbackFormat) : fallbackFormat,
      tournament: {
        schemaVersion: 1,
        contextStatus,
        contextIssues: [...new Set(localIssues)],
        sourceAgeMs: snapshot.ageMs,
        tournamentId: tid || null,
        tournamentType: tctx?.tournamentType ?? '',
        tournamentStatus: tctx?.tournamentStatus ?? '',
        // The current hand can carry an authoritative bomb-pot/rotation
        // override. Tournament metadata describes the event's base game; the
        // decision contract must describe the cards actually dealt now.
        gameVariant: activeVariant,
        entrants: tctx?.entrants ?? 0,
        nearBubble: tctx?.nearBubble ?? false,
        inMoney: tctx?.inMoney ?? false,
        playersLeft: tctx?.playersLeft ?? 0,
        spotsPaid: tctx?.spotsPaid ?? 0,
        avgStackChips: tctx?.avgStackChips ?? 0,
        medianStackChips: tctx?.medianStackChips ?? 0,
        // An invalid cached capacity is one reason a snapshot is incomplete;
        // do not repeat that invalid coordinate into the worker boundary.
        seatsPerTable:
          contextStatus === 'complete'
            ? (tctx?.seatsPerTable ?? localSeatsPerTable)
            : localSeatsPerTable,
        playersAtTable,
        currentLevel: tctx?.currentLevel ?? 0,
        currentSmallBlind,
        currentBigBlind,
        currentAnte,
        anteType,
        nextSmallBlind: contextStatus === 'complete' ? (tctx?.nextSmallBlind ?? null) : null,
        nextBigBlind: contextStatus === 'complete' ? (tctx?.nextBigBlind ?? null) : null,
        nextAnte: contextStatus === 'complete' ? (tctx?.nextAnte ?? null) : null,
        levelDurationMin: tctx?.levelDurationMin ?? null,
        levelElapsedMin: tctx?.levelElapsedMin ?? null,
        registrationOpen: tctx?.registrationOpen ?? false,
        lateRegistrationOpen: tctx?.lateRegistrationOpen ?? false,
        registrationRequiresAuthorization: tctx?.registrationRequiresAuthorization ?? false,
        isPko: tctx?.isPko ?? false,
        isBounty: tctx?.isBounty ?? false,
        isMysteryBounty: tctx?.isMysteryBounty ?? false,
        mysteryBountyStage: tctx?.mysteryBountyStage ?? 'none',
        reentryAllowed: tctx?.reentryAllowed ?? false,
        reentryOpen: tctx?.reentryOpen ?? false,
        maxReentries:
          tctx?.reentryAllowed === true && tctx.rebuyAllowed !== true && horseRecoveryCap !== null
            ? horseRecoveryCap
            : (tctx?.maxReentries ?? null),
        rebuyAllowed: tctx?.rebuyAllowed ?? false,
        rebuyOpen: tctx?.rebuyOpen ?? false,
        maxRebuys:
          tctx?.rebuyAllowed === true && horseRecoveryCap !== null
            ? horseRecoveryCap
            : (tctx?.maxRebuys ?? null),
        addOnAvailable: tctx?.addOnAvailable ?? false,
        addOnPeriodOpen: tctx?.addOnPeriodOpen ?? false,
        addOnCost: tctx?.addOnCost ?? null,
        addOnChips: tctx?.addOnChips ?? null,
        addOnLevels: tctx?.addOnLevels ?? null,
        onBreak: tctx?.onBreak ?? false,
        handForHand: this.handForHandPaused,
        handForHandExpected: tctx?.handForHandExpected ?? false,
        m,
        bountyFactor: tctx?.bountyFactor ?? 0,
        // V16 ICM: the payout curve + live stack distribution feed the real
        // Malmuth-Harville pressure model in HorseLogic.icmRisk.
        stacks: tctx?.stacks ?? [],
        // Keep only this table's identities on the worker message. Phase 7
        // uses them to remove the cached local stack values exactly before it
        // substitutes the authoritative in-hand values; remote identities are
        // unnecessary for ICM and never cross the action boundary.
        stackByUser: Object.fromEntries(
          players.flatMap((candidate) => {
            const observed = tctx?.stackByUser?.[candidate.user_id];
            return Number.isFinite(observed) && (observed as number) > 0
              ? [[candidate.user_id, observed as number]]
              : [];
          })
        ),
        payoutPct: tctx?.payoutPct ?? [],
        // V26 PRIZE LANDSCAPE: what a bust is actually worth right now -
        // how many chests are left, their mean, and whether the big one is
        // still in the box.
        mysteryChestsLeft: tctx?.mysteryChestsLeft ?? 0,
        mysteryMeanCents: tctx?.mysteryMeanCents ?? 0,
        mysteryTopCents: tctx?.mysteryTopCents ?? 0,
        mysteryTopLive: tctx?.mysteryTopLive ?? false,
        meanBountyCents: tctx?.meanBountyCents ?? 0,
        prizePoolCents: tctx?.prizePoolCents ?? 0,
        bountyPoolCents: tctx?.bountyPoolCents ?? 0,
        buyInCents: tctx?.buyInCents ?? null,
        startingStackChips: tctx?.startingStackChips ?? null,
        rebuyCostCents: tctx?.rebuyCostCents ?? null,
        rebuyChips: tctx?.rebuyChips ?? null,
        rebuyPrizeContributionCents: tctx?.rebuyPrizeContributionCents ?? null,
        rebuyBountyContributionCents: tctx?.rebuyBountyContributionCents ?? null,
        reloadsUsed:
          tctx?.reloadsByUser &&
          Object.prototype.hasOwnProperty.call(tctx.reloadsByUser, player.user_id)
            ? tctx.reloadsByUser[player.user_id]
            : null,
        addOnTaken:
          tctx?.addOnTakenByUser &&
          Object.prototype.hasOwnProperty.call(tctx.addOnTakenByUser, player.user_id)
            ? tctx.addOnTakenByUser[player.user_id]
            : null,
        rebuyAffordable:
          tctx?.rebuyAffordableByUser &&
          Object.prototype.hasOwnProperty.call(tctx.rebuyAffordableByUser, player.user_id)
            ? tctx.rebuyAffordableByUser[player.user_id]
            : null,
        addOnAffordable:
          tctx?.addOnAffordableByUser &&
          Object.prototype.hasOwnProperty.call(tctx.addOnAffordableByUser, player.user_id)
            ? tctx.addOnAffordableByUser[player.user_id]
            : null,
        // V23 ENDGAME: final-table flag + the blind clock (jam BEFORE the
        // blinds halve the M, not after).
        finalTable: tctx?.finalTable ?? false,
        nextBlindInMin: contextStatus === 'complete' ? (tctx?.nextBlindInMin ?? null) : null,
        nextBlindMult: contextStatus === 'complete' ? (tctx?.nextBlindMult ?? 1) : 1,
        // V37 SATELLITES: identical tickets to the top N. The brain plays
        // survival, not a ladder — see HorseLogic.satelliteRead.
        satellite: tctx?.satellite ?? false,
        satelliteSeats: tctx?.satelliteSeats ?? 0,
        // V37 BOUNTIES: whose head is worth what, this hand.
        bountyByUser: tctx?.bountyByUser ?? {},
      },
    };
  }

  /**
   * THE HORSE'S ACTION RELEASES ITS CLOCKS THE WAY A HUMAN'S DOES (2026-09-11).
   *
   * `_handlePlayerActionInner` does four things around performAction that the
   * horse path, which calls performAction directly, never did:
   *   - cancels the seat's own `turn:<uid>` deadline;
   *   - `timeBankEngine.playerActed` when a bank was spent or armed this turn;
   *   - `disconnectEngine.recordPlayerActed` (strikes to zero, everActed);
   *   - `engineTelemetry.recordTimerActed`.
   *
   * Measured on the live fleet, 60 minutes to 13:27 UTC 2026-09-11, zero
   * humans seated: 67 lines of "Time bank expiry: FSM in 'timer_running' but
   * seat N is still current - resolving anyway". That line has exactly one
   * route: a `timebank:<uid>` deadline armed by the auto-activation on a
   * PREVIOUS turn of the same seat, never released because the horse acted
   * without `playerActed`, firing 20 s later while the seat is on the clock
   * again. Each fire forced a check/fold over the horse's real decision
   * (`forceResolveSeat` cancels the pending think timer first), counted a
   * strike via `recordConnectedTimeout`, and left `bank.isActive` true so the
   * horse's next deliberate bank burn hit 'already_active' and auto-folded at
   * 17 s with its answer discarded. Strikes never reset (no
   * `recordPlayerActed`), so three orphans at one table forced a sit-out:
   * `engine_presence_parked` at the 14:55 park carried 12 horses SAT_OUT
   * 'forced' and 257 horse entries with strikes, and nothing ever sits a
   * horse back in. That is the input device denying a horse what a human
   * gets (CLAUDE.md 10.5), one call at a time. Same bookkeeping, same order.
   *
   * Runs only after an action LANDED: on the triple-rejection path the
   * ordinary clock must stay armed so the seat still auto-resolves at 17 s.
   */
  /**
   * A seated horse whose turn the CLOCK resolved. The counter behind Dan's
   * 2026-09-11 "tell me if the horses can't play": a horse has no browser, so
   * a timeout at its seat is the input device failing, never a person away
   * from the keyboard. Fleet-wide, no table label (always-on registry).
   */
  protected noteHorseTurnTimeout(userId: string, kind: 'timer' | 'timebank'): void {
    try {
      if (!this.seatedPlayers.find((p) => p.user_id === userId)?.is_horse) return;
      EngineMetrics.horseTurnTimeoutsTotal.inc(1, { kind });
    } catch {
      /* metrics must never affect gameplay */
    }
  }

  protected settleHorseSeatActed(userId: string): void {
    try {
      this.preciseTimer.cancelTimer(this.tableId, userId);
      if (this.timeBankActivatedThisTurn || this.timeBankEngine.isArmed(this.tableId, userId)) {
        this.timeBankEngine.playerActed(this.tableId, userId);
      }
      this.disconnectEngine.recordPlayerActed(this.tableId, userId);
      this.engineTelemetry.recordTimerActed(this.tableId);
    } catch (err) {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.horse_seat_settle_threw');
    }
  }

  protected scheduleHorseAction(
    player: SeatedPlayer,
    seat: number,
    enginePlayer: any,
    _state: {
      currentBet: number;
      minRaise: number;
      pot: number;
      communityCards: any[];
      players: any[];
      stage: HandStage;
    }
  ): void {
    // One turn owns one worker request, optional deep replay and action timer.
    // Cancel the previous set as a unit before publishing a new local fence.
    this.cancelHorseDecisionWork();
    const turnToken = this.horseTurnToken;
    const abortController = new AbortController();
    this.horseDecisionAbortController = abortController;
    const decisionTimeMs = Date.now();
    const handNumber = this.handCount;
    const handControllerRef = this.handController;
    const leaseAtRequest = this.getEngineLeaseAuthority();
    const leaseGeneration = leaseAtRequest?.verified ? leaseAtRequest.generation : null;
    const fence = [this.tableId, handNumber, seat, leaseGeneration ?? 'unverified', turnToken].join(
      ':'
    );
    let pendingUtilityLedger: HorseDecision['tournamentUtility'];
    let pendingPostflopLedger: HorseDecision['tournamentPostflop'];
    let pendingPlo4Ledger: HorseDecision['plo4Policy'];
    let pendingOmahaLedger: HorseDecision['omahaVariantPolicy'];
    let pendingRemainingLedger: HorseDecision['remainingVariantPolicy'];
    let pendingJointLedger: HorseDecision['jointPolicy'];
    let pendingExecutionWitness: HorseDecision['executionWitness'];

    const retireUtility = (ledger: HorseDecision['tournamentUtility']): void => {
      if (ledger?.executionStatus === 'pending') {
        ledger.executedAction = null;
        ledger.executedAmount = null;
        ledger.executionStatus = 'not_executed';
        noteFire('phase7_utility_not_executed');
      }
    };
    const retirePostflop = (ledger: HorseDecision['tournamentPostflop']): void => {
      if (ledger?.executionStatus === 'pending') {
        ledger.executionStatus = 'not_executed';
        noteFire('phase8_execution_not_executed');
      }
    };
    const retirePlo4 = (ledger: HorseDecision['plo4Policy']): void => {
      if (ledger?.executionStatus === 'pending') {
        ledger.executionStatus = 'not_executed';
        noteFire('phase10_execution_not_executed');
      }
    };
    const retireOmaha = (ledger: HorseDecision['omahaVariantPolicy']): void => {
      if (ledger?.executionStatus === 'pending') {
        ledger.executionStatus = 'not_executed';
        noteFire('phase11_execution_not_executed');
        noteFire(`phase11_${ledger.variant}_execution_not_executed`);
      }
    };
    const retireRemaining = (ledger: HorseDecision['remainingVariantPolicy']): void => {
      if (ledger?.executionStatus === 'pending') {
        ledger.executionStatus = 'not_executed';
        noteFire('phase12_execution_not_executed');
        noteFire(`phase12_${ledger.variant}_execution_not_executed`);
      }
    };
    const retireJoint = (ledger: HorseDecision['jointPolicy']): void => {
      if (ledger?.executionStatus === 'pending') {
        ledger.executionStatus = 'not_executed';
        noteFire('phase13_execution_not_executed');
        noteFire(`phase13_${ledger.variant}_execution_not_executed`);
      }
    };
    const markPendingUtilityNotExecuted = (): void => {
      retireHorseExecutionWitness(pendingExecutionWitness, 'turn_abandoned');
      retireUtility(pendingUtilityLedger);
      retirePostflop(pendingPostflopLedger);
      retirePlo4(pendingPlo4Ledger);
      retireOmaha(pendingOmahaLedger);
      retireRemaining(pendingRemainingLedger);
      retireJoint(pendingJointLedger);
    };
    const retireDecision = (
      decision: HorseDecision,
      reason: HorseExecutionRetirement = 'response_fence'
    ): void => {
      retireHorseExecutionWitness(decision.executionWitness, reason);
      retireUtility(decision.tournamentUtility);
      retirePostflop(decision.tournamentPostflop);
      retirePlo4(decision.plo4Policy);
      retireOmaha(decision.omahaVariantPolicy);
      retireRemaining(decision.remainingVariantPolicy);
      retireJoint(decision.jointPolicy);
    };
    // Cancellation clears the action timer, so no future fence check can
    // retire an already-returned decision. The turn owns its receipts until
    // cancellation or until the executor explicitly takes ownership below.
    abortController.signal.addEventListener('abort', markPendingUtilityNotExecuted, { once: true });

    /* WHY the fence refused, not merely that it did.
       Six stages guard on this, and until 2026-09-11 every one of them
       answered a failure with a bare `return`. A horse whose table lost its
       engine lease mid-turn was therefore never scheduled, never asked the
       worker for anything, and appeared in no counter anywhere - the
       seventeen-second clock resolved its seat as a forced check/fold while
       every decision-path gauge read perfect. Measured that evening: fallbacks
       0 and the worker idle at 4.9 ms compute, while timer timeouts ran 19-40
       a minute beside 1,652 engine lease losses a minute across 1,570 tables.
       The checks below are unchanged and in the same order; only their silence
       is. */
    const fenceRefusal = (): HorseTurnAbandonReason | null => {
      if (abortController.signal.aborted) return 'aborted';
      if (
        this.horseDecisionAbortController !== abortController ||
        this.horseTurnToken !== turnToken
      ) {
        return 'superseded';
      }
      if (
        !handControllerRef ||
        handControllerRef !== this.handController ||
        this.handCount !== handNumber
      ) {
        return 'hand_replaced';
      }
      if (!this.lifecycleCanMutate()) return 'lifecycle_locked';
      if (handControllerRef.getState().currentPlayerSeat !== seat) return 'seat_moved';
      const currentLease = this.getEngineLeaseAuthority();
      if (
        leaseGeneration === null ||
        currentLease?.verified !== true ||
        currentLease.generation !== leaseGeneration
      ) {
        return 'lease_lost';
      }
      return null;
    };

    const fenceIsCurrent = (stage: HorseTurnAbandonStage): boolean => {
      const reason = fenceRefusal();
      if (reason === null) return true;
      markPendingUtilityNotExecuted();
      try {
        EngineMetrics.horseTurnsAbandonedTotal.inc(1, { reason, stage });
      } catch {
        /* metrics must never affect gameplay */
      }
      return false;
    };

    if (!fenceIsCurrent('schedule')) {
      this.cancelHorseDecisionWork();
      return;
    }

    // Phase 5 Round 1: read the controller ONCE after the authority fence. The
    // callback's reduced argument is useful for dispatch, but is not the
    // canonical decision state and must not be the source of poker rules.
    if (!handControllerRef) return;
    const state = handControllerRef.getState();
    const authoritativePlayer = state.players.find((candidate) => candidate.seat === seat);
    const controllerActions = handControllerRef.getAuthoritativeActionState(player.user_id);
    if (!authoritativePlayer || !controllerActions || !controllerActions.canAct) {
      reportError(
        new Error('Current horse seat has no authoritative decision state'),
        'ServerTableEngine.' + this.tableId + '.horse_state_missing'
      );
      this.cancelHorseDecisionWork();
      return;
    }
    const boundedActions = applyAllInOrFoldActionState(
      applyTableCommitmentCap(
        controllerActions,
        authoritativePlayer,
        this.tableInfo?.cap_enabled === true,
        Number(this.tableInfo?.cap_bb) || 0,
        Number(this.tableInfo?.big_blind) || 0
      ),
      this.tableInfo?.all_in_or_fold === true,
      state.stage
    );
    const toCall = boundedActions.toCall;
    const contestablePot = handControllerRef.getContestablePotForCall(player.user_id);
    if (contestablePot === null) {
      reportError(
        new Error('Current horse seat has no contestable-pot state'),
        'ServerTableEngine.' + this.tableId + '.horse_contestable_pot_missing'
      );
      this.cancelHorseDecisionWork();
      return;
    }

    // AUDIT V2 (2026-07-23): horse_profile is a jsonb column — in production it
    // was {} for every horse, so the old styleMap[object] lookup ALWAYS fell
    // back to 'balanced' and all 574 horses played the identical style.
    // resolveHorseStyle handles strings, jsonb objects, and hashes the horse id
    // as a deterministic fallback so the fleet stays diverse no matter what.
    const { style: horseStyle, mods: horseMods } = resolveHorseStyle(
      player.horse_profile,
      player.user_id
    );

    const activeVariant = this.activeHandVariant() || 'nlh';
    const decisionPlayer: SeatPlayer = {
      ...authoritativePlayer,
      cards: [...authoritativePlayer.cards],
      knownDeadCards:
        activeVariant === 'pineapple'
          ? handControllerRef.getPineappleKnownDeadCards(authoritativePlayer.seat)
          : [],
      is_sitting_out:
        authoritativePlayer.is_sitting_out === true ||
        this.disconnectEngine.isSittingOut(this.tableId, authoritativePlayer.user_id),
    };
    const publicPlayers: SeatPlayer[] = state.players.map((candidate) => {
      const { knownDeadCards: _privateDeadCards, ...publicCandidate } = candidate;
      return {
        ...publicCandidate,
        // HIDDEN-INFORMATION FIREWALL: every seat in the shared state is public
        // only. Hero's private cards exist exactly once, on decisionPlayer.
        cards: [],
        is_sitting_out:
          candidate.is_sitting_out === true ||
          (!candidate.is_all_in &&
            this.disconnectEngine.isSittingOut(this.tableId, candidate.user_id)),
      };
    });
    const gameState: HorseGameStateV2 = {
      stateSchemaVersion: 1,
      dealtSeatIds: state.players
        .filter((candidate) => candidate.cards.length > 0)
        .map((candidate) => candidate.seat)
        .sort((a, b) => a - b),
      ...handControllerRef.getChipRulesSnapshot(),
      heroSeat: boundedActions.heroSeat,
      currentPlayerSeat: boundedActions.currentPlayerSeat,
      legalActions: [...boundedActions.legalActions],
      toCall: boundedActions.toCall,
      minRaiseTo: boundedActions.minRaiseTo,
      maxRaiseTo: boundedActions.maxRaiseTo,
      bettingStructure: boundedActions.structure,
      fixedBetSize: boundedActions.fixedBetSize,
      wagersCapped: boundedActions.wagersCapped,
      commitmentCapRemaining: boundedActions.commitmentCapRemaining,
      pots: handControllerRef
        .computeLivePots()
        .map((pot) => ({ ...pot, eligiblePlayers: [...pot.eligiblePlayers] })),
      contestablePot,
      rakeConfig: handControllerRef.getRakeConfigSnapshot(),
      variantRules: horseVariantRulesFor(activeVariant),
      // V28 AUDIT FIX (2026-08-29): is_sitting_out was hardcoded false at the
      // deal (correctly, for HandController's purposes), which made EVERY
      // !is_sitting_out filter in the brain inert — oppsLeft, tableSize,
      // classifyPosition and the postflop opponent count all counted a
      // blinding-off seat as a live opponent. At a 3-handed final table with
      // one player disconnected, the heads-up branches never fired: the SB
      // opened on 0.44 instead of 0.24. The engine has the truth in
      // DisconnectEngine; stamp it onto the copy the brain reads.
      players: publicPlayers,
      communityCards: [...state.communityCards],
      // MULTI-BOARD EQUITY 2026-08-28 (Horses Are Players law): on a
      // double/triple-board bomb hand the fleet prices EVERY board — the
      // brain averages per-board equity, exactly what the pot pays on.
      communityCards2: [...(state.communityCards2 ?? [])],
      communityCards3: [...(state.communityCards3 ?? [])],
      // BOMB POTS 2026-09-02 (V36): tell the brain this hand is a bomb pot.
      // Every range at the table is RANDOM (there was no preflop street to
      // narrow it), the pot is antes, and on a multi-board hand every pot
      // layer splits per board. The brain used to infer "multi-board" from
      // communityCards2 and could not see a single-board bomb pot at all -
      // so it consulted hold'em solver cells built for single-raised-pot
      // ranges, and read a first-to-act bettor as the preflop aggressor.
      bombPot: this.currentHandBombPot != null,
      boardCount: handControllerRef.getActiveBoardCount(),
      pot: state.pot,
      currentBet: state.currentBet,
      minRaise: state.minRaise,
      stage: state.stage,
      // VARIANT OVERRIDE 2026-08-28: horses evaluate the hand they were DEALT
      // — PLO equity on a PLO bomb hand, whatever the table's label says.
      gameVariant: activeVariant,
      bigBlind: this.tableInfo?.big_blind || 2,
      // AUDIT V2: position + action context for the V2 decision engine
      dealerSeat: state.dealerSeat ?? this.currentHandDealerSeat,
      lastRaise: state.lastRaise,
      actionHistory: state.actionHistory.map((action) => ({ ...action })),
      // V11 (Dan 2026-08-22): cash and tournaments are DIFFERENT games. Tell
      // the brain EXPLICITLY which one this is (it was guessing from blind
      // size) plus the ante, so preflop ranges, ICM pressure, push/fold
      // tiers, and rake-aware pot odds all switch on the real game mode.
      gameMode: this.isTournamentTable() ? ('tournament' as const) : ('cash' as const),
      ante: this.tableInfo?.ante || 0,
      // Which ante STYLE — the brain's M depends on what an orbit costs, and
      // a big blind ante costs the table one ante per orbit, not one each.
      bigBlindAnte: this.tableInfo?.big_blind_ante_enabled === true,
      // AoF: tell the brain, instead of rewriting its answer afterwards. The
      // coercion below stays as the legality guarantee.
      allInOrFold: this.tableInfo?.all_in_or_fold === true,
      // THE VPIP FLOOR (Dan 2026-09-04). A floored table stands a seat up
      // after ten hands under the floor, horses included (10.5). The brain
      // gets the floor and ITS OWN judged figure - the same numbers the
      // eviction reads - and widens toward the floor like a regular would.
      vpipFloor: this.vpipFloor(),
      ownVpip: (() => {
        const row = this.nitStatus.get(authoritativePlayer.user_id);
        return row ? { hands: row.hands, vpip: row.vpip } : undefined;
      })(),
      // V18 STRADDLE (2026-08-26): straddle posts are not ActionRecords, so
      // a straddled pot's preflop currentBet (2xBB) with an empty history
      // read as an OPEN RAISE and the fleet folded to dead money. Tell the
      // brain straddles are possible here.
      straddleActive: this.tableInfo?.straddle_enabled === true,
      // Phase 6: complete cached tournament metadata plus exact local blinds,
      // seats, stacks, hand-for-hand state and the hero's M snapshot.
      ...this.horseTournamentContext(
        decisionPlayer,
        publicPlayers,
        state.dealerSeat ?? this.currentHandDealerSeat,
        activeVariant
      ),
    };

    // The shared builder binds every decision-affecting input and is repeated
    // at the worker boundary. Worker timing and boot entropy never enter it;
    // private opponent cards were removed before gameState was constructed.
    const decisionSnapshot: LiveHorseDecisionSnapshot = {
      generation: turnToken,
      fence,
      decisionKey: '',
      decisionTimeMs,
      player: decisionPlayer,
      gameState,
      style: horseStyle,
      mods: horseMods,
    };
    decisionSnapshot.decisionKey = buildHorseDecisionKey(decisionSnapshot);

    // ROOT-CAUSE CAPACITY FIX (2026-09-08). HorseLogic is CPU-heavy and owns
    // process-global RNG, opponent memory and solver stores. Running it in
    // every table's turn callback pinned the authoritative event loop at the
    // governor floor, delaying broadcasts, timers and subsequent hands. The
    // one process-wide worker FIFO is now the sole live owner of those mutable
    // resources. There is deliberately no synchronous HorseLogic fallback.
    let fastDecision: Promise<FastHorseDecisionResult>;
    try {
      fastDecision = getLiveHorseDecisionWorker().decideFast(
        decisionSnapshot,
        abortController.signal
      );
    } catch (error) {
      fastDecision = Promise.reject(error);
    }

    void fastDecision
      .catch((error): FastHorseDecisionResult => {
        if (error instanceof HorseDecisionAbortedError || abortController.signal.aborted) {
          throw error;
        }
        reportError(error, 'ServerTableEngine.' + this.tableId + '.horse_decision_worker_failed');
        if (!fenceIsCurrent('fallback')) throw new HorseDecisionAbortedError();
        try {
          EngineMetrics.horseDecisionFallbacksTotal.inc(1);
        } catch {
          /* metrics must never affect gameplay */
        }

        // A single failed job must not strand a live seat. This is only the
        // legal liveness action for the already-authoritative turn; it does not
        // compute poker strategy and cannot hide a dead worker. Terminal worker
        // failure is separately process-fatal at the GameServer lifecycle.
        const safeDecision: HorseDecision = {
          action: toCall > 0 ? 'fold' : 'check',
          thinkTime: 0,
        };
        safeDecision.executionWitness = createHorseExecutionWitness(
          decisionSnapshot,
          safeDecision,
          {
            requestId: -1,
            lane: 'worker_fallback',
            computeMs: 0,
            governorScale: 0,
          }
        );
        return {
          type: 'FAST_RESULT',
          requestId: -1,
          generation: turnToken,
          fence,
          decision: safeDecision,
          rngBefore: 0,
          rngAfter: 0,
          computeMs: 0,
          governorScale: 0,
          effects: [],
        };
      })
      .then((fastResult) => {
        // Own the returned receipts before validating the response fence. A
        // rejected early result never acts, but its analysis must be retired
        // just like a result rejected later during the think-time window.
        let decision = fastResult.decision;
        pendingUtilityLedger = decision.tournamentUtility;
        pendingPostflopLedger = decision.tournamentPostflop;
        pendingPlo4Ledger = decision.plo4Policy;
        pendingOmahaLedger = decision.omahaVariantPolicy;
        pendingRemainingLedger = decision.remainingVariantPolicy;
        pendingJointLedger = decision.jointPolicy;
        pendingExecutionWitness = decision.executionWitness;
        if (
          fastResult.generation !== turnToken ||
          fastResult.fence !== fence ||
          !fenceIsCurrent('fast_result')
        ) {
          retireHorseExecutionWitness(pendingExecutionWitness, 'response_fence');
          markPendingUtilityNotExecuted();
          return;
        }

        // Humanlike think time comes from the decision engine itself (style- and
        // situation-aware, 0.7-8s). Clamp inside the table's action timer window.
        //
        // ── Dan 2026-08-20: "it doesn't matter if it's all horses at the table,
        //    every action, every animation, every feature and detail needs to play
        //    out in full. Each turn to check/bet/call/fold, every action needs
        //    time, nothing can EVER be skipped." ──
        //
        // HISTORY, kept because it explains what replaced it: this used to impose
        // a hard think-time floor so that no action could be fast enough to clip
        // its own animation. The animation concern was real, but the floor was the
        // wrong instrument - the settle beat in the TURN_CHANGE handler is what
        // actually guarantees an action gets airtime, and it applies to human
        // actions too. The floor only flattened the horses' timing, which is what
        // Dan reported on 2026-08-23.
        // Dan 2026-08-20: "THE GAME SPEED NEEDS TO SLOW DOWN TO FEEL MORE REAL.
        // Focus more on the user experience rather than getting more hands dealt."
        // Raised 1800 -> 2200. A live dealer's table does not fire an action every
        // second and a half; the extra beat is what makes a horse read as a person
        // thinking rather than a script executing. This is ON TOP of the 650ms
        // settle every action now gets in the TURN_CHANGE handler, so the slowest
        // visible cadence per seat is ~2.85s and the fastest is never instant.
        // ── V14 TEMPO (Dan 2026-08-23, binding) ────────────────────────────────
        // "TIMING ON STREETS MUST BE MORE RANDOM... completely random, from
        //  instant, to full 15 seconds or even using time banks."
        //
        // The 2200ms floor above was the single biggest reason the fleet felt
        // scripted. HorseLogic already produced a spread, and this clamped the
        // whole fast half of it onto ONE NUMBER - so seat after seat acted at
        // exactly 2.2 seconds. Removing it is the point of this change; the
        // 650ms settle in the TURN_CHANGE handler still keeps a snap from being
        // literally instantaneous.
        //
        // This supersedes the 2026-08-20 note above it. That instruction was
        // "slow the game down so it feels real"; this one is "make the timing
        // genuinely random", and a uniform slow cadence is just a slower script.
        const actionTimeMs = (this.tableInfo?.action_time_seconds || 15) * 1000;
        const requested = decision.thinkTime || 2500;
        const safeWorkerFallback = fastResult.requestId === -1;
        let thinkTimeMs: number;
        // V28 AUDIT FIX (2026-08-29): the sentinel path scheduled the action PAST
        // the turn clock with no check that a bank existed to catch it. A horse's
        // bank is 2 uses per session, never refilled - after both were spent,
        // primary-timer expiry auto-folded the seat, the real decision fired into
        // currentPlayerSeat !== seat and was silently discarded. The horse that
        // decided to CALL a big river bet visibly timed out and folded - the one
        // behaviour a human at the table cannot fail to notice. Bank mode fires
        // on 1-6% of decisions, weighted toward exactly those big river spots.
        // Same shape when time_bank is disabled table-wide, and when the last
        // bank has fewer seconds left than the planned burn. So: burn the bank
        // ONLY when a full activation is genuinely available; otherwise the tank
        // stays inside the ordinary clock.
        //
        // 2026-09-09: this gate used to be a HAND-WRITTEN copy of the engine's
        // rules - table switch, `usesRemaining !== 0`, enough seconds - and it
        // was missing the per-street cap (`streetActivations >= 2`), which is
        // the refusal `tryActivate` gives on a THIRD bank-mode draw for one
        // seat on one street. When that happened the horse scheduled past the
        // turn clock exactly as this note says it must not, the auto-activation
        // was refused, forceResolveSeat auto-folded the seat, and the real
        // decision was discarded when it finally fired - the V28 failure again,
        // through the one rule the copy did not carry. Ask the engine, so the
        // gate cannot drift from the refusals a second time.
        const bank = this.timeBankEngine?.getPlayerBank?.(this.tableId, player.user_id);
        // 2026-09-11: mirror EVERY refusal tryActivate can return, not only
        // 'depleted'. A bank still counting down from this seat's previous
        // turn ('already_active') or a street that has spent both activations
        // ('street_limit') refuses the auto-activation at 17 s, and the seat
        // is auto-folded with its real answer still in the think timer.
        //
        // These three conditions are pinned BY SOURCE TEXT in
        // aHorseActionReleasesItsClocks.test.ts ("the bank-burn plan mirrors
        // every refusal tryActivate can return"), so the list stays spelled out
        // here rather than delegated. `TimeBankEngine.activationRefusal()` is
        // the same list expressed once and is what `tryActivate` itself now
        // asks; if this gate is ever moved onto it, move that pin in the same
        // commit.
        const bankUsable =
          this.tableInfo?.time_bank_enabled !== false &&
          bank != null &&
          (bank as { isActive?: boolean }).isActive !== true &&
          ((bank as { streetActivations?: number }).streetActivations ?? 0) < 2 &&
          (bank as { usesRemaining?: number }).usesRemaining !== 0 &&
          ((bank as { remainingSeconds?: number }).remainingSeconds ?? 0) * 1000 >
            ServerTableEngineTurns.HORSE_MAX_BANK_BURN_MS + 2000;
        if (safeWorkerFallback) {
          // The queue-plus-compute deadline has already consumed the worker's
          // entire budget. A check/fold fallback is a liveness action, not a
          // poker decision, so do not strand the current turn behind another
          // ordinary think timer after the worker has expired.
          thinkTimeMs = 0;
        } else if (requested >= HorseLogic.THINK_TIMEBANK_SENTINEL && bankUsable) {
          // A deliberate TIME BANK burn. Let the turn clock expire - the engine
          // auto-activates the bank on primary-timer expiry (Bible V8 6.2) - then
          // act a few seconds into it. Bounded well inside the granted bank so a
          // tank can never become an auto-fold.
          const intoBank = 2000 + (requested - HorseLogic.THINK_TIMEBANK_SENTINEL) * 0.55;
          thinkTimeMs = Math.round(
            actionTimeMs + Math.min(intoBank, ServerTableEngineTurns.HORSE_MAX_BANK_BURN_MS)
          );
        } else if (requested >= HorseLogic.THINK_TIMEBANK_SENTINEL) {
          // Bank mode chosen but no bank to burn: the longest legal ordinary tank.
          thinkTimeMs = Math.round(Math.max(2000, actionTimeMs - 1500));
        } else {
          // Everything else must land inside the ordinary clock, with a small
          // margin so a genuine tank still acts rather than timing out.
          //
          // V35 SOFT CAP (2026-09-02): this was `Math.min(requested, cap)`, the
          // mirror of the floor clamp fixed in HorseLogic's computeThinkTime, and
          // it fingerprints the same way at the other end. TANK draws run to
          // ~10.8s before shaping and past 14.8s at p95 after it, while the cap on
          // a 15s clock is 13,800ms - so every one of those long tanks landed on
          // EXACTLY 13800. A recurring exact maximum is as identifying as a
          // recurring exact minimum, and it is concentrated in precisely the big
          // river spots a suspicious opponent is already watching.
          //
          // A tank that wants more time than the clock allows now backs off the
          // cap by a short exponential instead of sitting on it. Still inside the
          // clock, still visibly a tank, no longer the same number every time.
          const cap = Math.max(2000, actionTimeMs - 1200);
          if (requested <= cap) {
            thinkTimeMs = Math.round(Math.max(250, requested));
          } else {
            const u = Math.max(1e-6, 1 - Math.random());
            const backoff = Math.min(-Math.log(u) * 900, Math.max(0, cap - 2500));
            thinkTimeMs = Math.round(Math.max(250, cap - backoff));
          }
        }

        // Worker queue/computation is part of the horse's visible think time.
        // A loaded process must never add compute delay on top of the selected
        // cadence or let a stale answer fire after the authoritative clock.
        const remainingThinkMs = Math.max(0, thinkTimeMs - (Date.now() - decisionTimeMs));

        // ═══ V44 SECOND LOOK (2026-09-05) ═══════════════════════════════════════
        // The fast decision above ran its Monte Carlo at 120-450 iterations to
        // stay under 15 ms, and the horse is now going to sit for `thinkTimeMs`
        // doing nothing. On a CLOSE spot - facing a bet in a pot worth reading,
        // with time to think - the same decision is replayed at six times the
        // sample, from the same strategy dice, a few hundred milliseconds into
        // the think time. If the deeper read lands on a different call/fold/
        // all-in, the deeper read acts. Sizing decisions and checks are left
        // alone: the sample is not what decides them.
        //
        // Cost: PLO6 at 6x is ~40 ms of CPU, on perhaps one decision in twenty.
        // The equity governor still applies inside the replay, so a saturated
        // loop runs the second look at whatever the floor allows; and it is
        // skipped outright when the governor is already scaling down.
        const secondLook = ServerTableEngineTurns.secondLookPlan(
          decision,
          toCall,
          state.pot,
          this.tableInfo?.big_blind || 2,
          remainingThinkMs,
          fastResult.governorScale
        );
        if (!secondLook.ok) {
          // One receipt per declined decision, naming the gate that closed. See
          // secondLookPlan for why a bare null was not good enough.
          noteSecondLookDecline(secondLook.reason);
        }
        if (secondLook.ok) {
          this.horseSecondLookTimer = setTimeout(() => {
            this.horseSecondLookTimer = null;
            if (!fenceIsCurrent('deep_start')) return;
            void getLiveHorseDecisionWorker()
              .decideDeep(
                {
                  ...decisionSnapshot,
                  rngBefore: fastResult.rngBefore,
                  deepEquity: ServerTableEngineTurns.SECOND_LOOK_DEPTH,
                },
                abortController.signal
              )
              .then((deepResult) => {
                if (
                  deepResult.generation !== turnToken ||
                  deepResult.fence !== fence ||
                  !fenceIsCurrent('deep_result')
                ) {
                  retireDecision(deepResult.decision);
                  return;
                }
                if (deepResult.decision.policyFallback === 'brain_exception') {
                  retireDecision(deepResult.decision, 'brain_exception');
                  noteFire('phase15_deep_brain_exception_retired');
                  return;
                }
                const verdict = ServerTableEngineTurns.secondLookVerdict(
                  decision,
                  deepResult.decision
                );
                if (verdict) {
                  noteFire('v44_second_look_flipped');
                  retireHorseExecutionWitness(pendingExecutionWitness, 'second_look_replaced');
                  markPendingUtilityNotExecuted();
                  decision = {
                    // The deep replay owns the Phase 7 utility receipt too.
                    // Keeping the fast object while changing only its action
                    // made the ledger claim a different selected action from
                    // the one the table was about to execute.
                    ...deepResult.decision,
                    action: verdict.action as ActionType,
                    amount: verdict.amount,
                    thinkTime: decision.thinkTime,
                  };
                  pendingUtilityLedger = decision.tournamentUtility;
                  pendingPostflopLedger = decision.tournamentPostflop;
                  pendingPlo4Ledger = decision.plo4Policy;
                  pendingOmahaLedger = decision.omahaVariantPolicy;
                  pendingRemainingLedger = decision.remainingVariantPolicy;
                  pendingJointLedger = decision.jointPolicy;
                  pendingExecutionWitness = decision.executionWitness;
                } else {
                  retireDecision(deepResult.decision, 'second_look_unchanged');
                }
              })
              .catch((error) => {
                if (
                  !(error instanceof HorseDecisionAbortedError) &&
                  !abortController.signal.aborted
                ) {
                  reportError(error, 'ServerTableEngineTurns.secondLook');
                }
              });
          }, secondLook.afterMs);
          this.horseSecondLookTimer.unref?.();
        }

        // 2026-08-22: clear any prior think-timer before overwriting the handle -
        // re-entry used to orphan the previous setTimeout (it still fired; only
        // the identity guards below kept it harmless).
        if (this.horseActionTimer) {
          clearTimeout(this.horseActionTimer);
          this.horseActionTimer = null;
        }
        this.horseActionTimer = setTimeout(() => {
          this.horseActionTimer = null;
          const utilityLedger = decision.tournamentUtility;
          const postflopLedger = decision.tournamentPostflop;
          const plo4Ledger = decision.plo4Policy;
          const omahaLedger = decision.omahaVariantPolicy;
          const remainingLedger = decision.remainingVariantPolicy;
          const jointLedger = decision.jointPolicy;
          pendingPlo4Ledger = plo4Ledger;
          pendingOmahaLedger = omahaLedger;
          pendingRemainingLedger = remainingLedger;
          pendingJointLedger = jointLedger;
          pendingPostflopLedger = postflopLedger;
          pendingUtilityLedger = utilityLedger;
          if (!fenceIsCurrent('commit')) return;
          if (!handControllerRef) {
            markPendingUtilityNotExecuted();
            return;
          }
          // The action is now authoritative. Cancel a queued/running deep read
          // before it can race the mutation below; this also retires the local
          // turn token so no later continuation can become current again.
          abortController.signal.removeEventListener('abort', markPendingUtilityNotExecuted);
          this.cancelHorseDecisionWork();

          // Verify it's still this player's turn (timer might have expired)
          const currentState = handControllerRef.getState();
          if (currentState.currentPlayerSeat !== seat) {
            markPendingUtilityNotExecuted();
            return;
          }

          let action = decision.action as string;
          let amount = decision.amount;

          if (action === 'allin') action = 'all_in';

          // ── ALL-IN-OR-FOLD (2026-08-22 parity) ────────────────────────────────
          // Phase 7 already received the AoF-filtered authoritative menu. This
          // belt may only degrade an impossible stale answer; it must never
          // synthesize an unpriced shove or resurrect one removed by the cap.
          if (this.tableInfo?.all_in_or_fold && currentState.stage === 'preflop') {
            const allInOrFoldActions = gameState.legalActions ?? [];
            const allowed = new Set(allInOrFoldActions);
            if (!allowed.has(action as ActionType)) {
              if (action !== 'fold' && allowed.has('all_in')) {
                // Preserve the host rule for a stale non-fold intent, but only
                // while the authoritative capped menu still contains a shove.
                action = 'all_in';
              } else {
                action =
                  toCall > 0 && allowed.has('fold')
                    ? 'fold'
                    : allowed.has('check')
                      ? 'check'
                      : (allInOrFoldActions[0] ?? 'fold');
              }
              amount = undefined;
            }
          }

          // Normalize actions
          if (action === 'check' && toCall > 0) action = 'call';
          if (action === 'call' && toCall === 0) action = 'check';
          if (action === 'call') amount = toCall;
          if (action === 'fold' && toCall === 0) action = 'check';
          if (action === 'raise' && state.currentBet === 0) action = 'bet';
          if (action === 'bet' && state.currentBet > 0) action = 'raise';

          // Clamp amounts
          //
          // 2026-08-23: the original horse path sized every bet no-limit style. The
          // Phase 5 canonical boundary now supplies and enforces the exact fixed-
          // limit bound; this commit-side snap remains as a final legality belt.
          // Same 2026-08-28 override correction as the human clamp above: the
          // hand's variant, not the table's.
          const horseFlBetSize = isFixedLimitVariant(this.activeHandVariant())
            ? // The horse snapshot types `stage` as a bare string; the values are
              // the same HandStage literals the controller emits.
              fixedLimitBetSize(this.tableInfo?.big_blind ?? 2, state.stage as HandStage)
            : 0;
          /* CAP FIX 2026-08-27: this commit-side check predates the Phase 5 shared
         canonical cap menu. Keep it as a final belt against a stale delayed
         decision; the worker has already received the same ceiling. */
          const horseCapBB = Number(this.tableInfo?.cap_bb) || 0;
          const horseCapChips =
            this.tableInfo?.cap_enabled === true && horseCapBB > 0
              ? horseCapBB * (Number(this.tableInfo?.big_blind) || 0)
              : 0;
          const horseCapRemaining =
            horseCapChips > 0
              ? Math.max(0, horseCapChips - (Number(enginePlayer.totalInvested) || 0))
              : Infinity;
          if (action === 'bet' && amount !== undefined) {
            amount = horseFlBetSize > 0 ? horseFlBetSize : Math.max(state.minRaise, amount);
            amount = Math.min(amount, horseCapRemaining);
            // Only the STACK promotes to all_in; a cap-bounded wager stays sized.
            if (amount >= enginePlayer.stack && enginePlayer.stack <= horseCapRemaining) {
              action = 'all_in';
              amount = undefined;
            }
          } else if (action === 'raise' && amount !== undefined) {
            const minRaiseTo = state.currentBet + state.minRaise;
            amount =
              horseFlBetSize > 0 ? state.currentBet + horseFlBetSize : Math.max(minRaiseTo, amount);
            const horseCapRaiseTo =
              horseCapRemaining === Infinity ? Infinity : enginePlayer.bet + horseCapRemaining;
            amount = Math.min(amount, horseCapRaiseTo);
            const horseStackRaiseTo = enginePlayer.stack + enginePlayer.bet;
            const maxRaiseTo = Math.min(horseStackRaiseTo, horseCapRaiseTo);
            if (amount >= maxRaiseTo && horseStackRaiseTo <= horseCapRaiseTo) {
              action = 'all_in';
              amount = undefined;
            }
          }

          // 2026-08-24: a capped fixed-limit street takes no further wager, and
          // validateAction refuses one whatever the amount. The degradation below is
          // `check() || fold()`, and on a capped street facing a bet `check` is
          // illegal too - so a horse that wanted to RAISE folded the hand it had
          // just decided to raise with. Substitute the closest legal intent instead
          // (call when money is owed, check when none is), which cannot be refused.
          // Re-read the controller's action history at commit time so the final
          // guard is judged against the same list performAction will validate.
          const liveState = handControllerRef.getState();
          if (
            horseFlBetSize > 0 &&
            isFixedLimitCapped(
              liveState.actionHistory ?? [],
              liveState.stage,
              fixedLimitBetSize(this.tableInfo?.big_blind ?? 2, liveState.stage)
            )
          ) {
            const substituted = substituteOnCappedStreet(action as ActionType, toCall);
            if (substituted !== action) {
              action = substituted as typeof action;
              amount = substituted === 'call' ? toCall : undefined;
            }
          }

          const normalizedAmount =
            typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
          // 2026-08-15 FREEZE FIX. HandController.performAction RETURNS FALSE on an
          // illegal action - it does not throw (HandController.ts:416/430/437). So
          // this catch never fired, and a horse whose decision the engine rejected
          // (stale raise amount, re-open rule, min-raise floor) simply never acted.
          // The human path was already fixed for exactly this in July ("the table
          // froze with no clock", Turns.ts SWEEP #4); the horse path was missed.
          // Check the boolean and degrade the same way a rejected human action does:
          // check if free, else fold. A seat must never be left unacted.
          // Same clock rule as the human path (2026-09-05): armed BEFORE the
          // action, because the broadcast happens inside performAction.
          let applied = false;
          let intendedApplied = false;
          let executedAction: ActionType | null = null;
          let executedAmount: number | null = null;
          const acceptedActions: HorseAcceptedAction[] = [];
          let attemptingFallback = false;
          const acceptanceObserver: [] | [(record: Readonly<ActionRecord>) => void] =
            decision.executionWitness
              ? [
                  (record) => {
                    acceptedActions.push({ record, intended: !attemptingFallback });
                  },
                ]
              : [];
          const horseClockWasArmed = this.lastActionAcceptedAtMs;
          this.lastActionAcceptedAtMs = Date.now();
          const worker = getLiveHorseDecisionWorker();
          const attemptAction = (
            attemptedAction: ActionType,
            attemptedAmount: number | undefined,
            origin: 'horse_policy' | 'horse_fallback'
          ): boolean => {
            const receiptsBefore = acceptedActions.length;
            let returned = false;
            try {
              returned = handControllerRef.performAction(
                seat,
                attemptedAction,
                attemptedAmount,
                origin,
                ...acceptanceObserver
              );
            } catch (err) {
              reportError(err, 'ServerTableEngine.' + this.tableId + '.horse_action_threw');
            }
            // The controller records acceptance before advancing the game.
            // A later exception or contradictory return cannot undo that
            // action and must never authorize another action for this turn.
            return returned || acceptedActions.length > receiptsBefore;
          };
          worker.runWithDispatchBarrier(() => {
            applied = attemptAction(
              action as ActionType,
              amount,
              safeWorkerFallback ? 'horse_fallback' : 'horse_policy'
            );
            intendedApplied = applied;
            if (applied) {
              executedAction = action as ActionType;
              executedAmount = normalizedAmount;
            }
            const acceptedWager = acceptedActions.length === 1 ? acceptedActions[0] : null;
            const exactWagerAccepted =
              !decision.executionWitness ||
              (acceptedWager?.intended === true &&
                acceptedWager.record.action === action &&
                acceptedWager.record.amount === normalizedAmount &&
                acceptedWager.record.action === decision.executionWitness.selected.action &&
                acceptedWager.record.amount === decision.executionWitness.selected.amount);
            if (
              intendedApplied &&
              exactWagerAccepted &&
              fastResult.effects.length > 0 &&
              (action === 'bet' || action === 'raise')
            ) {
              // HorseMind intent is speculative until this exact wager lands.
              // performAction emits TURN_CHANGE synchronously, so the client
              // dispatch barrier inserts this commit after older FIFO work and
              // before any decision that event enqueued. Rejected or degraded
              // actions never alter future-street plans.
              void worker
                .commitDecisionEffects(
                  { generation: fastResult.generation, fence: fastResult.fence },
                  fastResult.effects
                )
                .catch((error) => {
                  reportError(
                    error,
                    'ServerTableEngine.' + this.tableId + '.horse_decision_effect_commit_failed'
                  );
                });
            }
            if (!applied) {
              attemptingFallback = true;
              console.warn(
                '[ServerTableEngine:' +
                  this.tableId +
                  '] Horse action ' +
                  action +
                  ' rejected at seat ' +
                  seat +
                  ' - falling back to check/fold'
              );
              // Bible V8 §1.7.4 preferCheckOverFold. Re-arm: the rejected attempt
              // above produced no broadcast, so the clock must start again for
              // whichever of these two lands.
              this.lastActionAcceptedAtMs = Date.now();
              applied = attemptAction('check', undefined, 'horse_fallback');
              if (applied) {
                executedAction = 'check';
                executedAmount = null;
              } else {
                applied = attemptAction('fold', undefined, 'horse_fallback');
                if (applied) {
                  executedAction = 'fold';
                  executedAmount = null;
                }
              }
            }
            settleHorseExecutionWitness(decision.executionWitness, {
              applied,
              acceptedActions,
            });
            if (applied && acceptedActions.length === 1) {
              const actual = acceptedActions[0].record;
              executedAction = actual.action;
              executedAmount = ['bet', 'raise', 'call'].includes(actual.action)
                ? actual.amount
                : null;
            }
            const matchesUtilitySelection =
              !utilityLedger ||
              (utilityLedger.selectedAction === executedAction &&
                utilityLedger.selectedAmount === executedAmount);
            if (utilityLedger) {
              utilityLedger.executedAction = executedAction;
              utilityLedger.executedAmount = executedAmount;
              utilityLedger.executionStatus = !applied
                ? 'not_executed'
                : !intendedApplied
                  ? 'fallback'
                  : matchesUtilitySelection
                    ? 'intended'
                    : 'coerced';
              if (utilityLedger.executionStatus === 'intended') {
                noteFire('phase7_utility_committed');
              } else if (utilityLedger.executionStatus === 'coerced') {
                noteFire('phase7_utility_coerced');
              } else if (utilityLedger.executionStatus === 'fallback') {
                noteFire('phase7_utility_fallback');
              } else {
                noteFire('phase7_utility_not_executed');
              }
            }
            if (plo4Ledger) {
              plo4Ledger.executedAction = executedAction;
              plo4Ledger.executedAmount = executedAmount;
              const matched =
                executedAction === plo4Ledger.finalAction &&
                (!['bet', 'raise'].includes(plo4Ledger.finalAction) ||
                  executedAmount === plo4Ledger.finalAmount);
              plo4Ledger.executionStatus = !applied
                ? 'not_executed'
                : !intendedApplied
                  ? 'fallback'
                  : matched
                    ? 'intended'
                    : 'coerced';
              noteFire(`phase10_execution_${plo4Ledger.executionStatus}`);
            }
            if (omahaLedger) {
              omahaLedger.executedAction = executedAction;
              omahaLedger.executedAmount = executedAmount;
              const matched =
                executedAction === omahaLedger.finalAction &&
                (!['bet', 'raise'].includes(omahaLedger.finalAction) ||
                  executedAmount === omahaLedger.finalAmount);
              omahaLedger.executionStatus = !applied
                ? 'not_executed'
                : !intendedApplied
                  ? 'fallback'
                  : matched
                    ? 'intended'
                    : 'coerced';
              noteFire(`phase11_execution_${omahaLedger.executionStatus}`);
              noteFire(`phase11_${omahaLedger.variant}_execution_${omahaLedger.executionStatus}`);
            }
            if (remainingLedger) {
              remainingLedger.executedAction = executedAction;
              remainingLedger.executedAmount = executedAmount;
              const matched =
                executedAction === remainingLedger.finalAction &&
                (!['bet', 'raise'].includes(remainingLedger.finalAction) ||
                  executedAmount === remainingLedger.finalAmount);
              remainingLedger.executionStatus = !applied
                ? 'not_executed'
                : !intendedApplied
                  ? 'fallback'
                  : matched
                    ? 'intended'
                    : 'coerced';
              noteFire(`phase12_execution_${remainingLedger.executionStatus}`);
              noteFire(
                `phase12_${remainingLedger.variant}_execution_${remainingLedger.executionStatus}`
              );
            }
            if (jointLedger) {
              jointLedger.executedAction = executedAction;
              jointLedger.executedAmount = executedAmount;
              const matched =
                executedAction === jointLedger.finalAction &&
                (!['bet', 'raise'].includes(jointLedger.finalAction) ||
                  executedAmount === jointLedger.finalAmount);
              jointLedger.executionStatus = !applied
                ? 'not_executed'
                : !intendedApplied
                  ? 'fallback'
                  : matched
                    ? 'intended'
                    : 'coerced';
              noteFire(`phase13_execution_${jointLedger.executionStatus}`);
              noteFire(`phase13_${jointLedger.variant}_execution_${jointLedger.executionStatus}`);
            }
            if (postflopLedger) {
              postflopLedger.executedAction = executedAction;
              postflopLedger.executedAmount = executedAmount;
              const plannedAction = postflopLedger.applied
                ? postflopLedger.candidateAction
                : postflopLedger.baselineAction;
              const plannedAmount = postflopLedger.applied
                ? postflopLedger.candidateAmount
                : postflopLedger.baselineAmount;
              const matched =
                executedAction === plannedAction &&
                (!(plannedAction === 'bet' || plannedAction === 'raise') ||
                  executedAmount === plannedAmount);
              postflopLedger.executionStatus = !applied
                ? 'not_executed'
                : !intendedApplied
                  ? 'fallback'
                  : matched
                    ? 'intended'
                    : 'coerced';
              noteFire(`phase8_execution_${postflopLedger.executionStatus}`);
            }
          });
          // Unconditional markProgress() here reset watchdogTrips even when all
          // three actions were rejected, hiding a genuine stall for a full window.
          if (applied) {
            this.settleHorseSeatActed(player.user_id);
            // Realtime programme Phase 1 (2026-09-04): a horse's action is timed
            // exactly like a human's. This path bypasses _handlePlayerActionInner,
            // so before this the act-to-broadcast clock started only for HTTP
            // actions and the horse series could never fill - which also meant the
            // engine's own baseline latency was invisible whenever no human sat.
            // Same instrument, same clock, same treatment (CLAUDE.md 10.5).
            //
            // AUDIT FIX (2026-09-05): this sat above the check/fold fallback, so a
            // horse whose intended action was REJECTED still reached the felt via
            // the degrade and was neither counted nor timed. It now keys on the
            // same `applied` that markProgress() does - the one place that already
            // means "this seat acted", whichever of the three attempts landed.
            try {
              EngineMetrics.actionsFleetTotal.inc(1, {
                audience: this.humansSeated() > 0 ? 'human' : 'horse',
                format: this.tableFormat(),
              });
            } catch {
              /* metrics must never affect gameplay */
            }
            this.markProgress();
          } else {
            // Nothing landed, so no broadcast carries this clock. Put back what
            // was pending; a dead attempt must not become the next sample.
            this.lastActionAcceptedAtMs = horseClockWasArmed;
            try {
              EngineMetrics.horseSeatUnactableTotal.inc(1);
            } catch {
              /* metrics must never affect gameplay */
            }
            reportError(
              new Error(
                'Horse seat ' + seat + ' could not be acted - leaving stall visible to watchdog'
              ),
              'ServerTableEngine.' + this.tableId + '.horse_seat_unactable'
            );
          }
        }, remainingThinkMs);
      })
      .catch((error) => {
        if (!(error instanceof HorseDecisionAbortedError) && !abortController.signal.aborted) {
          reportError(error, 'ServerTableEngineTurns.horse_decision_continuation');
        }
      });
  }
}
