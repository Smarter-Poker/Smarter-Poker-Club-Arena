import { reportError } from '../services/errorReporter.js';
import { deadlineScheduler, type DeadlineScheduler } from './DeadlineScheduler.js';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RUN IT TWICE ENGINE — Dual-Board Card Dealing for All-In Scenarios
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles the complete Run It Twice (RIT) lifecycle:
 * - Detects all-in scenarios where RIT can be offered
 * - Manages accept/decline responses from both players
 * - Deals two (or three) independent board runouts
 * - Calculates pot division based on dual board results
 * - Optional event callbacks for UI synchronization
 *
 * Ported from client: src/engine/RunItTwiceEngine.ts (316 lines)
 * Server adaptation: No masterBus — uses optional onEvent callback. Class export, not singleton.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * How this table decides how many times to run it (Dan 2026-08-25).
 *
 * `run_it_mode` has carried these four values since February and no engine
 * ever read it, so "Mandatory Twice" and "Mandatory 3 Times" behaved exactly
 * like "Player's Choice" — the offer went out and either player could decline
 * a rule the host had made compulsory.
 */
export type RunItMode = 'none' | 'player_choice' | 'mandatory_twice' | 'mandatory_three';

export interface RITConfig {
  enabled: boolean;
  /**
   * ADDITIVE ONLY. A missing or unrecognised mode leaves the offer flow
   * exactly as it was — which matters, because `run_it_mode` is the string
   * 'none' on all 46 live tables while run-it-twice is genuinely ON via the
   * three boolean columns. Gating `enabled` on this would have switched the
   * feature off across the whole platform.
   */
  mode?: RunItMode;
  autoDeclineTimeout: number;
  maxRuns: 2 | 3;
  /** FIX 96: Timeout for chooser to pick runs (phase 1) */
  chooserTimeout?: number;
  /** FIX 96: Timeout for others to accept/decline (phase 2) */
  responderTimeout?: number;
}

export interface RITState {
  tableId: string;
  handId: string;
  status: 'idle' | 'offered' | 'accepted' | 'declined' | 'resolved';
  offeredBy: string;
  offeredTo: string;
  /** FIX 96: All player IDs involved in the all-in (for multi-player RIT) */
  allPlayerIds: string[];
  /** FIX 96: Player who chooses the number of runs */
  chooserPlayerId?: string;
  acceptedBy: Set<string>;
  pot: number;
  maxRuns: 2 | 3;
  /** FIX 96: Chosen number of runs (set by chooser in phase 1) */
  chosenRuns: 1 | 2 | 3;
  /**
   * CONSENT-RACE FIX 2026-08-18: consent is to "run it N times", so the
   * offer cannot complete until the chooser has actually picked N. Before
   * this flag, responders accepting quickly flipped the offer to 'accepted'
   * with the DEFAULT run count, silently discarding the chooser's pick.
   */
  chooserDecided: boolean;
  board1: string[];
  board2: string[];
  board3: string[];
  board1Winner?: string;
  board2Winner?: string;
  board3Winner?: string;
  // Phase 1.2 PR-G-real: timeouts routed through DeadlineScheduler keyed by
  // eventId = 'rit_offer' on the state's tableId. Raw setTimeout handle deleted.
}

/*
 * RITResult WAS HERE (deleted 2026-09-05). It was the return type of
 * dealDualBoards() and nothing else ever referenced it. Its shape is the
 * reason that function could never be right: `pot1 / pot2 / pot3` is one
 * number per board, which cannot express a hand with a main pot and two side
 * pots — the ordinary shape of the multi-way all-ins run-it-twice exists for.
 * The real runout carries `PerPotAward[]`, keyed by (run, pot, winner).
 */

export type RITEventType = 'RIT_OFFERED' | 'RIT_ACCEPTED' | 'RIT_DECLINED' | 'RIT_RESOLVED';

/**
 * WHO ENDED THE OFFER (2026-08-27). A decline that a PLAYER sent and a decline
 * the DeadlineScheduler wrote when nobody answered are the same state and two
 * completely different things to tell the table. Without this the engine's
 * RIT_DECLINED carried no way to tell them apart, so a forwarder could not
 * announce the expiry without also mislabelling every human decline.
 */
export type RITDeclineReason = 'player' | 'timeout';

export interface RITEvent {
  type: RITEventType;
  tableId: string;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUN IT TWICE ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class RunItTwiceEngine {
  private activeOffers: Map<string, RITState> = new Map();
  private tableConfigs: Map<string, RITConfig> = new Map();
  private onEvent?: (event: RITEvent) => void;
  /**
   * ADDITIONAL listeners, alongside `onEvent`.
   *
   * `onEvent` is the constructor callback and is REPLACEABLE (tests assign it
   * to watch the lifecycle). Anything the engine host needs permanently wired
   * — forwarding to the wire, for instance — must not be able to clobber that
   * callback or be clobbered by it, so it registers here instead. Duplicate
   * registrations of the same function are ignored, so a host that wires on
   * every hand still ends up with exactly one.
   */
  private listeners: Array<(event: RITEvent) => void> = [];
  /**
   * Phase 1.2 PR-G-real: central scheduler used for offer expiry. Replaces
   * the per-state setTimeout handle. One DeadlineScheduler tick per process
   * fires every expiring RIT offer across every table.
   */
  private scheduler: DeadlineScheduler;

  private static readonly OFFER_EVENT_ID = 'rit_offer';

  constructor(
    onEvent?: (event: RITEvent) => void,
    scheduler: DeadlineScheduler = deadlineScheduler
  ) {
    this.onEvent = onEvent;
    this.scheduler = scheduler;
    this.scheduler.start();
  }

  configure(tableId: string, config: RITConfig): void {
    this.tableConfigs.set(tableId, config);
  }

  /**
   * Register a permanent listener. Idempotent by function identity, so a host
   * that calls this once per hand still receives each event once.
   */
  addEventListener(listener: (event: RITEvent) => void): void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
  }

  removeEventListener(listener: (event: RITEvent) => void): void {
    const i = this.listeners.indexOf(listener);
    if (i >= 0) this.listeners.splice(i, 1);
  }

  isEnabled(tableId: string): boolean {
    return this.tableConfigs.get(tableId)?.enabled ?? false;
  }

  /**
   * POKERBROS PARITY 2026-08-26: the offer window in seconds, as configured.
   * The wire events (`rit_offer`, `rit_chooser_decided`) used to hardcode 10
   * while the engine's own expiry read the config — two clocks for one
   * countdown. Everything now reads this.
   */
  offerTimeoutSeconds(tableId: string): number {
    return this.tableConfigs.get(tableId)?.autoDeclineTimeout || 10;
  }

  /**
   * The MOST boards this table permits — the ceiling advertised on the offer,
   * not a count anybody has agreed to.
   *
   * 2026-08-27: `rit_offer` used to read this ceiling out of getChosenRuns(),
   * which is the wrong question in the wrong direction. getChosenRuns now
   * answers "how many boards do we have consent to run" and is 1 until the
   * offer is actually accepted, so the offer needs its own accessor for "how
   * many may I ask for". Keeping one function for both is precisely how the
   * maximum became a default.
   */
  maxRunsAllowed(tableId: string): 2 | 3 {
    return this.tableConfigs.get(tableId)?.maxRuns ?? 2;
  }

  /** The run count this table forces, or 0 when the players decide. */
  mandatoryRuns(tableId: string): 0 | 2 | 3 {
    const config = this.tableConfigs.get(tableId);
    if (!config?.enabled) return 0;
    if (config.mode === 'mandatory_three') return 3;
    if (config.mode === 'mandatory_twice') return 2;
    return 0;
  }

  /**
   * Run it N times WITHOUT asking. The host has already decided.
   *
   * This builds the same RITState `offer()` builds, in the state that flow
   * only reaches after everyone has agreed: chooserDecided, status 'accepted',
   * and every player already in acceptedBy — because `getChosenRuns()` reports
   * 1 unless the offer is accepted AND the chooser has decided, and
   * `tryCompleteAcceptance` needs every allPlayerIds member present. A
   * mandatory table that skipped either would deal one board while telling
   * everyone it was running two. No deadline is scheduled: there is nothing
   * to time out when there was never a question.
   */
  forceRuns(
    tableId: string,
    handId: string,
    allPlayerIds: string[],
    pot: number,
    runs: 2 | 3
  ): void {
    const config = this.tableConfigs.get(tableId);
    if (!config?.enabled || allPlayerIds.length === 0) return;

    this.clearOffer(tableId);

    const state: RITState = {
      tableId,
      handId,
      status: 'accepted',
      offeredBy: allPlayerIds[0],
      offeredTo: allPlayerIds[1] ?? allPlayerIds[0],
      allPlayerIds,
      chooserPlayerId: allPlayerIds[0],
      acceptedBy: new Set(allPlayerIds),
      pot,
      maxRuns: runs,
      chosenRuns: runs,
      chooserDecided: true,
      board1: [],
      board2: [],
      board3: [],
    };
    this.activeOffers.set(tableId, state);

    this.emitEvent({
      type: 'RIT_ACCEPTED',
      tableId,
      handId,
      playerId: allPlayerIds[0],
      runs,
      mandatory: true,
    });
  }

  /**
   * Offer RIT when all-in is detected.
   * Called by ServerTableEngine when 2+ players are all-in.
   */
  offer(
    tableId: string,
    handId: string,
    offeredBy: string,
    offeredTo: string | string[],
    pot: number
  ): void {
    const config = this.tableConfigs.get(tableId);
    if (!config?.enabled) return;

    this.clearOffer(tableId);

    // Support both single player (string) and multi-player (string[]) for backward compatibility
    const allPlayerIds = Array.isArray(offeredTo) ? offeredTo : [offeredBy, offeredTo];
    const primaryOfferedTo = Array.isArray(offeredTo)
      ? offeredTo.find((id) => id !== offeredBy) || offeredTo[0]
      : offeredTo;

    const state: RITState = {
      tableId,
      handId,
      status: 'offered',
      offeredBy,
      offeredTo: primaryOfferedTo,
      allPlayerIds,
      chooserPlayerId: offeredBy,
      acceptedBy: new Set([offeredBy]),
      pot,
      maxRuns: config.maxRuns || 2,
      chosenRuns: config.maxRuns || 2,
      chooserDecided: false,
      board1: [],
      board2: [],
      board3: [],
    };

    // Phase 1.2 PR-G-real: replace setTimeout with DeadlineScheduler entry.
    this.scheduler.schedule({
      tableId,
      eventId: RunItTwiceEngine.OFFER_EVENT_ID,
      deadlineMs: Date.now() + (config.autoDeclineTimeout || 10) * 1000,
      callback: () => {
        if (state.status === 'offered') {
          // 'timeout', not 'player': nobody declined here, the window closed.
          // The host forwards THIS case to the wire (see
          // ServerTableEngineRunout.wireRunItTwiceEvents) — a player decline
          // is already announced by respondToRIT with its own reason.
          this.expire(state);
        }
      },
    });

    this.activeOffers.set(tableId, state);

    this.emitEvent({
      type: 'RIT_OFFERED',
      tableId,
      handId,
      offeredBy,
      offeredTo: primaryOfferedTo,
      allPlayerIds,
      pot,
    });
  }

  accept(tableId: string, playerId: string): boolean {
    const state = this.activeOffers.get(tableId);
    if (!state || state.status !== 'offered') return false;

    // Only a player actually in this all-in can consent to running it twice.
    if (!state.allPlayerIds.includes(playerId)) return false;

    state.acceptedBy.add(playerId);

    // FIX-A8 2026-07-19 (Bible V8 §4.20): running it twice requires UNANIMOUS
    // consent from EVERY all-in player, not just the chooser + one opponent.
    // With 3+ all-in players the old check (offeredBy && offeredTo) flipped to
    // 'accepted' as soon as the single primary opponent accepted, running the
    // board twice against the other all-in player(s) without their agreement.
    // acceptedBy is pre-seeded with the chooser, so this reduces to the original
    // behavior for the heads-up (2-player) case.
    // CONSENT-RACE FIX 2026-08-18: completion additionally requires the
    // chooser to have picked the run count - accepting a number you have
    // not been told is not consent. Early accepts are recorded and the
    // offer completes the moment the chooser decides (see chooserDecides).
    return this.tryCompleteAcceptance(state);
  }

  /**
   * Complete the offer iff every all-in player has accepted AND the chooser
   * has decided the run count. Called from both accept() and chooserDecides()
   * so the completing action can arrive in either order.
   */
  private tryCompleteAcceptance(state: RITState): boolean {
    if (state.status !== 'offered' || !state.chooserDecided) return false;
    const everyoneAccepted = state.allPlayerIds.every((id) => state.acceptedBy.has(id));
    if (!everyoneAccepted) return false;
    state.status = 'accepted';
    // Phase 1.2 PR-G-real: cancel pending expiry deadline.
    this.scheduler.cancel(state.tableId, RunItTwiceEngine.OFFER_EVENT_ID);
    this.emitEvent({
      type: 'RIT_ACCEPTED',
      tableId: state.tableId,
      handId: state.handId,
    });
    return true;
  }

  /**
   * THE WINDOW CLOSED, AND THE RECORD SAYS WHO WAS STILL SILENT (2026-09-13).
   *
   * This used to be `decline(tableId, primaryOfferedTo, 'timeout')`, which
   * stamped the FIRST responder in the offer list as `declinedBy` on every
   * expiry - whoever had actually answered. B accepts in two seconds, C never
   * answers, and the event blamed B. No consumer read the name yet, which is
   * the only reason it was harmless; the next one (a hand-history note, an
   * audit, the felt strip naming who held things up) would have lied.
   *
   * An expiry has no decliner. It has the players who had not answered when
   * the clock ran out: every responder outside `acceptedBy`, and the chooser
   * if they never picked a count.
   */
  private expire(state: RITState): void {
    if (state.status !== 'offered') return;
    const unanswered = state.allPlayerIds.filter((id) =>
      id === state.chooserPlayerId ? !state.chooserDecided : !state.acceptedBy.has(id)
    );
    state.status = 'declined';
    this.scheduler.cancel(state.tableId, RunItTwiceEngine.OFFER_EVENT_ID);
    this.emitEvent({
      type: 'RIT_DECLINED',
      tableId: state.tableId,
      handId: state.handId,
      declinedBy: null,
      unanswered,
      reason: 'timeout',
    });
  }

  decline(tableId: string, playerId: string, reason: RITDeclineReason = 'player'): void {
    const state = this.activeOffers.get(tableId);
    if (!state || state.status !== 'offered') return;
    if (!state.allPlayerIds.includes(playerId)) return;

    state.status = 'declined';
    // Phase 1.2 PR-G-real: cancel pending expiry deadline.
    this.scheduler.cancel(tableId, RunItTwiceEngine.OFFER_EVENT_ID);

    this.emitEvent({
      type: 'RIT_DECLINED',
      tableId,
      handId: state.handId,
      declinedBy: playerId,
      reason,
    });
  }

  /*
   * dealDualBoards() WAS HERE, AND IT DEALT NOTHING (deleted 2026-09-05).
   *
   * Zero call sites, ever — verified across server/src, src/ and tests/: the
   * only mentions were two of its own comments and the NAME of a test. The
   * boards are dealt by ServerTableEngineRunout.dealAndResolveRIT, which
   * slices the remaining deck into `runs` contiguous blocks and handles the
   * short-deck fallback, hi-lo, side pots and rake. This function modelled
   * TWO boards with a third bolted on, split `state.pot` as a single number,
   * and would have been wrong the moment anybody called it.
   *
   * Deleted rather than left "in case": a plausible-looking dealer sitting
   * beside the real one is how the next agent calls the wrong one, and its
   * pot split had no idea side pots exist.
   */

  /**
   * Close the offer once the boards have been evaluated: record who took each
   * run, announce RIT_RESOLVED, and release the offer state.
   *
   * ── THIS FUNCTION MOVES NO MONEY (2026-09-05) ──
   *
   * It used to return a `Map<string, number>` distribution, computed here by
   * splitting `state.pot` evenly across the runs. Nothing has ever spent that
   * map: the only caller (ServerTableEngineRunout.dealAndResolveRIT, at the
   * `this.runItTwiceEngine.resolve(` line) discards the return, because it has
   * already done the real settlement — `determineWinners` per board against
   * the live pot structure, rake and BBJ deducted once, cent-exact scaling.
   *
   * The deleted math was also WRONG, and said so in its own comment: it
   * treated `state.pot` as a single number, so a multi-way all-in with SIDE
   * POTS was split as one pot. Ninety lines of plausible, unreachable,
   * incorrect money math beside the real thing is a trap — the next agent
   * either "fixes" a bug that cannot fire or, worse, wires it up. Money for a
   * run-it-twice hand has exactly one source, and this is not it.
   *
   * What it still does is real and load-bearing: the winner bookkeeping, the
   * RIT_RESOLVED announcement, and `clearOffer()` — without which the offer
   * would outlive its hand.
   */
  resolve(
    tableId: string,
    board1Winner: string,
    board2Winner: string,
    board3Winner?: string
  ): void {
    const state = this.activeOffers.get(tableId);
    if (!state) return;

    state.board1Winner = board1Winner;
    state.board2Winner = board2Winner;
    if (board3Winner) state.board3Winner = board3Winner;
    state.status = 'resolved';

    this.emitEvent({
      type: 'RIT_RESOLVED',
      tableId,
      handId: state.handId,
      board1: state.board1,
      board2: state.board2,
      board1Winner,
      board2Winner,
      board3Winner,
    });

    this.clearOffer(tableId);
  }

  isActive(tableId: string): boolean {
    const state = this.activeOffers.get(tableId);
    return state?.status === 'accepted';
  }

  getState(tableId: string): RITState | null {
    return this.activeOffers.get(tableId) ?? null;
  }

  /**
   * HOW MANY BOARDS THIS TABLE HAS CONSENT TO RUN. One, unless every all-in
   * player agreed to a number the chooser actually named.
   *
   * ── A MISSING CONSENT RECORD MEANT THE MAXIMUM (fixed 2026-08-27) ────────
   *
   * This used to be `if (state) return state.chosenRuns;` followed by
   * `return config?.maxRuns ?? 2`. Both halves were wrong in the same
   * direction — towards MORE boards:
   *
   *   - no state at all (never offered, cleared by endHand, wiped by a
   *     restart) fell through to the table's MAXIMUM, so the absence of any
   *     record of consent was read as unanimous consent to the largest split
   *     the table allows;
   *   - a state that existed but was still 'offered', or 'declined', returned
   *     whatever `chosenRuns` had been SEEDED with in offer() — which is
   *     `config.maxRuns`, not anybody's decision.
   *
   * Production hand #3046089 (cash table d9d3c3b3, run_it_mode 'none') is what
   * that looks like from the felt: three boards dealt, a 1470 pot split
   * 971.27 / 485.63, and not one player ever shown a run-it-twice prompt.
   * Three is exactly `maxRuns`.
   *
   * A default that decides how to divide a pot must fail towards the outcome
   * nobody has to agree to, and that is ONE board. The offer's ceiling has its
   * own accessor now — maxRunsAllowed() — so nothing has to reach in here for
   * a number that is not a decision.
   */
  getChosenRuns(tableId: string): number {
    const state = this.activeOffers.get(tableId);
    // No record of an offer = no record of consent = one board.
    if (!state) return 1;
    // Offered / declined / resolved are all "not agreed, right now".
    if (state.status !== 'accepted') return 1;
    // Accepted without the chooser having named a number cannot happen through
    // tryCompleteAcceptance, which requires chooserDecided. Asserted anyway:
    // this is the last gate in front of a pot split.
    if (!state.chooserDecided) return 1;
    return state.chosenRuns;
  }

  /**
   * FIX 96: Check if there's a pending (offered) RIT for this table.
   */
  hasPendingOffer(tableId: string): boolean {
    const state = this.activeOffers.get(tableId);
    return state?.status === 'offered' || state?.status === 'accepted';
  }

  /**
   * FIX 96: Chooser decides the number of runs.
   * If runs === 1, this effectively declines RIT.
   */
  chooserDecides(tableId: string, userId: string, runs: 1 | 2 | 3): void {
    const state = this.activeOffers.get(tableId);
    if (!state || state.chooserPlayerId !== userId) return;
    // CONSENT-RACE FIX 2026-08-18: a settled offer (declined/accepted/
    // resolved) cannot be mutated by a late pick.
    if (state.status !== 'offered') return;
    // Clamp to the table's configured maximum - a forged /rit body cannot
    // demand more boards than the table allows.
    state.chosenRuns = (runs > state.maxRuns ? state.maxRuns : runs) as 1 | 2 | 3;
    state.chooserDecided = true;
    if (runs === 1) {
      state.status = 'declined';
      // Phase 1.2 PR-G-real: cancel pending expiry deadline.
      this.scheduler.cancel(tableId, RunItTwiceEngine.OFFER_EVENT_ID);
      return;
    }
    // If every responder had already accepted while waiting on the chooser,
    // the chooser's pick is the completing action.
    this.tryCompleteAcceptance(state);
  }

  private clearOffer(tableId: string): void {
    // Phase 1.2 PR-G-real: cancel any pending expiry deadline for this table.
    if (this.activeOffers.has(tableId)) {
      this.scheduler.cancel(tableId, RunItTwiceEngine.OFFER_EVENT_ID);
    }
    this.activeOffers.delete(tableId);
  }

  /**
   * Per-HAND cleanup. Clears this hand's offer and cancels its timers but
   * KEEPS the table's configuration.
   *
   * OFFER-CONFIG FIX 2026-08-21 (root cause of "RIT is 100% broken"):
   * settlement called dispose() "to clean up advanced modules between hands",
   * and dispose() also deleted tableConfigs. configure() runs exactly ONCE,
   * in ServerTableEngine.start(). So isEnabled() - which is
   * `tableConfigs.get(id)?.enabled ?? false` - went permanently false after
   * the FIRST hand, and run-it-twice was never offered again until the engine
   * restarted. Live proof (2026-08-21, 90 min of cash traffic): 54 hands where
   * betting stopped on a pre-river all-in, 3 offers - and all 3 landed in the
   * minutes right after an engine deploy restarted every table.
   *
   * Between hands, call this. Call dispose() only when the table is going away.
   */
  endHand(tableId: string): void {
    this.clearOffer(tableId);
  }

  dispose(tableId: string): void {
    this.endHand(tableId);
    this.tableConfigs.delete(tableId);
  }

  disposeAll(): void {
    for (const [tableId] of this.activeOffers) {
      this.clearOffer(tableId);
    }
    this.tableConfigs.clear();
  }

  private emitEvent(event: RITEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        reportError(err, 'RunItTwiceEngine.Event_handler_error');
      }
    }
    // Each listener is isolated: one throwing must not stop the next, and must
    // never stop the engine's own flow.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        reportError(err, 'RunItTwiceEngine.Event_listener_error');
      }
    }
  }
}
