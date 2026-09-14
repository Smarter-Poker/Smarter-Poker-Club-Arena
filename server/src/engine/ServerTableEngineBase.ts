/**
 * ServerTableEngine, layer 1/8 — fields, construction, lifecycle, seat/rake helpers, crash recovery.
 *
 * Split out of the 5,623-line `src/engine/ServerTableEngine.ts` monolith on
 * 2026-08-08 (every deploy tool in this pipeline caps a single file at ~50 KB).
 * Behavior is preserved line-for-line: the only edits are module boundaries,
 * `private` widened to `protected` across the split, and `abstract`
 * declarations for the hooks each layer calls on the layer below.
 */

import { HandController } from './HandController.js';
import type { HandSeatGeneration } from './handSeatGeneration.js';
import { playerActionContext } from './PlayerActionContext.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { ServerActionValidator } from './ServerActionValidator.js';
import { StateVerifier } from './StateVerifier.js';
import { TimeBankEngine, type TimeBankEvent } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreActionEngine } from './PreActionEngine.js';
import { AtomicStackService } from './AtomicStackService.js';
import { StraddleEngine } from './StraddleEngine.js';
import { BombPotScheduler, bombPotSettingsFromTable } from './BombPotScheduler.js';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import { InsuranceEngine, type InsuranceSettlement } from './InsuranceEngine.js';
import { ShadowRecorder } from './eventlog/ShadowRecorder.js';
import type { BlindKind } from './eventlog/events.js';
import * as EngineMetrics from '../observability/engineInstruments.js';
import type { Span as EngineSpan } from '../observability/Tracing.js';
import { ChipRaceEngine } from './ChipRaceEngine.js';
import { TableBalancer } from './TableBalancer.js';
import { TableBreakEngine } from './TableBreakEngine.js';
import { EngineTelemetry } from './EngineTelemetry.js';
import {
  peekTournamentBrainContext,
  refreshTournamentBrainContext,
} from '../services/TournamentBrainContext.js';
import {
  getFullRakeConfig,
  getPlayerCountCaps,
  type BBJDetectionResult,
  type RakeOverride,
  type ServerRakeConfigResult,
} from '../config/RakeConfig.js';

/**
 * How long a table's resolved rake settings are trusted before re-reading.
 * An owner changing the rake sees it apply within a minute; the engine does
 * not pay for two extra row reads on every hand at every table.
 */
const RAKE_CONFIG_TTL_MS = 60_000;
import {
  loadTable,
  loadSeatedPlayers,
  logHandHistory,
  saveHandStateSnapshot,
  completeHandSnapshot,
  getActiveHandSnapshotFull,
  savePresenceAtPark,
  loadPresenceFromPark,
  supabase,
  atomicCashout,
} from '../services/supabase.js';
import {
  collectNitEvictions,
  collectNitStatus,
  type NitSeatStatus,
} from '../services/supabase/nitGame.js';
import { INSTANCE_ID } from '../services/tableLease.js';
import { evaluateCashSessions, atomicCashoutVoluntary } from '../services/supabase/cashSessions.js';
import {
  announceSeatMoves,
  executePendingSeatMoves,
  pendingSeatMoves,
  seatMoveCancelledNotice,
  seatMoveNotice,
  type PendingSeatMove,
} from '../services/supabase/seatMoves.js';
import { isMaintenanceFrozen } from '../maintenance/freezeState.js';
import { wakeCluster } from '../cluster/ClusterController.js';
import { ChipContinuityTracker } from './ChipContinuity.js';
import { claimMovedPresence, depositMovedPresence } from './SeatMovePresence.js';
import { deadlineScheduler } from './DeadlineScheduler.js';
import type {
  SeatPlayer,
  GameVariant,
  HandConfig,
  HandEvent,
  SeatedPlayer,
  TableInfo,
  RakeConfig,
} from '../types.js';
import { reportError } from '../services/errorReporter.js';
import { subscribeBombRequests, unsubscribeBombRequests } from '../services/BombRequestBus.js';
import { logInsuranceOfferEvent } from '../services/supabase/insuranceOfferLog.js';
import type { TableStateHub } from '../transport/TableStateHub.js';
import {
  createTableStateMachine,
  createTurnStateMachine,
  type TurnFSMState,
} from './StateMachine.js';
import { headsUpButtonSeat } from './headsUpButton.js';
import type { StateMachine } from './StateMachine.js';
import type { TableStatus } from '../types.js';
import { assertDiamondTable } from '../domain/DiamondCashBoundary.js';
import { HEADS_UP_SEATS } from '../config/headsUpSpec.js';

export type EngineLeaseAuthority =
  | {
      scope: 'cash';
      verified: true;
      generation: string;
      proofDeadlineMonotonicMs: number;
    }
  | {
      scope: 'tournament';
      verified: true;
      generation: string;
      tournamentId: string;
      proofDeadlineMonotonicMs: number;
    }
  | {
      scope: 'cash';
      verified: false;
      generation: null;
      proofDeadlineMonotonicMs: null;
    }
  | {
      scope: 'tournament';
      verified: false;
      generation: null;
      tournamentId: string;
      proofDeadlineMonotonicMs: null;
    };

/**
 * Why an engine recovery event exists.  This is deliberately independent of
 * the recovery action (`event`): an injected stall can exercise the same
 * watchdog action as a real failure, but it must never become production
 * kill-rate evidence.
 */
export type EngineRecoveryEventClass = 'automatic_recovery' | 'fault_injection';

export const AUTOMATIC_RECOVERY_EVENT_CLASS: EngineRecoveryEventClass = 'automatic_recovery';
export const FAULT_INJECTION_EVENT_CLASS: EngineRecoveryEventClass = 'fault_injection';

let leaseMonotonicNow: () => number = () => performance.now();

/** Test seam for a timer callback delayed beyond its monotonic authority. */
export function _setEngineLeaseMonotonicNowForTests(now?: () => number): void {
  leaseMonotonicNow = now ?? (() => performance.now());
}

export abstract class ServerTableEngineBase {
  public getActionContext(): string | null {
    return this.handController ? playerActionContext(this.handController) : null;
  }

  protected tableId: string;
  protected running: boolean = false;
  /** A table-engine object is one lifecycle generation and is never restarted. */
  private terminal: boolean = false;
  /**
   * The one durable teardown result for this generation. Kept after both
   * fulfillment and rejection so a late caller cannot mistake `running ===
   * false` for a teardown that never happened (or hide a teardown failure).
   */
  private teardownPromise: Promise<void> | null = null;
  /** True only after this object has owned the process-global table resources. */
  private claimedProcessOwnership: boolean = false;
  /** One causal hand-off from an asynchronously failed dealer to its owner. */
  private restartRequiredCallback: ((reason: string) => void) | null = null;
  private restartRequiredSignalled: boolean = false;
  /**
   * Distributed ownership proof carried by this exact dealer generation.
   * `null` is reserved for isolated tests/legacy non-leased workers. Production
   * cash and tournament admission always pass an explicit authority object.
   */
  private readonly engineLeaseScope: 'cash' | 'tournament' | null;
  private readonly engineLeaseVerified: boolean;
  private readonly engineLeaseGeneration: string | null;
  private readonly engineLeaseTournamentId: string | null;
  private engineLeaseProofDeadlineMonotonicMs: number | null;
  private engineLeaseAuthorityExpired = false;
  private engineLeaseExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * ═══ READY IS NOT DEALING (2026-09-05) ═══
   *
   * `start()` resolves when the DEALING LOOP starts, which is after the table
   * has its AutoStart figure of players seated - for a one-player table that
   * is "when a second player arrives", possibly never. Every on-demand caller
   * (`ensureCashTableEngine`: GET /state, GET /actions, the WS `ensureTable`,
   * the cluster wake) wants something earlier: the engine exists, has loaded
   * its row, is configured, and can publish the waiting snapshot. That moment
   * is the FSM's `waiting` transition, and this promise settles there.
   *
   * `true`  - the engine reached `waiting` (it may still be waiting for players).
   * `false` - start() failed, or the engine was stopped/killed before it got there.
   *
   * Settled at most once; later settles are no-ops. Never rejects.
   */
  readonly ready: Promise<boolean>;
  private settleReady: (ok: boolean) => void = () => {};
  /** Bible V8 §3.1: Formal Table State Machine with entry/exit/fail conditions */
  protected tableFSM: StateMachine<TableStatus> = createTableStateMachine('empty');
  /** Bible V8 §3.2: Formal Turn State Machine — unifies timer/timebank/preaction/disconnect */
  protected turnFSM: StateMachine<TurnFSMState> = createTurnStateMachine('waiting');
  /**
   * GLOBAL HAND NUMBER of the hand currently being dealt (2026-08-18).
   *
   * This used to be a per-table counter starting at 0, which is why "Hand #196"
   * existed simultaneously on many tables — across the most recent 20,000 hands
   * there were only 7,468 distinct numbers. It now holds a value allocated from
   * the database sequence `global_hand_number_seq`, so a hand number identifies
   * exactly one hand platform-wide, forever.
   *
   * The name is kept because ~30 call sites use it to mean "which hand is
   * this"; those are all correct unchanged. Anywhere that genuinely means
   * "how many hands" uses `handsDealtThisSession` instead.
   */
  protected handCount: number = 0;

  /** How many hands this engine has dealt since it started (a COUNT, not an id). */
  protected handsDealtThisSession: number = 0;
  protected handController: HandController | null = null;

  // ── ADDITIVE (flag-gated, default OFF) — event-sourcing shadow / observability / integrity ──
  /** Cached once at construction: emit shadow events + replay-verify at hand end. Default OFF. */
  protected readonly eventShadowEnabled: boolean = process.env.EVENT_SHADOW === 'on';
  /** Cached once at construction: start/export tracing spans (endpoint gated in health.ts). Default OFF. */
  protected readonly engineMetricsEnabled: boolean = process.env.ENGINE_METRICS === 'on';
  /** Cached once at construction: feed completed hands to the anti-cheat detectors. Default OFF. */
  protected readonly integrityFeedEnabled: boolean = process.env.INTEGRITY_FEED === 'on';
  /** Per-hand shadow recorder (only constructed when eventShadowEnabled). */
  protected shadowRecorder: ShadowRecorder | null = null;
  /** Guard so HoleCardsDealt is recorded once per hand despite per-seat CARDS_DEALT events. */
  protected shadowHoleCardsRecorded: boolean = false;
  /** Per-hand tracing span (only started when engineMetricsEnabled). */
  protected handSpan: EngineSpan | null = null;
  /** Epoch ms an action was accepted — used for the act→broadcast latency histogram. */
  protected lastActionAcceptedAtMs: number = 0;
  /**
   * Phase 1.1 PR-2: Authoritative state hub for native-WS delivery to clients.
   * When set, every broadcastCurrentState() publishes to the hub in parallel
   * with the legacy Supabase Realtime broadcast. Injected by the GameServer
   * at engine construction. null in unit tests / until PR-2 wiring lands.
   */
  protected hub: TableStateHub | null = null;
  protected tableInfo: TableInfo | null = null;
  protected seatedPlayers: SeatedPlayer[] = [];
  /** Tracks busted users who explicitly rejected a rebuy in the current hand (Dan 2026-08-24). */
  protected rejectedRebuys = new Set<string>();
  /**
   * Wakes an in-flight rebuy pause the instant a busted player answers.
   *
   * REBUY-PAUSE 2026-08-27: `rejectedRebuys` shipped as a WRITE-ONLY set. The
   * whole decline chain — TablePage -> POST /reject_rebuy -> rejectRebuy() —
   * terminated in a `.add()` that nothing ever read, and the pause itself was
   * a bare `await this.sleep(5000)` with no handle. So "snap continues if they
   * click no", which is half of Dan's rule, did not exist: the table sat out
   * the full five seconds either way. This resolver is what makes the pause
   * interruptible.
   */
  private rebuyPauseWake: (() => void) | null = null;

  public async rejectRebuy(userId: string): Promise<void> {
    const tournamentId = this.tableInfo?.tournament_id;
    if (tournamentId) {
      const { data, error } = await supabase.rpc('fn_decline_tournament_rebuy', {
        p_tournament_id: tournamentId,
        p_user_id: userId,
      });
      const result = (data ?? {}) as { ok?: boolean };
      if (error || result.ok !== true) {
        throw new Error(
          `Tournament rebuy decline was not persisted: ${error?.message ?? 'database refused the decision'}`
        );
      }
    }
    this.rejectedRebuys.add(userId);
    // Snap-continue: wake the pause loop now rather than at the next poll tick.
    this.rebuyPauseWake?.();
  }

  /**
   * Dan's Rebuy Pause, waited out properly.
   *
   * Holds the deal for up to `totalMs` after a bust, and returns EARLY the
   * moment every busted seat has answered — declined (`rejectRebuy`) or
   * rebought (a seat whose stack is positive again). Both halves of Dan's rule
   * are here: the pause happens, and it ends the instant it is no longer doing
   * anything for anybody.
   *
   * HORSES ARE PLAYERS. The caller passes EVERY busted seat, horse or human.
   * The horse answers through its own input device (HorseLogic / autoRebuyHorse
   * / tryTournamentRebuys) instead of through a modal, and that landing is
   * detected here by the same stack read that detects a human's. What must not
   * differ — and what did differ until this shipped — is the table's RHYTHM:
   * a felt that stops for one seat and rolls straight on for another tells
   * every watching player which seats are horses.
   */
  protected async waitForRebuyDecisions(userIds: string[], totalMs: number): Promise<void> {
    const pending = new Set(userIds.filter(Boolean));
    if (pending.size === 0) return;
    // A decision from a PREVIOUS hand must not fast-forward this pause.
    for (const id of pending) this.rejectedRebuys.delete(id);

    const deadline = Date.now() + totalMs;
    const POLL_MS = 250;

    const drainAnswered = async (): Promise<void> => {
      for (const id of Array.from(pending)) {
        if (this.rejectedRebuys.has(id)) pending.delete(id);
      }
      if (pending.size === 0) return;
      try {
        const { data } = await supabase
          .from('table_seats')
          .select('user_id, stack')
          .eq('table_id', this.tableId)
          .in('user_id', Array.from(pending))
          .is('left_at', null);
        for (const row of (data ?? []) as Array<{ user_id: string; stack: number | null }>) {
          if (Number(row.stack ?? 0) > 0) pending.delete(String(row.user_id));
        }
      } catch {
        /* A failed read must never SHORTEN the pause — fall through and wait. */
      }
      if (pending.size === 0) return;
      /* CHIP STANDARD C3 (2026-09-02): a rebuy no longer raises the seat's
         stack in the RPC - it lands as an unresolved `table_pending_addons`
         row (kind 'rebuy') that only the engine's sweep delivers, so the stack
         read above would never see a human's answer. A row for a busted seat
         IS the answer: the wallet is debited and the chips are owed to this
         seat. Count it as answered and (inside the helper) request the sweep
         that puts the chips on the felt before the next deal. An unreadable
         ledger (null) leaves the pause exactly as long as it was. */
      const inFlight = await this.usersWithPendingLedgerChips(Array.from(pending));
      if (inFlight) for (const id of inFlight) pending.delete(id);
    };

    try {
      while (Date.now() < deadline) {
        await drainAnswered();
        if (pending.size === 0) return;
        const slice = Math.min(POLL_MS, Math.max(0, deadline - Date.now()));
        if (slice <= 0) return;
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            this.rebuyPauseWake = null;
            resolve();
          };
          const timer = setTimeout(finish, slice);
          this.rebuyPauseWake = finish;
        });
      }
    } finally {
      this.rebuyPauseWake = null;
      for (const id of userIds) this.rejectedRebuys.delete(id);
    }
  }
  protected dealerSeatIndex: number = 0;
  /**
   * A button seat drawn for the FIRST hand and consumed by it.
   *
   * The first hand's button used to be `sortedSeats[0]` — the lowest occupied
   * seat. Deterministic, and on a 3-handed Spin that is a real positional edge
   * handed to whoever happened to take the low seat. Dan 2026-08-21: "BUTTON
   * RANDOMLY ASSIGNED". Null once used; rotation is unchanged from hand two on.
   */
  protected forcedFirstButtonSeat: number | null = null;
  // AUDIT FIX 2026-07-19: the button is tracked by SEAT NUMBER (not an array
  // index) so roster changes (bust/leave/join) can't move it backward, skip a
  // seat, or double-post a blind. 0 = no hand dealt yet.
  protected lastButtonSeat: number = 0;
  /**
   * The seat that posted the big blind on the last hand dealt here. Heads-up,
   * the button is derived from THIS rather than from the previous button, so
   * that no player posts the big blind twice running when a 3-handed table
   * drops to two (TDA Rule 33 -- see the dealing loop). Restored from
   * hand_history on restart alongside the button, for the same reason.
   */
  protected lastBigBlindSeat: number = 0;
  protected consecutiveErrors: number = 0;

  // Bankroll Management: Track how many times a horse has re-bought at this table.
  // Max is 2 rebuys (meaning 3 total buy-ins). If they bust a 3rd time, they leave.
  protected horseRebuys: Map<string, number> = new Map();

  // Bible V8 §4.2: Track players returning from sit-out who must post dead blind
  protected returningFromSitout: Set<string> = new Set();
  // AUDIT FIX 2026-07-19: new players who chose "Post BB to enter" — they post
  // only a live BB (no dead SB), unlike returningFromSitout (missed blinds).
  protected postingBBToEnter: Set<string> = new Set();

  // Bible V8 §4.2: Players waiting for BB position before they can play
  protected waitingForBB: Set<string> = new Set();

  // B2 2026-08-27 — TOURNAMENT ARRIVALS OWE A BIG BLIND, AND NOTHING COLLECTED IT.
  //
  // Every entry mechanism this engine has was switched off for tournament
  // tables: registerWaitForBB is a no-op for them, `deadBlinds` and
  // `bbOnlyPosts` were both gated on `!isTournamentTable()`. So a late
  // registrant, or a player the balancer moved in, was dealt in wherever they
  // happened to land and paid NOTHING until the blinds reached them — up to a
  // full free orbit if they landed on the seat the big blind had just passed,
  // which the seat-number-order placement in TableBalancer handed out at random.
  //
  // This set is the tournament counterpart of `postingBBToEnter`: a live big
  // blind (chip-conserving — it goes into the pot as a real bet), charged once,
  // on the arrival's first dealt hand. HandController's bbOnlyPosts handler
  // skips anyone sitting in the small or big blind that hand, so this can never
  // produce two big blinds inside one orbit. Membership survives the hand a
  // player spends in the small blind seat and is settled on the next one, which
  // is the ordinary blind cycle run backwards (SB then BB) rather than an extra
  // charge.
  protected mustPostBB: Set<string> = new Set();

  // POST-TO-ENTER RACE FIX 2026-08-27 (Dan: "the post to get dealt in
  // feature in cash games isn't working"): a brand-new joiner is only
  // REGISTERED as waiting by the dealing loop's next pass - which, mid-hand,
  // can be minutes away. Tapping Post Big Blind in that window came back
  // "Player is not waiting for BB" and the client gave up. The intent is
  // recorded HERE instead; the dealing loop applies it the moment the joiner
  // is registered, through the same postBBToEnter path (positional hold-outs
  // and the live-BB bill included). Pruned with knownPlayerIds when a seat
  // empties.
  protected pendingPostToEnter: Set<string> = new Set();

  // ═══════════════════════════════════════════════════════════════════════
  // AGREEING TO POST IS ANSWERED ONCE (Dan 2026-08-29, binding)
  //
  //   "in cash games when you click POST BB but you are IN BETWEEN THE
  //    BLINDS you get this pop up... that shouldn't happen because you
  //    already agreed to post bb... and auto post the blind then. it
  //    currently makes you hit the button again, or it simply won't deal
  //    you in at all."
  //
  // `postBBToEnter` refuses from two seats and must keep refusing them: a
  // cash player is never dealt into the small blind, and a new player never
  // takes the button. Neither may be bought, and this set does not buy them.
  //
  // What it fixes is what the refusal did to the PLAYER. The refusal threw
  // the answer away — the player stayed in `waitingForBB`, TablePage put the
  // same "Post Big Blind To Enter" button straight back on the felt, and
  // nothing anywhere remembered that they had already said yes. Tapping it
  // again from the same seat was refused again, so the only way through was
  // to keep tapping until the button happened to have moved, which is why it
  // reads as "it simply won't deal you in at all".
  //
  // A player in here has ALREADY AGREED to post. The dealing loop replays
  // that agreement, unchanged, on every pass, and it takes effect on the
  // first pass where the seat is no longer the one the small blind or the
  // button is about to reach. They are then billed one live big blind
  // through `postingBBToEnter` exactly as if they had tapped at that moment.
  //
  // Nothing here shortens the wait. It only stops the wait from costing the
  // player their answer.
  protected postBBWhenClear: Set<string> = new Set();

  // Guards restoreEntryHoldsFromSeats() to once per process. See that method
  // for why it must not run on every pass the way the sit-out restore does.
  protected entryHoldsRestored = false;

  // Bible V8 §4.2: Track every userId we've ever seen seated at this table.
  // Used by the dealing loop to detect new joiners after the engine has started
  // dealing hands. Since 2026-08-25 a new joiner does NOT wait and does not
  // post: they are released free on the same loop tick. The registration exists
  // so the two positional hold-outs can inspect the seat first — a cash player
  // is never dealt into the small blind, and never gets the button on their
  // first hand.
  protected knownPlayerIds: Set<string> = new Set();

  // Dan 2026-08-25, BINDING: "NEW PLAYERS NEVER GET THE BUTTON WHEN SITTING
  // DOWN — it skips over them and moves to the correct person." Every userId
  // that has actually been dealt at least one hand at this table. A player who
  // is not in here has never played, so the button rotation passes over them;
  // they pick it up on the following orbit like everyone else.
  protected dealtInUserIds: Set<string> = new Set();

  // Guard for the dealing loop's first iteration. On the first pass — whether
  // this is a cold start or a crash-recovery resume — every currently-seated
  // player is treated as an initial/existing player and is NOT flagged as
  // waiting-for-BB. Flagging only begins on iteration two and onward.
  protected dealingLoopFirstIteration: boolean = true;

  // Bible V8 §6.17: Admin pause/maintenance lock — prevents new hands from starting
  protected adminPauseLock: boolean = false;
  /**
   * Wall-clock instant before which this table must not deal (2026-08-21).
   *
   * pauseAfterHand() pauses AFTER the current hand, which is right for
   * hand-for-hand and breaks but cannot protect the FIRST deal — and the
   * first deal is exactly what the Spin reveal needs held, or cards land
   * underneath a spinning wheel.
   */
  protected dealHoldUntilMs: number = 0;

  /** Hold dealing until `atMs`. Only ever extends the hold, never shortens it. */
  /**
   * Seed the first hand's button. Ignored if that seat is not occupied when
   * the hand actually starts, so a player leaving between the draw and the
   * deal degrades to normal rotation rather than stranding the button on an
   * empty seat.
   */
  /**
   * The seat numbers currently holding a player, ascending.
   *
   * Exposed so the tournament layer can DRAW a button without reaching into
   * engine internals — the alternative was re-querying table_seats, which
   * would have been a second source of truth for who is sitting where.
   */
  public getOccupiedSeatNumbers(): number[] {
    return (this.seatedPlayers ?? [])
      .map((p) => Number(p.seat_number))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
  }

  public setFirstButtonSeat(seat: number): void {
    this.forcedFirstButtonSeat = Number.isFinite(seat) && seat > 0 ? Math.floor(seat) : null;
  }

  public holdDealingUntil(atMs: number): void {
    if (atMs > this.dealHoldUntilMs) this.dealHoldUntilMs = atMs;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  MYSTERY BOUNTY REVEAL GATE (Dan sections 21-26, 61-65)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * "When an award is reserved, the affected table enters a reveal state.
   * During it: no dealer button move, no next hand, no blinds or antes
   * posted, no player action timers. Only the reveal timeout runs."
   *
   * WHY THIS IS NOT `holdDealingUntil()`. The hold is a DEADLINE — a wall
   * clock the loop compares itself against. That is right for the spin
   * wheel, which is one fixed-length animation. It is wrong here, because
   * section 25/64 is a COUNT, not a duration: the button may not move until
   * the QUEUE IS EMPTY, and three knockouts in one hand are three reveals
   * one after another. Timer arithmetic that tried to express "however long
   * three chests take" would be wrong the first time a reveal ran slow, and
   * a table that deals underneath a live chest has moved the button during
   * a reveal — the exact thing sections 25 and 64 forbid.
   *
   * So this is a SET of open awards, and dealing resumes when it empties.
   *
   * EVERY ENTRY STILL CARRIES A DEADLINE, because a set that only empties on
   * a call is a set that a crashed settle path leaves full forever, and a
   * wedged table is worse than a missed animation. `hasOpenBountyReveal()`
   * prunes expired entries on every read, so the gate is self-healing: the
   * worst case is that the table resumes on its own a few seconds after the
   * reveal should have ended.
   *
   * ONLY THIS TABLE STOPS (sections 22 and 61). This state lives on one
   * engine instance. The tournament clock, the blind-level clock and every
   * other table run from the TournamentManager and never consult it.
   *
   * ACTION TIMERS: there is nothing to cancel. The gate is checked in the
   * dealing loop BEFORE `dealHand()`, so no hand exists while it is closed
   * and therefore no player is on the clock. A knockout detected while the
   * next hand is already in progress holds from the next hand boundary —
   * which is also section 23's end-of-hand order (settle, THEN reveal).
   */
  private bountyRevealHolds: Map<string, number> = new Map();

  /** Open a reveal gate. `deadlineMs` is an absolute epoch-ms failsafe. */
  public beginBountyReveal(awardId: string, deadlineMs: number): void {
    const id = String(awardId ?? '').trim();
    if (!id) return;
    const prev = this.bountyRevealHolds.get(id) ?? 0;
    // Monotonic, like holdDealingUntil: a second reserve of the same award
    // (an idempotent re-sweep) may extend the gate but never shorten it.
    this.bountyRevealHolds.set(id, Math.max(prev, deadlineMs));
  }

  /** Close one award's gate. Safe to call for an award that never opened. */
  public endBountyReveal(awardId: string): void {
    this.bountyRevealHolds.delete(String(awardId ?? '').trim());
  }

  /** How many reveals are still holding this table. Prunes expired entries. */
  public openBountyRevealCount(): number {
    const now = Date.now();
    for (const [id, deadline] of this.bountyRevealHolds) {
      if (deadline <= now) this.bountyRevealHolds.delete(id);
    }
    return this.bountyRevealHolds.size;
  }

  /** True while this table must not deal, post blinds, or move the button. */
  public hasOpenBountyReveal(): boolean {
    return this.openBountyRevealCount() > 0;
  }
  protected maintenanceLock: boolean = false;

  // FIX 143: Bible V8 §7.12: Deferred sit-out — can't fold mid-hand
  // Players who request sit-out during an active hand are queued here.
  // The sit-out is applied AFTER the current hand completes in postHandTasks().
  protected pendingSitOut: Set<string> = new Set();

  // Pending add-on chips: queued during active hand, processed in postHandTasks.
  // If a player wins a pot and their stack + add-on exceeds max buy-in,
  // the add-on is reduced or canceled. Map<userId, requestedAmount>.
  protected pendingAddOns: Map<string, number> = new Map();
  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  MID-HAND DIAMOND TOP-UPS ARE AN INTENT, NOT A DEBIT
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The chip lane takes the money at request time and lands the chips at the
   * end of the hand, through the durable `table_pending_addons` ledger. A
   * Diamond seat cannot do that, and the reason is a constraint rather than a
   * preference: the deferred trigger `zzz_diamond_seat_keeps_custody` requires
   * a Diamond seat's `stack` to EQUAL its custody balance at every COMMIT. A
   * reservation made now and applied later is a committed state where the two
   * disagree, so there is no ordering of the chip lane's two steps that this
   * arena permits.
   *
   * The alternative to a debit is an INTENT: nothing moves until the hand
   * ends, and then the whole top-up happens in the one transaction the
   * constraint does allow, through `fn_poker_diamond_top_up` - the door that
   * already exists and is already certified.
   *
   * WHAT THE PLAYER GIVES UP, stated plainly because they are told it too: the
   * chip lane guarantees the money is committed the moment they tap. This
   * guarantees only that it will be attempted the moment the hand ends, so a
   * player who spends those Diamonds elsewhere in the intervening thirty
   * seconds gets an honest refusal instead. That is a narrower promise, and it
   * is the widest one this constraint leaves; the chip lane's promise is not
   * as wide as it looks either, since it re-sizes at landing and refunds the
   * difference when the pot has moved the stack.
   *
   * KEYED BY REQUEST ID, not by user, so a retry of the same tap overwrites
   * itself and two genuine taps both count. The id is the same uuidv5 the
   * between-hands path derives, so the SQL door de-duplicates a replay of the
   * landing itself.
   *
   * MEMORY ONLY, deliberately. An intent lost to an engine restart costs the
   * player nothing, because nothing was taken; a DEBIT lost to a restart is
   * the failure mode the durable chip ledger exists to prevent. There is
   * nothing here worth making durable.
   */
  protected diamondTopUpIntents: Map<string, { userId: string; amount: number }> = new Map();
  /**
   * A2: does the durable `table_pending_addons` ledger need a sweep?
   *
   * Starts true so a freshly started engine always checks once for rows a dead
   * predecessor left behind. Set true again whenever a mid-hand add-on is
   * debited or a resolve fails; cleared only after a sweep that leaves zero
   * unresolved rows. This keeps the steady-state cost at zero extra queries per
   * hand while making it impossible for an open row to be forgotten.
   */
  protected pendingAddOnSweepNeeded = true;
  /**
   * CHIP STANDARD C3 (2026-09-02): a sweep request counter beside the flag.
   *
   * The flag alone had a losing race once rows could arrive from OUTSIDE the
   * engine. `atomic_table_rebuy` no longer touches `table_seats.stack`; the
   * browser's bust rebuy lands as a `table_pending_addons` row (kind 'rebuy')
   * that only `processPendingAddOns` delivers. Settlement step 8e and the
   * rebuy pause run concurrently: if 8e read the ledger BEFORE the row
   * committed and the pause read it after, the pause set the flag true and
   * 8e's late continuation set it false again - the row was forgotten until
   * the next engine start, and standUpBustedCashPlayers released the seat
   * meanwhile (resolve_pending_addon then refunds the wallet, so the player
   * paid, was stood up, and got a refund instead of a seat).
   *
   * A sweep now captures this counter when it starts and clears the flag only
   * if nobody asked for another sweep while it was running.
   */
  protected pendingAddOnSweepGen = 0;

  /** Ask for a ledger sweep before the next deal. Safe from any concurrent path. */
  protected requestPendingAddOnSweep(): void {
    this.pendingAddOnSweepNeeded = true;
    this.pendingAddOnSweepGen++;
  }

  /**
   * Which of `userIds` have money in flight on the durable ledger for this
   * table - an unresolved `table_pending_addons` row of ANY kind (a mid-hand
   * add-on or a bust rebuy). A hit also requests a sweep so the chips are on
   * the felt before the next deal. Returns null when the ledger could not be
   * read, so callers decide their own fail-open direction (the rebuy pause
   * must not shorten on an unreadable ledger; the stand-up must not release a
   * seat on one).
   */
  protected async usersWithPendingLedgerChips(userIds: string[]): Promise<Set<string> | null> {
    const ids = userIds.filter(Boolean);
    if (ids.length === 0) return new Set();
    try {
      const { data, error } = await supabase
        .from('table_pending_addons')
        .select('user_id')
        .eq('table_id', this.tableId)
        .in('user_id', ids)
        .is('resolved_at', null);
      if (error) return null;
      const hit = new Set<string>();
      for (const row of (data ?? []) as Array<{ user_id: string }>) hit.add(String(row.user_id));
      if (hit.size > 0) this.requestPendingAddOnSweep();
      return hit;
    } catch {
      return null;
    }
  }
  /** C15: minimum gap between persisted hand snapshots, per table. */
  protected static readonly SNAPSHOT_MIN_INTERVAL_MS = 1000;
  protected lastSnapshotAtMs = 0;
  protected snapshotDirty = false;
  protected snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  /** The exact snapshot writer currently owned by this engine generation. */
  protected snapshotFlushPromise: Promise<void> | null = null;

  /**
   * CROSS-INSTANCE OWNERSHIP (2026-08-22).
   * tableId -> the engine instance currently authoritative for that table.
   * DeadlineScheduler and PreciseActionTimer are process-global and keyed by
   * tableId ONLY, while GameServer routinely lets an old engine's async stop()
   * overlap construction of its replacement (zombie reaper and lease-lost
   * paths both do `void engine.stop()` then rebuild within one 5s sweep).
   * Without ownership checks the OLD instance's teardown cancels the NEW
   * instance's heartbeat and turn deadlines on the shared scheduler — the
   * table then permanently loses its watchdog and every stall lasts forever.
   * Every teardown path that touches a shared resource must check ownership.
   */
  private static liveEngines = new Map<string, ServerTableEngineBase>();

  private static claimCurrentEngine(tableId: string, engine: ServerTableEngineBase): boolean {
    const incumbent = ServerTableEngineBase.liveEngines.get(tableId);
    if (incumbent && incumbent !== engine) return false;
    ServerTableEngineBase.liveEngines.set(tableId, engine);
    return true;
  }

  protected static isCurrentEngineFor(tableId: string, engine: ServerTableEngineBase): boolean {
    return ServerTableEngineBase.liveEngines.get(tableId) === engine;
  }

  private static releaseCurrentEngine(tableId: string, engine: ServerTableEngineBase): void {
    if (ServerTableEngineBase.liveEngines.get(tableId) === engine) {
      ServerTableEngineBase.liveEngines.delete(tableId);
    }
  }

  /** Is this instance still the authoritative engine for its table? */
  protected isCurrentEngine(): boolean {
    return ServerTableEngineBase.isCurrentEngineFor(this.tableId, this);
  }

  /** Claim shared scheduler identity without ever evicting a live generation. */
  private claimProcessOwnership(): boolean {
    const claimed = ServerTableEngineBase.claimCurrentEngine(this.tableId, this);
    if (claimed) this.claimedProcessOwnership = true;
    return claimed;
  }

  private engineLeaseAuthorityIsCurrent(): boolean {
    /* An absent/unverified authority exists only for isolated dependency-
       injected unit/E2E harnesses. GameServer and TournamentManager never
       construct this shape in production. */
    if (!this.engineLeaseScope || !this.engineLeaseVerified) return true;
    return (
      !this.engineLeaseAuthorityExpired &&
      this.engineLeaseProofDeadlineMonotonicMs !== null &&
      Number.isFinite(this.engineLeaseProofDeadlineMonotonicMs) &&
      leaseMonotonicNow() < this.engineLeaseProofDeadlineMonotonicMs
    );
  }

  private clearEngineLeaseExpiryTimer(): void {
    if (!this.engineLeaseExpiryTimer) return;
    clearTimeout(this.engineLeaseExpiryTimer);
    this.engineLeaseExpiryTimer = null;
  }

  private armEngineLeaseExpiryTimer(): void {
    this.clearEngineLeaseExpiryTimer();
    if (!this.engineLeaseScope || !this.engineLeaseVerified || this.engineLeaseAuthorityExpired) {
      return;
    }
    const deadline = this.engineLeaseProofDeadlineMonotonicMs;
    if (deadline === null || !Number.isFinite(deadline)) {
      this.expireEngineLeaseAuthority();
      return;
    }
    const delayMs = deadline - leaseMonotonicNow();
    if (delayMs <= 0) {
      this.expireEngineLeaseAuthority();
      return;
    }
    this.engineLeaseExpiryTimer = setTimeout(() => {
      this.engineLeaseExpiryTimer = null;
      /* Timers may wake early. Re-read the monotonic deadline rather than
         converting scheduler jitter into a false ownership loss. */
      if (this.engineLeaseAuthorityIsCurrent()) {
        this.armEngineLeaseExpiryTimer();
        return;
      }
      this.expireEngineLeaseAuthority();
    }, Math.ceil(delayMs));
    this.engineLeaseExpiryTimer.unref?.();
  }

  private expireEngineLeaseAuthority(): void {
    if (!this.engineLeaseScope || !this.engineLeaseVerified || this.engineLeaseAuthorityExpired) {
      return;
    }
    this.engineLeaseAuthorityExpired = true;
    this.clearEngineLeaseExpiryTimer();
    this.killForRestart(`${this.engineLeaseScope}_lease_proof_expired`);
  }

  /**
   * Extend this exact dealer's proof. Scope and generation are immutable;
   * heartbeat success may move only the conservative monotonic deadline.
   */
  renewEngineLeaseProof(authority: EngineLeaseAuthority): boolean {
    if (
      !this.engineLeaseScope ||
      !this.engineLeaseVerified ||
      !authority.verified ||
      this.engineLeaseScope !== authority.scope ||
      (this.engineLeaseGeneration ?? '').toLowerCase() !==
        (authority.generation ?? '').toLowerCase() ||
      (this.engineLeaseTournamentId ?? '').toLowerCase() !==
        (authority.scope === 'tournament' ? authority.tournamentId : '').toLowerCase() ||
      this.engineLeaseAuthorityExpired ||
      !Number.isFinite(authority.proofDeadlineMonotonicMs) ||
      leaseMonotonicNow() >= authority.proofDeadlineMonotonicMs
    ) {
      return false;
    }
    /* Concurrent renewal callers can complete out of order during a shutdown
       handoff. Every accepted deadline is independently conservative, so keep
       the greatest one and never let an older response shorten current proof. */
    this.engineLeaseProofDeadlineMonotonicMs = Math.max(
      this.engineLeaseProofDeadlineMonotonicMs ?? Number.NEGATIVE_INFINITY,
      authority.proofDeadlineMonotonicMs
    );
    if (this.running) this.armEngineLeaseExpiryTimer();
    return true;
  }

  /** Read-time fence catches an event loop that resumes before its timer runs. */
  hasCurrentEngineLeaseAuthority(): boolean {
    if (this.engineLeaseAuthorityIsCurrent()) return true;
    this.expireEngineLeaseAuthority();
    return false;
  }

  /** Diagnostics and future atomic-settlement fencing carry this exact scope. */
  getEngineLeaseAuthority(): EngineLeaseAuthority | null {
    if (!this.engineLeaseScope) return null;
    if (!this.engineLeaseVerified) {
      return this.engineLeaseScope === 'tournament' && this.engineLeaseTournamentId
        ? {
            scope: 'tournament',
            verified: false,
            generation: null,
            tournamentId: this.engineLeaseTournamentId,
            proofDeadlineMonotonicMs: null,
          }
        : {
            scope: 'cash',
            verified: false,
            generation: null,
            proofDeadlineMonotonicMs: null,
          };
    }
    if (this.engineLeaseScope === 'tournament') {
      if (
        !this.engineLeaseGeneration ||
        !this.engineLeaseTournamentId ||
        this.engineLeaseProofDeadlineMonotonicMs === null
      ) {
        return null;
      }
      return {
        scope: 'tournament',
        verified: true,
        generation: this.engineLeaseGeneration,
        tournamentId: this.engineLeaseTournamentId,
        proofDeadlineMonotonicMs: this.engineLeaseProofDeadlineMonotonicMs,
      };
    }
    if (!this.engineLeaseGeneration || this.engineLeaseProofDeadlineMonotonicMs === null) {
      return null;
    }
    return {
      scope: 'cash',
      verified: true,
      generation: this.engineLeaseGeneration,
      proofDeadlineMonotonicMs: this.engineLeaseProofDeadlineMonotonicMs,
    };
  }

  /** Synchronous distributed fence; physical teardown remains owner-managed. */
  fenceForEngineLeaseLoss(reason = 'distributed_lease_lost', notifyOwner = false): void {
    if (this.engineLeaseVerified) this.engineLeaseAuthorityExpired = true;
    this.clearEngineLeaseExpiryTimer();
    if (this.terminal) return;
    this.killForRestart(reason, notifyOwner);
  }

  /** Re-check process and distributed generation identity after every await. */
  protected lifecycleCanMutate(): boolean {
    if (!this.engineLeaseAuthorityIsCurrent()) {
      this.expireEngineLeaseAuthority();
      return false;
    }
    return this.running && !this.terminal && this.isCurrentEngine();
  }

  /**
   * BBJ AUDIT 2026-09-05: every live CASH table whose club is in `clubIds`,
   * other than `excludeTableId`.
   *
   * A Bad Beat Jackpot hit is announced to "everyone currently playing in the
   * club or union" (Dan). The client used to learn about a hit at another
   * table only through a Supabase Realtime subscription on the pool row - a
   * stream this platform has measured a minute or more behind at peak - and
   * then refused anything older than 90 seconds as a replay. So at other
   * tables the announcement raced its own freshness gate and could lose.
   *
   * The engine already holds a socket to every one of those tables. This is
   * the fan-out list for `bbj_hit_global`, read from the same registry that
   * decides which engine instance is authoritative, so a zombie engine mid
   * teardown is never on it. Tournament tables are excluded: a jackpot is a
   * cash-game feature and a tournament table's players are not in the pool.
   */
  protected static liveCashTableIdsInClubs(
    clubIds: ReadonlySet<string>,
    excludeTableId: string
  ): string[] {
    const out: string[] = [];
    for (const [tableId, engine] of ServerTableEngineBase.liveEngines) {
      if (tableId === excludeTableId) continue;
      const info = engine.tableInfo;
      if (!info?.club_id || !clubIds.has(info.club_id)) continue;
      if (info.tournament_id) continue;
      out.push(tableId);
    }
    return out;
  }

  /**
   * FIX 2026-08-22: the 10-minute hand-void timer is a raw setTimeout held per
   * hand. It was never cleared by stop()/killForRestart(), so it could fire
   * up to 10 minutes later — against a SUCCESSOR engine happily dealing on the
   * same table — and wipe that live engine's turn deadlines (clearTable on the
   * shared timer). Held here so both teardown paths can clear it.
   */
  protected handSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  protected clearHandSafetyTimer(): void {
    if (this.handSafetyTimer) {
      clearTimeout(this.handSafetyTimer);
      this.handSafetyTimer = null;
    }
  }

  /**
   * 2026-08-22: raw setTimeout handles that live on the instance and were
   * never cleared by stop()/killForRestart(). A leaked horse think-timer or
   * pineapple discard timer holds a reference to a dead engine and fires its
   * callback against it later (the callbacks carry controller-identity
   * guards, so this is a leak/noise issue rather than a corruption one — but
   * teardown should still be complete).
   */
  /**
   * Fold the seats whose OWN discard deadline has passed, then re-arm for the
   * next one still outstanding.
   *
   * One re-arming sweep rather than one timer per seat: a time bank moves a
   * single seat's deadline, and a fixed table-wide timeout could not express
   * that. Deadlines are absolute, so a sweep that runs late is still correct —
   * it folds exactly the seats that are genuinely out of time.
   */
  protected armPineappleDiscardSweep(controllerRef: unknown): void {
    if (this.pineappleDiscardTimer) {
      clearTimeout(this.pineappleDiscardTimer);
      this.pineappleDiscardTimer = null;
    }
    this.pruneSettledPineappleDeadlines();
    if (this.pineappleDiscardDeadlines.size === 0) return;

    const next = Math.min(...this.pineappleDiscardDeadlines.values());
    const wait = Math.max(0, next - Date.now());

    this.pineappleDiscardTimer = setTimeout(() => {
      this.pineappleDiscardTimer = null;
      if (!this.handController || this.handController !== controllerRef) return;

      /* Reconcile before folding anybody. A horse discards through
         performDiscard and an all-in seat through
         resolvePendingPineappleDiscards, neither of which passes through
         submitDiscard - so without this the sweep would reach a seat that
         settled its round minutes ago. foldForMissedDiscard would refuse it,
         but "the guard downstream happens to say no" is not a reason to ask. */
      this.pruneSettledPineappleDeadlines();

      const now = Date.now();
      for (const [seat, at] of [...this.pineappleDiscardDeadlines]) {
        if (at > now) continue; // this seat bought itself more time
        this.pineappleDiscardDeadlines.delete(seat);
        try {
          // Dan 2026-08-21: a missed discard FOLDS the hand. It used to
          // auto-discard the last card - a random discard the player never
          // chose, which then kept playing for them.
          this.handController.foldForMissedDiscard(seat);
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.pineapple_discard_fold_threw', {
            seat,
          });
          // Keep going — one bad seat must not strand the whole table.
        }
      }
      this.markProgress();
      // Seats with an extended deadline are still owed their round.
      this.armPineappleDiscardSweep(controllerRef);
    }, wait);
  }

  /**
   * Spend a time bank on a DISCARD (2026-08-31).
   *
   * Every other decision on this table can buy time; the discard could not,
   * because the whole time-bank path is written against `currentPlayerSeat`
   * and the discard round has no turn — every seat decides at once. So the one
   * action where a player is most likely to hesitate was the one action with no
   * way to think, and missing it folds the hand outright.
   *
   * Same rules as a turn, deliberately: the ordinary clock must be genuinely
   * exhausted first (TimeBankEngine enforces it from the remaining seconds we
   * pass in), the pool and the per-street cap are the engine's, and the grant
   * lands on THIS seat's deadline only.
   */
  public extendPineappleDiscard(userId: string): {
    success: boolean;
    error?: string;
    armed?: boolean;
    message?: string;
    deadlineMs?: number;
  } {
    if (!this.handController) return { success: false, error: 'No Active Hand At This Table' };
    if (this.handController.getState().stage !== 'pineapple_discard') {
      return { success: false, error: 'Not In The Discard Round' };
    }
    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) return { success: false, error: 'You Are Not Seated At This Table' };

    const seat = player.seat_number;
    const at = this.pineappleDiscardDeadlines.get(seat);
    if (at === undefined) return { success: false, error: 'You Have Already Discarded' };

    const remaining = Math.max(0, (at - Date.now()) / 1000);
    if (remaining > TimeBankEngine.CLOCK_EXHAUSTED_EPSILON_SECONDS) {
      if (!this.timeBankEngine.arm(this.tableId, userId)) {
        return { success: false, error: 'No Time Bank Uses Remaining' };
      }
      return {
        success: true,
        armed: true,
        message: 'Time Bank Armed. It Starts When Your Clock Runs Out',
      };
    }

    const before = this.timeBankEngine.getRemainingSeconds(this.tableId, userId);
    /* The expiry callback is EMPTY ON PURPOSE, and this comment is why: do not
       "fix" it later by folding here. On a turn, TimeBankEngine's countdown is
       the enforcement deadline, so its onExpire has to act. In the discard
       round the enforcement deadline is the per-seat map below, swept by
       armPineappleDiscardSweep - and that sweep is re-armed to the very
       deadline this grant produces. Folding from both would be two deadlines
       under different keys racing on one decision, which is precisely the bug
       TimeBankEngine's own history records ("two deadlines under different
       keys on the same PreciseActionTimer, both live, and the shorter one
       folded the player while the clock on screen was still counting down").
       One enforcer: the sweep. */
    const result = this.timeBankEngine.tryActivate(this.tableId, userId, () => {}, remaining);
    if (result !== 'activated') {
      return {
        success: false,
        error:
          result === 'depleted' || result === 'not_initialized'
            ? 'No Time Bank Uses Remaining'
            : result === 'street_limit'
              ? 'No Time Bank Uses Left On This Street'
              : 'Your Time Bank Is Already Running',
      };
    }

    /* The grant is what the bank actually released, not a hard-coded 20 — a
       player down to 6 seconds of pool gets 6, and the deadline we publish is
       the deadline we enforce. */
    const granted = Math.max(
      0,
      before - this.timeBankEngine.getRemainingSeconds(this.tableId, userId)
    );
    const seconds = granted > 0 ? granted : before;
    const extended = Date.now() + seconds * 1000;
    this.pineappleDiscardDeadlines.set(seat, extended);
    this.armPineappleDiscardSweep(this.handController);
    this.broadcastCurrentState();
    return { success: true, deadlineMs: extended };
  }

  /**
   * Drop deadline entries for seats that no longer owe a discard, and drop the
   * whole map once the round is over. The HandController's own set is the
   * authority; this map is a cache of it that exists only to carry the extra
   * time a time bank bought for one seat.
   */
  protected pruneSettledPineappleDeadlines(): void {
    const hc = this.handController;
    if (!hc || hc.getState().stage !== 'pineapple_discard') {
      this.pineappleDiscardDeadlines.clear();
      this.pineappleDiscardBaseDeadlineMs = null;
      this.pineappleDiscardDurationMs = 0;
      return;
    }
    for (const seat of [...this.pineappleDiscardDeadlines.keys()]) {
      if (!hc.owesPineappleDiscard(seat)) this.pineappleDiscardDeadlines.delete(seat);
    }
  }

  protected clearLooseHandTimers(): void {
    /* PHASE 3 2026-08-31: the discard settle beat is a timer on the hand
       controller, and this is the one place that knows a hand is being torn
       down. Without it a superseded hand's beat could advance a stage on a
       controller nobody is reading any more. */
    this.handController?.cancelPineappleSettle?.();
    this.cancelHorseDecisionWork();
    if (this.pineappleDiscardTimer) {
      clearTimeout(this.pineappleDiscardTimer);
      this.pineappleDiscardTimer = null;
    }
    this.pineappleDiscardDeadlines.clear();
    this.pineappleDiscardBaseDeadlineMs = null;
    this.pineappleDiscardDurationMs = 0;
  }

  // FIX 2 (2026-07-24): per-hand hole cards kept in memory so we can (a) retry
  // the RLS insert and (b) re-push a player's cards on reconnect/RESYNC. The
  // public snapshot is re-sent by the hub, but hole cards ride a separate
  // (table_hole_cards) transport that was never re-delivered. Map<userId,...>.
  protected currentHandHoleCards: Map<string, { seat: number; cards: unknown }> = new Map();

  // Per-hand tracking
  protected currentHandWentToFlop: boolean = false;
  protected currentHandPotSize: number = 0;
  protected currentHandDealerSeat: number = 0;
  protected currentHandWinnerIds: string[] = [];
  protected currentHandRake: number = 0;
  protected currentHandBBJFee: number = 0;
  protected currentHandCommunityCards: string[] = [];
  /** DOUBLE-BOARD BOMB POT 2026-08-20: board 2 accumulator (empty unless active). */
  protected currentHandCommunityCards2: string[] = [];
  /** TRIPLE-BOARD BOMB POT 2026-08-27: board 3 accumulator (empty unless active). */
  protected currentHandCommunityCards3: string[] = [];
  /**
   * BOMB POT STANDARDIZATION 2026-08-27 (spec §20): the bomb-pot facts of the
   * current hand, frozen at trigger time for hand_history.bomb_pot. Null on
   * normal hands. Reset per hand alongside the accumulators above.
   */
  protected currentHandBombPot: {
    trigger_reason: string;
    ante_amount: number;
    board_count: number;
    /** VARIANT OVERRIDE 2026-08-28: the variant the bomb hand was dealt as. */
    variant?: string;
  } | null = null;
  /**
   * VARIANT OVERRIDE 2026-08-28 (spec §10.1): the variant the CURRENT hand
   * was dealt as, captured at hand start. Settlement writes hand_history from
   * this rather than from tableInfo.game_variant, which lies on every
   * variant-override bomb hand. Null between hands.
   */
  protected currentHandVariant: string | null = null;
  /**
   * Round 2: per-board winner breakdown from the WINNERS event (double board
   * only). Amounts are PRE-rake shares — clients use board + handName for
   * labeling; the shipped amounts come from the merged winners list.
   *
   * POKERBROS PARITY 2026-08-26: `board` widened from 1|2 to number — a
   * run-it-twice/three-times hand populates this with the RUN index (1..3),
   * the same axis the double-board bomb pot uses for its two boards.
   */
  /**
   * userId -> the last heartbeat that said the bust-rebuy dialog was open for
   * this player (2026-09-04). Written by heartbeat() in Turns, read by
   * standUpBustedCashPlayers() in Dealing, which will not release a seat
   * whose owner is at the cashier.
   */
  protected rebuyPromptOpenAt: Map<string, number> = new Map();

  protected currentHandWinnersByBoard: Array<{
    board: number;
    userId: string;
    amount: number;
    handName?: string;
    /** HI-LO: the low half's entry (2026-09-04). */
    low?: boolean;
    /** Per-pot slices of this share, main pot first (2026-09-13). */
    pots?: Array<{ index: number; amount: number }>;
  }> = [];
  /**
   * SHOWDOWN POLISH 2026-08-25 (spec 16/19/33): the unmerged per-pot(-half)
   * award breakdown from the WINNERS event — one entry per (board, pot,
   * hi/lo half, winner) with that pot's exact post-rake display share.
   * Feeds pot_win's pot_awards groups. Reset per hand in dealHand.
   */
  protected currentHandPerPotAwards: Array<{
    userId: string;
    potIndex: number;
    low: boolean;
    amount: number;
    hand?: { name?: string; ranking?: number; cards?: Array<{ rank?: string; suit?: string }> };
    /** 1|2 on double-board bomb pots; RUN index 1..3 on run-it-twice hands. */
    board?: number;
    /** Review fix 2026-08-25: this entry's own engine-generated description. */
    handDescription?: string;
  }> = [];
  // Round 38: track wall-clock start so logHandHistory can write started_at +
  // ended_at (was missing — every completed hand_history row had null
  // ended_at, breaking replay timestamps and audit reconciliation).
  protected currentHandStartedAt: number = 0;
  // chip-std Lane F (2026-09-02): what every dealt player held when the cards
  // went out, keyed by user id. On a tournament table the settled stacks of
  // exactly these players must sum to exactly this - see
  // tournamentChipConservation.ts and the persist gate in postHandTasks.
  protected currentHandDealtStacks: Map<string, number> = new Map();
  protected currentHandSeatGenerations: Map<string, HandSeatGeneration> = new Map();
  // Bible V8 §2.5: Action Record requires seat, userId, action, amount, timestamp, stage
  protected currentHandActions: {
    seat: number;
    userId: string;
    action: string;
    amount?: number;
    timestamp: number;
    stage: string;
    /** V12.3: a short all-in is not a raise (TDA 44). Persisting this makes
     *  hand_history replayable by HorseMind, which requires it to count an
     *  all-in as aggression at all. */
    isFullRaise?: boolean;
    /** 2026-08-27: set on forced-money rows that are DEAD — an ante, or the
     *  small-blind half of a dead blind. Dead money is in the pot but is not
     *  part of the live bet level, so it never counts toward a call and must
     *  not be differenced against a raise-TO level. */
    dead?: boolean;
  }[] = [];
  protected currentHandWinners: {
    userId: string;
    amount: number;
    potIndex?: number;
    /**
     * `cards` added 2026-08-21: the exact five cards the evaluator chose for
     * this winner. It was always present on the Winner the engine receives
     * (EvaluatedHand.cards) and was being narrowed away here, which is why
     * the board could name a winning hand but never light the cards that
     * made it. pot_win now carries the board indices.
     */
    hand?: { name: string; ranking: number; cards?: Array<{ rank?: string; suit?: string }> };
  }[] = [];
  /**
   * POT-LEVEL SETTLEMENT (Dan section 29, 2026-08-25).
   *
   * The pots as `calculatePots()` returned them at the moment the hand was
   * scored — before distribution, so `eligible` still names everyone who had
   * a claim on each pot. Persisted to `hand_history.pots`.
   *
   * It is captured rather than recomputed because after settlement the answer
   * is gone: `HandController.getPots()` recalculates from the live players,
   * and by then the winners' stacks have already moved. This is the only
   * moment the true breakdown exists.
   *
   * Read back by `attributeKnockout()` to credit a knockout to the winner(s)
   * of the pot that held the busted player's LAST chips rather than to
   * whoever won the most money in the hand. Without it, a short stack busting
   * against a large side pot paid its bounty to the side-pot winner.
   */
  protected currentHandPots: { index: number; amount: number; eligible: string[] }[] = [];
  /**
   * userId → ELIGIBLE contribution (engine totalInvested, which is net of any
   * returned uncalled bet). This is the authoritative basis for WEIGHTED
   * CONTRIBUTED rake attribution (Dan 2026-08-29).
   */
  protected currentHandContributions: Map<string, number> = new Map();
  /**
   * userId → uncalled amount returned to the player this hand. Persisted for
   * audit alongside contributions (gross = eligible + returned). Zero-entry
   * players are omitted.
   */
  protected currentHandReturnedUncalled: Map<string, number> = new Map();
  protected currentHandInsuranceSettlements: InsuranceSettlement[] = [];
  /**
   * Chip standard 2026-09-04: the net the insurance bank moved onto (+) or off
   * (-) the seats of THIS hand - payouts and EV cash-outs in, premiums and EV
   * redirects out - as actually applied after clamping. The hand's stack write
   * declares it as `inflow`, because the database asserts
   * sum(delta) = inflow - rake - bbj on every hand and an insured hand would
   * otherwise be refused as a conservation violation.
   */
  protected currentHandInsuranceNet: number = 0;
  /**
   * EV CASHOUT 2026-08-28: pot winnings clawed back to the bank for each
   * cashed-out player this hand (what the bank actually collected, post-
   * clamp). Feeds the insurance ledger's bank-in side.
   */
  protected currentHandCashoutRedirects: Map<string, number> = new Map();
  protected currentHandBBJHit: BBJDetectionResult | null = null;
  protected currentHandBBJPayoutConfig: ServerRakeConfigResult | null = null;
  /**
   * The MINI jackpot (BBJ phase 6): a flat amount out of the backup reserve
   * for a hand that came close to the main bar. Held separately from
   * currentHandBBJHit on purpose - the two pay from different banks through
   * different RPCs, and merging them into one field is how a mini would come
   * to be paid at main-jackpot size.
   */
  protected currentHandMiniBBJHit: BBJDetectionResult | null = null;
  protected currentHandMiniBBJTierId: string | null = null;
  /**
   * Rabbit hunt purchases currently mid-flight, by userId. Two taps that race
   * the RPC both pass the `revealed` check (that set is written only after the
   * charge returns), so without this they would both succeed and bill twice.
   */
  protected rabbitHuntInFlight: Set<string> = new Set();
  /** Diamond price of a rabbit hunt, read once from `feature_pricing`. */
  protected rabbitHuntCostCache: number | null = null;
  /**
   * Rabbit hunt offers, keyed by hand number. Dan 2026-08-25.
   *
   * These cards are NEVER broadcast. They are held server-side and released to
   * one authenticated player at a time by revealRabbitHunt(), after
   * fn_consume_rabbit_hunt has actually taken payment.
   *
   * Keyed by hand rather than kept in a single field because a player has a few
   * seconds to click and the next hand may already be dealing by the time they
   * do — a single field is wiped at the next deal and the purchase would return
   * either nothing or, worse, the NEXT hand's undealt cards. Trimmed to the
   * last two hands at capture, so it stays bounded on a table running for days.
   *
   * `eligible` is who was dealt into that hand: a spectator cannot buy a look
   * at a hand they were never part of, and `revealed` makes a paid reveal
   * repeatable for the buyer without charging them twice.
   */
  protected rabbitHuntOffers: Map<
    number,
    {
      cards: import('../types.js').Card[];
      boardLength: number;
      eligible: Set<string>;
      revealed: Set<string>;
      offeredAt: number;
    }
  > = new Map();
  /**
   * RIT VERIFIER FIX 2026-08-21: number of boards dealt by Run It Twice this
   * hand (0 = normal hand). Every RIT-resolved hand tripped the state
   * verifier's COMMUNITY_CARD_COUNT warning at showdown — the multi-board
   * runout deals its boards in dealAndResolveRIT's own arrays, so the main
   * communityCards keeps only the shared pre-all-in prefix (0 cards for a
   * preflop all-in, 4 for a turn all-in) while the stage reads 'showdown'.
   * Three false WARNINGs in 30 minutes of live traffic — noise that would
   * bury a REAL missing-board violation. The count is passed to the verifier
   * so it can skip the board-behind-stage check for multi-board hands (each
   * RIT board is independently guaranteed 5 cards by the 2026-08-18 rake
   * fix invariant).
   */
  protected currentHandRitBoards = 0;
  /**
   * POKERBROS PARITY 2026-08-26: community cards already on the felt when the
   * RIT all-in locked (0 preflop, 3 flop, 4 turn). The hand-completion hold
   * derives the reveal-timeline length from it (streets per board = the
   * streets still to deal), so the next hand waits for the client's
   * street-by-street reveal to finish. Reset with currentHandRitBoards.
   */
  protected currentHandRitBaseBoardCount = 0;
  /**
   * COMPLETENESS PASS 2026-08-26: boards 2..N of a run-it-twice hand, engine
   * card strings ('Ahearts'), in run order. Persisted first-class to
   * hand_history.rit_boards at settlement — the changelog's long-standing
   * "persist the extra board(s)" item. The `rit_board_N:` pseudo-actions
   * remain for older readers; this column is the canonical record now.
   */
  protected currentHandRitExtraBoards: string[][] = [];
  protected currentHandShowdownResults: Array<{
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards: Array<{ rank: string; suit: string }>;
    /**
     * SHOWDOWN SYSTEM 2026-08-25: engine-decided reveal metadata. seat +
     * revealOrder drive the client's staggered flip; mucked withholds the
     * hole cards from every public surface (snapshot, resync,
     * showdown_cards_revealed) unless the player voluntarily shows;
     * handDescription is the secondary line ("Kings Full Of Nines").
     */
    seat?: number;
    revealOrder?: number;
    mucked?: boolean;
    handDescription?: string;
  }> = [];

  /**
   * SHOWDOWN SYSTEM 2026-08-25: true when the player mucked at showdown and
   * has not voluntarily shown the WHOLE hand — the one question every reveal
   * gate asks. A whole-hand voluntary show (showHandPlayers) overrides the
   * muck: mucking hides by default, showing is consent.
   *
   * AUDIT NOTE 2026-08-25 (doc/code drift fixed): per-card picks
   * (showHandCards) deliberately do NOT clear the muck. A mucked player who
   * marked one card gets exactly that card exposed through the snapshot's
   * partialReveal branch while the REST of the hand — and its identity
   * (hand_name / ranking / description) — stays private. That is the whole
   * point of a per-card pick: show the bluff card, keep the hand mucked.
   */
  protected isMuckedAtShowdown(userId: string): boolean {
    if (this.showHandPlayers?.has(userId)) return false;
    return this.currentHandShowdownResults.some((r) => r.userId === userId && r.mucked === true);
  }
  /** Bible V8 §2.15: Timer log — every timer start/expiry/action event */
  protected currentHandTimerLog: Array<{
    playerId: string;
    event:
      | 'timer_start'
      | 'timer_expired'
      | 'action_received'
      | 'time_bank_activated'
      | 'time_bank_expired';
    timestamp: number;
    durationMs?: number;
    timeBankUsed?: boolean;
  }> = [];
  /** Bible V8 §2.16: Notification log — every notification sent during hand */
  protected currentHandNotificationLog: Array<{
    playerId: string;
    type: string;
    channel: 'push' | 'in_app' | 'sound' | 'haptic';
    timestamp: number;
    delivered: boolean;
  }> = [];
  // Post-hand scheduling callback. Settlement invokes it synchronously for a
  // zero final stack even if a persistence mirror failed; consumers must stay
  // fire-and-forget and independently verify durable authority.
  protected handCompleteCallback:
    | ((tableId: string, players: { user_id: string; stack: number }[]) => void)
    | null = null;
  /**
   * Exact hand-for-hand barrier signal. The tournament coordinator used to
   * rediscover this state by polling every table twice a second. Emitting at
   * the transition that creates the wait makes the engine state itself the
   * authority and removes that periodic correctness dependency.
   */
  private pauseReadyCallback: ((tableId: string) => void) | null = null;
  // Hand-for-hand pause: set by tournament manager, checked between hands
  protected handForHandPaused: boolean = false;
  /** Wall-clock when the current by-design pause began; 0 when not paused. */
  protected pausedSinceMs: number = 0;
  /** Last time the paused-too-long alarm fired, so it reports once per window. */
  protected lastPauseAlarmAtMs: number = 0;
  protected handForHandResolve: (() => void) | null = null;
  /** Escape deadline for the current pause wait; cleared on every real release. */
  private pauseGateTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Safety-timeout budget for the current pause, in ms. null = the default
   * hand-for-hand budget. Set by pauseAfterHand() so a synchronized break can
   * outlast the short hand-for-hand window without self-resuming.
   */
  protected pauseMaxWaitMs: number | null = null;
  protected pauseRequiresExplicitResume = false;
  /**
   * DOES THIS PAUSE FORBID THE NEXT HAND, OR ONLY THE ONE AFTER IT?
   *
   * The two callers of pauseAfterHand want opposite things, and conflating
   * them deadlocks one of them:
   *
   *   - A SYNCHRONIZED BREAK (and the add-on break, and a drain) means STOP.
   *     The hand in flight finishes, and no further hand is dealt until the
   *     break ends. A table that was idle at :55 must park without dealing.
   *     -> beforeNextHand: true.
   *
   *   - HAND-FOR-HAND means DEAL EXACTLY ONE MORE HAND, THEN STOP. The bubble
   *     sync resumes every table together and re-pauses them 500ms later,
   *     deliberately, "to let dealing start" — it is arming the park for the
   *     hand that is about to be dealt. If the top-of-loop gate honoured that
   *     re-pause, the table would park BEFORE dealing, the sync would see
   *     everyone parked, resume, re-pause, and park again — the bubble would
   *     never burst and the tournament would freeze on the money.
   *     -> beforeNextHand stays false, and only the post-deal gate parks.
   *
   * Cleared by resumeDealing along with the rest of the pause state.
   */
  protected holdBeforeNextHand: boolean = false;

  /**
   * THE MAINTENANCE BREAK IS A SECOND, INDEPENDENT PAUSE AUTHORITY.
   * (Dan 2026-09-01)
   *
   * It cannot share `handForHandPaused`, and the audit that found this is
   * worth writing down. Hand-for-hand runs a 500ms sync loop
   * (TournamentManagerBase, "all tables waiting -> resumeDealing -> re-pause
   * in 500ms"). With a single flag, a bubble tournament at :55 did this:
   *
   *   1. the maintenance break parks its tables;
   *   2. the sync loop sees every table waiting, concludes the hand-for-hand
   *      round is over, and calls resumeDealing - DEALING A FULL HAND
   *      INSIDE THE BREAK;
   *   3. resumeDealing clears pauseMaxWaitMs and holdBeforeNextHand, and the
   *      500ms re-park is a bare pauseAfterHand() with no budget - so the
   *      safety timeout falls back to 120s and the table SELF-RESUMES two
   *      minutes into a five minute break.
   *
   * That last step is the exact 2026-08-19 bug PARK_BUDGET_MS was sized to
   * prevent, reintroduced through a different door.
   *
   * So: whoever paused a table is the only one who may resume it.
   * `resumeDealing` lifts hand-for-hand and leaves this alone;
   * `resumeFromMaintenance` does the reverse. The gate holds while EITHER
   * is set.
   */
  protected maintenancePaused: boolean = false;

  /**
   * A unanimous final-table deal owns its own between-hands pause.
   *
   * This cannot reuse `handForHandPaused`: the bubble synchronizer is allowed
   * to lift that flag every round. It cannot reuse `maintenancePaused`
   * either: the platform break is allowed to lift only the pause it created.
   * Keeping a third authority means a slow guarantee read or atomic deal call
   * cannot race a new hand, and one resume path can never cancel another.
   */
  protected finalTableDealPaused: boolean = false;

  /**
   * Terminal tournament closeout owns a stricter gate than an ordinary pause.
   *
   * Once armed, elapsed time may make the closeout caller stand down, but it
   * may never make the table deal again.  Only the caller that received a
   * proven pre-commit refusal may explicitly release this authority.  The
   * waiters are event-driven so settlement completion, the physical pause
   * edge, or an engine stop wakes the closeout without a polling reconciler.
   */
  protected terminalCloseoutPaused: boolean = false;
  /**
   * A tournament seat move owns the source felt until its one atomic receipt
   * returns.  The owner is the exact TournamentManager generation, not a
   * boolean: overlapping pause authorities cannot release one another.
   *
   * An unclaimed owner is deliberately retained while the current hand lands.
   * Once the loop reaches the physical pause gate it gets a short expiry, so a
   * planner that no longer wants the move cannot strand an otherwise healthy
   * table.  A claimed owner has no elapsed-time escape; the bounded RPC's
   * finally block is the only release authority.
   */
  protected tournamentMovePauseOwners: Set<string> = new Set();
  protected claimedTournamentMovePauseOwners: Set<string> = new Set();
  private tournamentMovePauseExpiryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private tournamentMoveOperations: Set<Promise<void>> = new Set();
  private tournamentMoveOperationByOwner: Map<string, Promise<void>> = new Map();
  protected boundaryPauseWaiters: Set<() => void> = new Set();
  protected terminalBoundaryPersistenceGeneration = 0;
  protected terminalBoundaryPendingGenerations: Set<number> = new Set();
  protected terminalBoundaryPersistenceFailed = false;
  protected terminalCloseoutDiscardedPreparedHand = false;

  // Bible V8 §1.1.4: Action serialization lock — prevents parallel action processing
  protected actionLock: boolean = false;

  // FIX 211: Bible V8 §1.9 — Track postHandTasks promise to prevent next hand
  // starting before DB stacks are synced (was fire-and-forget, risked stale stacks)
  protected postHandTasksPromise: Promise<void> | null = null;
  // Serialize financial departure against asynchronous hand preparation.
  // Release after controller start, not after the hand finishes.
  protected seatBoundaryTail: Promise<void> = Promise.resolve();
  protected async acquireSeatBoundary(): Promise<() => void> {
    if (this.terminal) throw new Error('Table Engine Is Stopping');
    const previous = this.seatBoundaryTail;
    let release!: () => void;
    this.seatBoundaryTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    if (this.terminal) {
      release();
      throw new Error('Table Engine Is Stopping');
    }
    return release;
  }

  // 2026-09-06: the drain's view of the same fact, cleared by the promise
  // rather than by the next hand. See trackSettlementInFlight().
  protected settlementInFlight: Set<Promise<void>> = new Set();
  private settlementStartedAtMs: number | null = null;

  /**
   * The one dealing-loop generation owned by this engine instance.
   *
   * This promise is deliberately retained until stop() has joined it.  A
   * detached loop can still finish a hand and create its settlement after the
   * terminal fence is published; releasing process ownership before that
   * continuation exits lets a replacement engine write beside it.
   */
  private dealingLoopPromise: Promise<void> | null = null;

  // FIX 147: Bible V8 §6.3 — Periodic heartbeat check to detect disconnects mid-hand
  // Without this, disconnects are only detected between hands in dealingLoop().
  // Phase 1.2 PR-G-real: rescheduled every 10s through DeadlineScheduler instead
  // of setInterval. The eventId is a constant per table; the callback re-arms
  // itself for the next tick. `heartbeatActive` lets stop() short-circuit any
  // in-flight callback that fires after cancel().
  protected static readonly HEARTBEAT_EVENT_ID = 'heartbeat_check';
  protected static readonly HEARTBEAT_INTERVAL_MS = 10_000;
  protected heartbeatActive: boolean = false;

  /**
   * 2026-08-15 FREEZE FIX (Dan: "the game keeps freezing and not auto playing
   * after a while — get to the root cause and prevent it").
   *
   * Epoch ms of the last OBSERVABLE progress on this table: an accepted action,
   * a turn change, a street dealt, a hand started or settled. `running` cannot
   * serve this purpose — it is a boolean the dealing loop never clears when it
   * dies, so a table whose loop has crashed still reports isRunning() === true
   * forever. That is why ten production tables sat dead for 18+ minutes on
   * 2026-08-15 while discoverCashTables refused to rebuild them: the engines
   * were zombies claiming to be alive.
   */
  protected lastProgressAtMs: number = Date.now();

  /** Consecutive watchdog trips without intervening progress. Escalation tier. */
  protected watchdogTrips: number = 0;

  /**
   * Provenance for the recovery chain after an injected stall. A re-arm can
   * fail and escalate to a kill, so the class survives intermediate records
   * until genuine progress or terminal teardown ends that exact chain.
   */
  protected pendingRecoveryEventClass: EngineRecoveryEventClass | null = null;

  /** 15s clock + 15s time bank + 2s grace + slack. */
  protected static readonly WATCHDOG_STALL_MS = 45_000;

  /** No hand started while the table is dealable. */
  protected static readonly WATCHDOG_IDLE_MS = 90_000;

  /**
   * The longer horizon for a dealing loop that is CYCLING but never dealing.
   *
   * WATCHDOG_IDLE_MS answers "has a hand started lately", which a table
   * waiting on a slow database answers wrongly — and on 2026-08-22 that wrong
   * answer killed every cash table in the fleet 22-30 times in six hours. A
   * loop that is still moving between steps is alive; if it is alive and STILL
   * has not dealt after five minutes with two funded seats, that is a real
   * fault, but it is a different one and it gets its own name.
   */
  protected static readonly WATCHDOG_LOOP_ALIVE_IDLE_MS = 5 * 60_000;

  /**
   * Per-step budget for the between-hands Supabase round trips. Deliberately
   * well under WATCHDOG_IDLE_MS: each step re-stamps the loop phase, so five
   * budgeted steps can outlast the idle window without ever looking wedged.
   */
  protected static readonly DEAL_STEP_BUDGET_MS = 20_000;
  /** Time a physically parked but unclaimed balancer fence may wait for its next sweep. */
  private static readonly TOURNAMENT_MOVE_UNCLAIMED_PARK_MS = 15_000;

  /**
   * Attempts at the opening `loadTable` before start() gives up and lets the
   * engine be rebuilt. Five attempts with exponential backoff span roughly
   * eight seconds — longer than any blip, far shorter than the 180s reaper.
   */
  protected static readonly START_LOAD_ATTEMPTS = 5;
  /**
   * A by-design pause older than this is reported (never killed): 15 min
   * exceeds any plausible hand-for-hand or break coordination window.
   */
  protected static readonly PAUSE_ALARM_MS = 15 * 60_000;

  // Real Player Turn Management
  // Phase 1.2: playerTurnTimer deleted — DeadlineScheduler via PreciseActionTimer is sole timer authority.
  protected playerTurnStartTime: number = 0;
  protected playerTurnDuration: number = 0;
  protected timeBankActivatedThisTurn: boolean = false;
  /**
   * Set when the player whose turn it is drops out of reconnect grace.
   *
   * A time bank is a use-it-or-lose-it asset the player PAYS for. Auto-
   * activating one for somebody whose socket is gone spends it on a decision
   * they cannot make. Cleared by handleTurnChange, so a reconnect inside the
   * same turn restores the normal behaviour, and by every genuinely new turn.
   *
   * This deliberately does NOT touch any deadline. See
   * handlePlayerDisconnectedMidTurn (ServerTableEngineTurns) for why.
   */
  protected timeBankSuppressedThisTurn: boolean = false;
  protected showHandPlayers: Set<string> | null = null; // Bible V8 §4.21: players who voluntarily show hand

  /**
   * ── Dan 2026-08-18: per-CARD voluntary reveal ──
   * "a user should be able to click on any card in their hand, and when
   *  clicked that card or cards always get shown after the hand is over."
   *
   * showHandPlayers is all-or-nothing and only accepts input during showdown.
   * This map holds the finer-grained intent: userId -> the set of hole-card
   * INDEXES that player elected to expose. It is deliberately writable at any
   * point in the hand, because the click happens while the player is still
   * holding the cards - only the reveal is deferred to hand end.
   *
   * It never hides anything that would otherwise be shown; it only adds. A
   * player already revealed by the showdown rule shows everything regardless,
   * and a folded player is still never exposed.
   *
   * Reset per hand alongside showHandPlayers.
   */
  protected showHandCards: Map<string, Set<number>> | null = null;

  // ── Step 4: Ported Core Modules ──
  protected preciseTimer: PreciseActionTimer;
  protected actionValidator: ServerActionValidator;
  protected stateVerifier: StateVerifier;

  // ── Step 5: Ported Supporting Modules ──
  protected timeBankEngine: TimeBankEngine;
  /**
   * VIP time banks 2026-08-17: per-player session accounting. Every player
   * gets a free session base (Bible V8 6.2: 30s); VIP monthly quota
   * (120s/month) and diamond-purchased extensions come from the DB via
   * fn_time_bank_allowance and are consumed via fn_consume_time_bank.
   * initialSeconds/baseSeconds/dbConsumedSeconds let the accounting hook
   * compute exactly how much of each use is DB-backed.
   */
  protected timeBankMeta: Map<
    string,
    { initialSeconds: number; baseSeconds: number; dbConsumedSeconds: number }
  > = new Map();
  /**
   * Free time-bank seconds every player starts a session with, before any VIP
   * allowance or purchased extension. 2 banks × 20s (Dan 2026-08-18). Was 30
   * (2 × the old 15s grant); it moves with secondsPerUse so a player keeps
   * getting two WHOLE extensions rather than one and a stub.
   */
  protected readonly timeBankBaseSeconds = 40;
  /**
   * CHIP CONTINUITY (Operation Table Stakes, Slice 0). The engine-side mirror
   * of cash_player_session: the stay clock a player ahead of their buy-in
   * serves before they can leave. The database owns it; this reports
   * transitions and renders the answer. See ChipContinuity.ts.
   */
  protected chipContinuity: ChipContinuityTracker;
  /**
   * CHIP CONTINUITY: players whose leave was REFUSED at settlement (they won
   * the hand they asked to leave during and are now ahead with clock left).
   * They asked to go, so the clock counts for them even though they are sat
   * out, and the heartbeat tick opens the door the moment it reaches zero.
   * Sitting back in withdraws the request. Not persisted: after a restart the
   * seat is an ordinary sat-out seat and the sit-out eviction handles it.
   */
  protected leaveHeldByClock: Map<string, string> = new Map();
  /** CHIP CONTINUITY: mid-hand leaves that are system exits (admin kick). */
  protected disconnectEngine: DisconnectEngine;
  protected preActionEngine: PreActionEngine;
  protected atomicStackService: AtomicStackService;

  // ── Step 6: Ported Advanced Modules ──
  protected straddleEngine: StraddleEngine;
  protected runItTwiceEngine: RunItTwiceEngine;
  protected insuranceEngine: InsuranceEngine;

  // ── Step 7: Ported Tournament & Extras Modules ──
  protected chipRaceEngine: ChipRaceEngine;
  protected tableBalancer: TableBalancer;
  protected tableBreakEngine: TableBreakEngine;
  protected engineTelemetry: EngineTelemetry;

  constructor(tableId: string, leaseAuthority: EngineLeaseAuthority | null = null) {
    this.tableId = tableId;
    this.engineLeaseScope = leaseAuthority?.scope ?? null;
    this.engineLeaseVerified = leaseAuthority?.verified ?? false;
    this.engineLeaseGeneration = leaseAuthority?.generation ?? null;
    this.engineLeaseTournamentId =
      leaseAuthority?.scope === 'tournament' ? leaseAuthority.tournamentId : null;
    this.engineLeaseProofDeadlineMonotonicMs = leaseAuthority?.proofDeadlineMonotonicMs ?? null;
    this.ready = new Promise<boolean>((resolve) => {
      this.settleReady = resolve;
    });
    // Construction does not confer table ownership. GameServer first admits
    // this exact generation into its table map; start() then claims the shared
    // scheduler slot with compare-and-swap semantics. A merely constructed
    // contender therefore cannot supersede the dealer it is racing.

    this.chipContinuity = new ChipContinuityTracker({
      tableId,
      isCash: () =>
        !!this.tableInfo && this.tableInfo.arena?.asset !== 'diamonds' && !this.isTournamentTable(),
      isFrozen: () => isMaintenanceFrozen(),
      canMutate: () => this.lifecycleCanMutate(),
      evaluate: evaluateCashSessions,
      report: reportError,
    });

    // Initialize ported core modules
    // Routine start/cancel/expiry events need no console observer. The
    // timer still owns its expiry callbacks and reports callback failures.
    // Live sample 2026-09-08: 855 log writes per 10 seconds across the fleet.
    this.preciseTimer = new PreciseActionTimer();
    this.actionValidator = new ServerActionValidator((event) => {
      console.warn(
        `[ServerTableEngine:${tableId}] Action rejected: ${event.code} - ${event.reason}`
      );
    });
    this.stateVerifier = new StateVerifier((event) => {
      // 2026-08-17: SAY WHICH CHECK FIRED.
      //
      // This used to report only the COUNT — "1 issue(s) in hand #58" — and
      // discard event.violations entirely. Production is emitting these on 236
      // distinct hands per hour, and from the message alone it was impossible
      // to tell whether that was a benign COMMUNITY_CARD_COUNT blip or a
      // CHIP_CONSERVATION / DUPLICATE_CARD event, which are money- and
      // dealing-integrity failures. A verifier that fires but will not say what
      // it found cannot be triaged, so in practice it was ignored.
      //
      // The Sentry fingerprint is now per violation TYPE rather than one bucket
      // for everything, so a rare DUPLICATE_CARD cannot stay buried under
      // thousands of routine events. It is also greppable per class:
      //   grep 'STATE INTEGRITY' | grep CHIP_CONSERVATION
      const detail = event.violations
        .map((v) => `${v.severity.toUpperCase()} ${v.type}: ${v.message}`)
        .join(' | ');
      const types = [...new Set(event.violations.map((v) => v.type))].sort().join(',');
      reportError(
        new Error(
          `[ServerTableEngine:${tableId}] STATE INTEGRITY VIOLATION in hand #${event.handNumber} ` +
            `(${event.violationCount} issue(s)) [${types}] ${detail}`
        ),
        `ServerTableEngine.STATE_INTEGRITY_VIOLATION.${types || 'UNKNOWN'}`
      );
    });

    // Step 5: Initialize supporting modules
    this.timeBankEngine = new TimeBankEngine(this.preciseTimer, (event) => {
      console.log(
        `[ServerTableEngine:${tableId}] TimeBank: ${event.type} player=${event.playerId}`
      );
      this.onTimeBankAccounting(event);
    });
    this.disconnectEngine = new DisconnectEngine(this.preciseTimer, (event) => {
      console.log(
        `[ServerTableEngine:${tableId}] Disconnect: ${event.type} player=${event.playerId}`
      );
      // AUDIT FIX 2026-07-19: when a player reconnects DURING their own turn,
      // the disconnect countdown is cancelled but no action timer was ever
      // armed (onPlayerTurn returned false and handleTurnChange bailed). The
      // hand then stalls until the 10-minute void — a griefing / stack-reclaim
      // exploit. Re-arm the normal turn timer for the reconnecting player.
      // SIT-OUT VISIBILITY 2026-08-21: DisconnectEngine state was in-memory
      // only — nothing ever wrote table_seats.is_sitting_out, yet that column
      // is the client's source of truth (initial seat load AND the realtime
      // table_seats subscription both map it to the greyed seat state). A
      // sat-out player — voluntary or forced after 3 timeouts — looked fully
      // active to everyone, including themselves. Persist both transitions;
      // fire-and-forget, the UI write must never affect gameplay.
      if (event.type === 'PLAYER_SAT_OUT' || event.type === 'PLAYER_SAT_BACK') {
        const sittingOut = event.type === 'PLAYER_SAT_OUT';
        const satPlayer = this.seatedPlayers.find((p) => p.user_id === event.playerId);
        const occupancyId = satPlayer?.occupancy_id;
        /* A horse the strike ladder sat out has lost its seat: nothing on the
           platform sits a horse back in (sitBack is POST /sitout only), so a
           cash seat is evicted after 2 orbits / 5 minutes and a tournament
           seat is blinded off. Counted fleet-wide so it can page (Dan
           2026-09-11). Twelve were parked this way at 14:55 UTC that day. */
        if (sittingOut && event.reason === 'forced' && satPlayer?.is_horse) {
          try {
            EngineMetrics.horseForcedSitOutsTotal.inc(1, { format: this.tableFormat() });
          } catch {
            /* metrics must never affect gameplay */
          }
        }
        if (!occupancyId) return;
        void Promise.resolve(
          supabase
            .from('table_seats')
            .update({ is_sitting_out: sittingOut })
            .eq('table_id', this.tableId)
            .eq('user_id', event.playerId)
            .eq('occupancy_id', occupancyId)
            .is('left_at', null)
        )
          .then(({ error }) => {
            if (error) {
              reportError(
                new Error(`persist is_sitting_out=${sittingOut} failed: ${error.message}`),
                'ServerTableEngine.' + this.tableId + '.sitout_persist_failed'
              );
            }
          })
          .catch((err) => {
            reportError(err, 'ServerTableEngine.' + this.tableId + '.sitout_persist_threw');
          });
      }
      if (event.type === 'PLAYER_DISCONNECTED') {
        this.handlePlayerDisconnectedMidTurn(event.playerId);
      }
      if (event.type === 'PLAYER_RECONNECTED') {
        // ── ADDITIVE observability (#5): WS reconnect counter ──
        try {
          EngineMetrics.wsReconnectsTotal.inc(1);
        } catch {
          /* metrics must never affect gameplay */
        }
        this.rearmTurnTimerIfCurrent(event.playerId);
        // FIX 2 (2026-07-24): re-deliver hole cards for the current hand. The
        // public snapshot is re-sent by the hub on reconnect, but hole cards
        // are not — without this a reconnecting player sees a live action
        // clock but a blank hand and gets auto-folded at the deadline.
        void this.rePushHoleCards(event.playerId);
      }
    });
    this.preActionEngine = new PreActionEngine((event) => {
      console.log(
        `[ServerTableEngine:${tableId}] PreAction: ${event.type} player=${event.playerId}`
      );
      /* 2026-09-04 (disconnect audit item 11): THE ENGINE'S COPY IS THE ONE
         THE BAR SHOWS. Pre-actions were one-way - the client pushed them and
         nothing ever read the armed state back - so a reconnect could leave
         the bar dark while the engine was armed, or lit while the engine had
         invalidated it. Every change to the engine's copy now goes to the
         player's own sockets as a private frame; the client reconciles its
         bar to it, and asks for it again on RESYNC (rePushPreAction).

         EXCEPT THE EXECUTION ITSELF (2026-09-08 sweep). executePreAction
         deletes the entry and emits PRE_ACTION_EXECUTED synchronously, at
         the top of handleTurnChange, BEFORE the visible beat, the snapshot
         and the turn_change. Pushing "nothing armed" here reached the hero
         ahead of the snapshot that put them on the clock, so the client's
         bar disarmed, its suppression of every "your turn" surface
         (heroPromptedToAct) had nothing to key on, and the bell, the ring,
         the clock and the panel all fired for a turn the engine was already
         taking - Dan's "it still prompts you" glitch, alive underneath two
         fixes that were correct on paper. The executed action lands ~250ms
         later and the client clears its own arm when it sees it
         (heroLastAction); a REJECTED pre-action is pushed explicitly from
         handleTurnChange's fallthrough, with a reason, so the bar clears and
         the player is prompted at once. RESYNC still re-sends the engine's
         copy, so a reconnect converges either way. */
      if (event.type === 'PRE_ACTION_EXECUTED') return;
      this.pushPreActionToPlayer(
        event.playerId,
        event.type === 'PRE_ACTION_INVALIDATED'
          ? { reason: 'invalidated' }
          : event.type === 'PRE_ACTION_CLEARED'
            ? { reason: 'cleared' }
            : undefined
      );
    });
    this.atomicStackService = new AtomicStackService((event) => {
      console.log(`[ServerTableEngine:${tableId}] Stack: ${event.type}`);
    });

    // Step 6: Initialize advanced modules
    /* ONTO THE HUB, NOT INTO A CONSOLE.LOG (final sweep 2026-09-08). Three
       engines here still reported their events to a console line and nowhere
       else, the same defect class InsuranceEngine (above) and TableBalancer
       (below) were repaired for on 2026-08-28. A straddle is real chips
       posted, a chip race is a chip transfer, a table break is a seat path:
       each now goes out on the table's hub in the snake_case the wire uses,
       so a client - and the shadow recorder - can see it. Unknown types are
       ignored by the client, so nothing changes on screen until a handler
       exists; what changes is that the fact is no longer lost. */
    const bridgeToHub = (label: string, event: { type: string }) => {
      console.log(`[ServerTableEngine:${tableId}] ${label}: ${event.type}`);
      try {
        this.hub?.emitEvent(this.tableId, {
          ...(event as unknown as Record<string, unknown>),
          type: event.type.toLowerCase(),
          table_id: this.tableId,
          timestamp: Date.now(),
        });
      } catch {
        /* broadcast failure is non-fatal */
      }
    };
    this.straddleEngine = new StraddleEngine((event) => bridgeToHub('Straddle', event));
    this.runItTwiceEngine = new RunItTwiceEngine((event) => {
      console.log(`[ServerTableEngine:${tableId}] RIT: ${event.type}`);
    });
    this.insuranceEngine = new InsuranceEngine((event) => {
      console.log(`[ServerTableEngine:${tableId}] Insurance: ${event.type}`);
      // POKERBROS PARITY 2026-08-26: accept/decline/settle used to die in this
      // console.log (same defect class as the rakeback events below). The
      // reference flow shows every seat a "waiting" bar while the leader
      // decides and a table-wide notice when they answer - none of which can
      // exist if the decision never leaves the process. INSURANCE_OFFERED is
      // NOT forwarded here: broadcastInsuranceOffers already emits the
      // context-rich 'insurance_offers' event for it.
      if (
        event.type === 'INSURANCE_ACCEPTED' ||
        event.type === 'INSURANCE_DECLINED' ||
        event.type === 'INSURANCE_SETTLED' ||
        // EV CASHOUT 2026-08-28: the third decision, table-wide like the others.
        event.type === 'INSURANCE_CASHED_OUT'
      ) {
        try {
          const playerId = String((event as Record<string, unknown>).playerId ?? '');
          const username =
            this.seatedPlayers.find((p) => p.user_id === playerId)?.username || 'Player';
          this.hub?.emitEvent(this.tableId, {
            ...(event as unknown as Record<string, unknown>),
            type: event.type.toLowerCase(), // insurance_accepted / _declined / _settled / _cashed_out
            username,
            table_id: this.tableId,
          });
        } catch {
          /* broadcast failure is non-fatal */
        }
        // OBSERVABILITY 2026-08-28: the decision funnel, durable. 'offered'
        // rows come from broadcastInsuranceOffers; these are the outcomes.
        // Fire-and-forget — the log must never touch gameplay.
        try {
          const ev = event as unknown as Record<string, unknown>;
          logInsuranceOfferEvent({
            tableId: this.tableId,
            clubId: this.tableInfo?.club_id ?? null,
            handNumber: this.handCount,
            playerId: String(ev.playerId ?? ''),
            event:
              event.type === 'INSURANCE_ACCEPTED'
                ? 'accepted'
                : event.type === 'INSURANCE_DECLINED'
                  ? ev.source === 'timeout'
                    ? 'timeout'
                    : 'declined'
                  : event.type === 'INSURANCE_CASHED_OUT'
                    ? 'cashed_out'
                    : 'settled',
            equityPercent: typeof ev.equity === 'number' ? ev.equity : null,
            premium: typeof ev.premium === 'number' ? ev.premium : null,
            insuredAmount:
              typeof ev.insuredAmount === 'number'
                ? ev.insuredAmount
                : typeof ev.cashoutAmount === 'number'
                  ? ev.cashoutAmount
                  : null,
            pot: null,
            street: null,
          });
        } catch {
          /* observability failure is non-fatal */
        }
      }
    });
    /**
     * WEIGHTED CONTRIBUTED RAKE (Dan 2026-08-29): RakebackEngine is DELETED,
     * not just disabled. It was the FIX 144 equal-share accumulator — inert
     * since RAKE-AUDIT 2026-07-24 (its in-memory totals were never flushed,
     * its tiers disagreed with the authoritative RakebackSettlerService), and
     * equal-share attribution itself is retired. Durable rakeback runs
     * exclusively through rake_records -> RakebackSettlerService, which now
     * allocates via services/rakeAllocation.ts (weighted contributed). The
     * TABLE_BALANCE_EXECUTED hub bridge below (Dan 2026-08-23) is untouched;
     * the client's `rakeback_distributed` listener stays as a no-op — this
     * engine never emitted it while disabled either.
     */

    // Step 7: Initialize tournament & extras modules
    this.chipRaceEngine = new ChipRaceEngine((event) => bridgeToHub('ChipRace', event));
    this.tableBalancer = new TableBalancer((event) => {
      console.log(`[ServerTableEngine:${tableId}] TableBalancer: ${event.type}`);
      if (event.type === 'TABLE_BALANCE_EXECUTED') {
        try {
          this.hub?.emitEvent(this.tableId, {
            ...(event as unknown as Record<string, unknown>),
            type: 'table_balance_executed',
            table_id: this.tableId,
          });
        } catch {
          /* broadcast failure is non-fatal */
        }
      }
    });
    this.tableBreakEngine = new TableBreakEngine((event) => bridgeToHub('TableBreak', event));
    this.engineTelemetry = new EngineTelemetry((event) => {
      console.log(
        `[ServerTableEngine:${tableId}] Telemetry: activeTables=${(event as any).activeTables}`
      );
    });

    console.log(`[ServerTableEngine] Created for table ${tableId}`);
  }

  /**
   * Phase 1.1 PR-2: Inject the authoritative state hub. Call this right after
   * construction (before start). Once set, every broadcastCurrentState() also
   * publishes to the hub so connected WebSocket clients receive the payload
   * directly, in addition to the legacy Supabase Realtime broadcast. The
   * Supabase path is removed in PR-5 once WS is verified in production.
   */
  public setHub(hub: TableStateHub): void {
    this.hub = hub;
  }

  /**
   * The button (dealer) seat of the most recently dealt hand. Used by the
   * TournamentEngine's table balancer to pick the correct player to move
   * (B6: the player who is big blind due next). Returns 0 before the first
   * hand is dealt, in which case the balancer falls back to its stack-based
   * heuristic.
   */
  public getCurrentButtonSeat(): number {
    return this.currentHandDealerSeat;
  }

  /** ADDITIVE (#1): map an engine blind-posting `type` string to a typed BlindKind. */
  protected shadowBlindKind(t: string): BlindKind {
    if (t === 'small_blind' || t === 'big_blind' || t === 'ante' || t === 'straddle') return t;
    if (t === 'sb') return 'small_blind';
    if (t === 'bb') return 'big_blind';
    return 'small_blind';
  }

  /**
   * Start the dealing pipeline
   */

  /**
   * HOW MANY SEATS BEFORE A HAND IS DEALT (Dan 2026-08-25).
   *
   * `auto_start_players` has been a slider on the creation screen since
   * February and was read by nothing: the dealing loop, the start-up wait and
   * the stall watchdog each hard-coded 2. A host could set AutoStart to 5, and
   * the table dealt three-handed anyway.
   *
   * It lives here, on the base, because THREE call sites have to agree about
   * it. They already had to agree about the old constant — the watchdog's own
   * comment says "mirror dealingLoop's predicate exactly, so the watchdog's
   * idea of 'this table should be dealing' cannot disagree with the loop's" —
   * and a table whose loop waits for 5 while the watchdog wants 2 is a table
   * the watchdog kills and rebuilds every ninety seconds.
   *
   * Clamped at 2 because the column carries no CHECK constraint and a hand of
   * one is not a hand. A tournament table ignores the setting entirely: its
   * field size is decided by the tournament, not by a cash-table slider.
   */
  /**
   * ── THE VARIANT THIS TABLE ACTUALLY DEALS (Dan 2026-08-25) ──────────────
   *
   * Pineapple is a fully built variant: three hole cards, its own discard
   * street, its own timer, `pineapple_discard` wired through BettingStructure
   * and HandController. The toggle on the creation screen was simply never
   * connected to it — `pineapple_holdem` is a boolean column with no reader,
   * sitting beside a `game_variant` the engine reads for everything.
   *
   * So this is mapping, not building. A Hold'em table with the switch on is
   * dealt as pineapple; every other variant is left exactly as it is, because
   * "Pineapple PLO" is not a game and a stray flag must not silently turn a
   * PLO table into one.
   */
  /**
   * VARIANT OVERRIDE 2026-08-28 (spec §10.1): the variant of the hand that is
   * LIVE right now — the HandController's own config when a hand is running
   * (which carries the bomb-pot override variant on override hands), the
   * table's dealt variant otherwise. This is the ONE seam every "what game is
   * this hand" consumer reads: bettingStructureFields (the snapshot the
   * client's bet slider obeys), the legal-action clamps in Turns, the horse
   * evaluator's variant, and the hand-history write. Reading
   * tableInfo.game_variant directly at any of those sites would deal a PLO
   * bomb hand and then price it like Hold'em.
   */
  protected activeHandVariant(): string {
    return this.handController?.getGameVariant?.() ?? this.dealtGameVariant();
  }

  protected dealtGameVariant(): string {
    const variant = String(this.tableInfo?.game_variant || 'nlh').toLowerCase();
    if (variant === 'pineapple') return 'pineapple';
    const wantsPineapple = (this.tableInfo as { pineapple_holdem?: boolean } | null)
      ?.pineapple_holdem;
    if (wantsPineapple === true && (variant === 'nlh' || variant === 'nlhe')) return 'pineapple';
    return variant;
  }

  protected minPlayersToDeal(): number {
    if (this.isTournamentTable()) return 2;
    const configured = Number(this.tableInfo?.auto_start_players);
    return Number.isFinite(configured) && configured > 2 ? Math.floor(configured) : 2;
  }

  /**
   * The deal threshold, for callers OUTSIDE the engine (2026-08-27).
   *
   * GameServer's zombie reaper decides "should this table be dealing?" and
   * until now answered with a hard-coded `player_count >= 2` — the same
   * disagreement the header above warns about, in the one caller that could
   * not see this method because it was protected. A table with
   * auto_start_players = 5 and 2-4 seats makes no progress BY DESIGN, and the
   * reaper called that a zombie and rebuilt its engine every 180 seconds,
   * forever. One definition of "enough players", visible to everyone who
   * needs it.
   */
  public dealThreshold(): number {
    return this.minPlayersToDeal();
  }

  /**
   * ── RIT CONFIG IS RE-READ, NOT REMEMBERED (2026-08-27) ──────────────────
   *
   * This block used to live inline in start(), which runs ONCE per engine
   * process. So `run_it_twice`, `allow_run_it_twice`, `run_it_twice_enabled`,
   * `insurance_enabled` and `run_it_mode` were sampled at boot and never
   * looked at again: an owner turning insurance on, or run-it-twice off,
   * changed nothing at all until the table's engine happened to restart.
   *
   * Production hand #3046089 is that defect: cash table d9d3c3b3 dealt three
   * boards and split a 1470 pot without one player at the table being shown a
   * prompt, off configuration the engine had been holding since it booted.
   *
   * ── WHAT THIS METHOD DOES *NOT* DO ANY MORE (merge note, 2026-08-27) ────
   *
   * The extraction was written when FIX 92 ended `ritEffective = ritEnabled &&
   * !insuranceEnabled` — "insurance takes priority, RIT is disabled". That
   * force-disable was RETIRED on 2026-08-26 by Dan's leader-seat ruling and
   * the body below is the retired-it version, not the extracted one: when both
   * features are on, the run-it-multi-times question comes FIRST and insurance
   * engages only if the hand resolves to a single run ("THE INSURANCE PART
   * PICKED UP ON THE TURN. AFTER THE RUN IT TWICE WAS DECLINED").
   *
   * Per-HAND exclusivity still holds absolutely — a hand that deals extra
   * boards never carries an insurance contract, and an insured hand always
   * runs exactly once — but it is enforced by the runout dispatch
   * (`ritFirst` in handleAllInRunout), not by switching the feature off here.
   * So do not restore the `&& !insuranceEnabled` term: hand #3046089 needed
   * the configuration RE-READ, which is what this method is for, and did not
   * need the table's RIT switch overridden.
   *
   * It is called from start() AND from ServerTableEngineRunout at the top of
   * handleAllInRunout — the last instant before an offer can be made, and the
   * only place in the hand where the answer matters. That is deliberately
   * tighter than "hand start": there is no window between the re-read and the
   * decision for the two to disagree, and no code path can reach the offer
   * without passing through it.
   *
   * THE CAVEAT THAT USED TO BE HERE IS GONE (2026-09-09, lane E). It read:
   * "`this.tableInfo` is itself a cached snapshot ... this method re-reads the
   * freshest values the PROCESS has; it does not re-read the DATABASE. Adding
   * a per-hand `loadTable` for these five columns is a separate decision ...
   * and is deliberately NOT taken here."
   *
   * That was the correct call while a table's rules were set once by a host.
   * It stopped being correct at Gate 5, when `fn_cash_apply_ruleset` began
   * rewriting the four run-it columns from the game's template on every
   * cluster tick - and it showed up as `NLH 0.50/1 Classic` offering Run It
   * Twice on four of its five tables and not on the fifth, with a must-move
   * carrying players between them mid-session.
   *
   * `refreshRakeConfig` now re-reads those columns (throttled, one row, at the
   * hand boundary) and calls this method afterwards, so the RIT engine is
   * compiled from the fresh row rather than the boot one. This method itself
   * is unchanged: it still reads `this.tableInfo`, which is now kept current.
   *
   * Returns `insuranceEnabled` so start() can keep configuring the insurance
   * engine from the same computation. The insurance engine is deliberately NOT
   * re-configured per hand: start() sets only `enabled` on it, while other call
   * sites set `houseMargin` and `offerTimeoutSeconds` too, so a partial
   * re-configure mid-flow would silently drop them. The runout dispatch reads
   * the RIT engine's own `isEnabled` for its sequencing, so the two cannot
   * drift apart.
   */
  protected applyRunItTwiceConfig(): { ritEffective: boolean; insuranceEnabled: boolean } {
    // No table row loaded yet: leave whatever configuration is already in
    // place rather than reconfiguring from nothing.
    if (!this.tableInfo) return { ritEffective: false, insuranceEnabled: false };

    // ═══════════════════════════════════════════════════════════════════════
    // FIX 92 (HISTORY): RIT and Insurance used to be mutually exclusive at
    // CONFIGURE time — "RUN IT TWICE AND INSURANCE ARE NOT ALLOWED ON THE
    // SAME TABLE", insurance taking priority and RIT being switched off. See
    // the SEQUENCING note below for what replaced it on 2026-08-26.
    // ═══════════════════════════════════════════════════════════════════════
    // RIT INTENT FIX 2026-08-18: the engine read `run_it_twice_enabled`,
    // a column NOTHING in the product ever writes (39 of 710 open tables
    // true, likely a one-off script). The creation surfaces write
    // `run_it_twice` (CreateTableModal) and `allow_run_it_twice`
    // (TableCreationPage) - each defaulting the OTHER to true - and the
    // lobby advertises the feature off `run_it_twice`. So the lobby said
    // "run it twice" on ~every table while the engine had it off on 94%
    // of them, and no offer ever fired in live traffic. Owner intent:
    // OFF means at least one user-written column is false; the legacy
    // engine column is honored as an additional ON override.
    // TOURNAMENT GATE 2026-08-18 — CONFIRMED CASH-ONLY BY DAN 2026-08-26:
    // "run it twice or 3 times is a cash game only area. it should never
    // be in MTT, SPINS OR HEADS UP." The gate was briefly lifted the same
    // day and reinstated within the hour on that ruling — RIT is a product
    // decision, cash tables only, not merely a numeric limitation.
    //
    // (The original numeric reason still stands as history: per-board
    // splits produce fractional amounts while tournament_players.chips is
    // INTEGER — the sync floors, destroying chips; live 3-run tournament
    // hand 41627f9a split 1760.88 into 586.96/1173.92 before the gate went
    // in. dealAndResolveRIT now carries an integer-exact tournament branch
    // as DEFENSE IN DEPTH: unreachable while this gate holds, but if the
    // gate ever regresses, that branch makes the 41627f9a chip destruction
    // impossible rather than merely unlikely.)
    const ritIsTournament =
      !!this.tableInfo.tournament_id || this.tableInfo.game_type === 'tournament';
    /**
     * HEADS-UP TABLE GATE (2026-09-13). The ruling quoted above names three
     * places run-it-twice never goes - MTT, Spins, HEADS UP - and for eighteen
     * days the code enforced two of them. Every heads-up TABLE on the platform
     * happens to be a tournament (the 2-seat heads-up SNG shapes in
     * TournamentRecurringService), so the tournament gate covered it by
     * accident; the first 2-seat cash table would have offered the question.
     *
     * A heads-up table is a table FORMAT: two seats. It is not a two-way
     * all-in on a full ring - that is the ordinary run-it-twice hand, and the
     * reference recordings that shaped this feature are exactly that.
     */
    const ritIsHeadsUpTable =
      Number(this.tableInfo.max_players) > 0 &&
      Number(this.tableInfo.max_players) <= HEADS_UP_SEATS;
    const ritEnabled =
      !ritIsTournament &&
      !ritIsHeadsUpTable &&
      (((this.tableInfo.run_it_twice ?? true) && (this.tableInfo.allow_run_it_twice ?? true)) ||
        (this.tableInfo.run_it_twice_enabled ?? false));
    // ALL-CASH INSURANCE 2026-08-26 (Dan): insurance is a CASH feature.
    // The ledger step was already cash-only (ServerTableEngineSettlement
    // gates on !isTournamentTable), but the engine itself never refused a
    // stray insurance_enabled flag on a tournament row - which would have
    // moved seat chips with NO bank ledger behind them. Same gate as RIT.
    const insuranceEnabled = (this.tableInfo.insurance_enabled ?? false) && !ritIsTournament;
    // SEQUENCING 2026-08-26 (Dan's leader-seat recording): FIX 92 used to
    // force-disable RIT here whenever insurance was on ("insurance takes
    // priority"). The reference table runs BOTH: the run-it-multi-times
    // question comes FIRST, and insurance engages only when the hand
    // resolves to a single run ("THE INSURANCE PART PICKED UP ON THE TURN.
    // AFTER THE RUN IT TWICE WAS DECLINED"). Per-HAND exclusivity still
    // holds - a hand that deals extra boards never carries an insurance
    // contract, and an insured hand always runs exactly once - it is now
    // enforced by the runout dispatch (handleAllInRunout), not by turning
    // the feature off.
    const ritEffective = ritEnabled;

    // Bible V8 §4.20 + FIX 98: Configure Run It Twice engine
    /**
     * Dan 2026-08-25: run_it_mode reaches the engine at last. Read
     * DEFENSIVELY and additively — see RITConfig.mode. The column is the
     * string 'none' on all 46 live tables while run-it-twice is genuinely on
     * via the three boolean columns, so a mode that gated `enabled` would
     * have switched the feature off across the whole platform. It can only
     * ever REMOVE the question, never the feature.
     */
    const ritMode = String(this.tableInfo.run_it_mode || '').toLowerCase();
    this.runItTwiceEngine.configure(this.tableId, {
      enabled: ritEffective,
      mode:
        ritMode === 'mandatory_three'
          ? 'mandatory_three'
          : ritMode === 'mandatory_twice'
            ? 'mandatory_twice'
            : ritMode === 'player_choice'
              ? 'player_choice'
              : 'none',
      // POKERBROS PARITY 2026-08-26 (Dan's reference recordings): one shared
      // 25-second countdown covers the chooser AND every responder — the
      // reference panel shows "Countdown: 25s" ticking for the whole
      // decision, not 5s + 10s phases. The engine's DeadlineScheduler
      // auto-declines at this same deadline, and the wire events now carry
      // it (deadline_ts) so every client renders the same clock.
      autoDeclineTimeout: 25,
      maxRuns: 3, // Support up to 3 boards (Dan's rules: player can choose 1/2/3)
      chooserTimeout: 25,
      responderTimeout: 25,
    });

    return { ritEffective, insuranceEnabled };
  }

  async start(): Promise<void> {
    /* A REFUSAL TO START SETTLES `ready` (final sweep, 2026-09-08). These three
       throws sit BEFORE the try whose catch settles `ready` false, so an engine
       refused here left `ready` pending for ever - and GameServer's readiness
       tracker, `GET /state`, `GET /actions`, the tournament manager and the
       cluster controller's wake job all await that promise with no deadline.
       The refusal is still a throw for the caller; it is just no longer a
       promise nobody can collect. `stop()` and `killForRestart()` settle it
       too, so a second settle is a no-op. */
    if (this.terminal || this.teardownPromise) {
      this.settleReady(false);
      throw new Error(`Table engine ${this.tableId} is terminal and cannot be restarted`);
    }
    if (this.running) return;
    if (!this.engineLeaseAuthorityIsCurrent()) {
      this.expireEngineLeaseAuthority();
      this.settleReady(false);
      throw new Error(`Table engine ${this.tableId} has no current distributed lease proof`);
    }
    if (!this.claimProcessOwnership()) {
      this.settleReady(false);
      throw new Error(`Table engine ${this.tableId} already has another process-local generation`);
    }
    this.running = true;
    this.armEngineLeaseExpiryTimer();
    console.log(`[ServerTableEngine:${this.tableId}] Starting...`);

    try {
      this.setLoopPhase('start_load_table');
      /**
       * ── The 5-second respawn loop (2026-08-22) ──
       *
       * This is the FIRST statement of start(), it is a database read, and a
       * throw from it used to land in the catch below as `start_failed` ->
       * killForRestart -> GameServer rebuilds the engine within 5s -> the same
       * read -> the same throw. A transient blip became a permanent respawn
       * loop, and each turn of it costs MORE database work than a retry would:
       * a rebuilt engine re-runs seedHandCountFromHistory, checkCrashRecovery
       * and resolveOrphanedAddOns as well.
       *
       * dealingLoop has always treated exactly these errors as transient and
       * backed off. start() treated them as fatal. Same database, same error,
       * opposite response — and the fatal one was the expensive one.
       *
       * Retried HERE rather than in the catch on purpose: nothing has been
       * configured and no timer has been armed yet, so a retry is a clean
       * re-attempt. `refreshBlinds` already retries this very call three
       * times for this very reason; this is the same treatment at the one
       * place every table passes through on every start.
       */
      let tableData: unknown;
      for (let attempt = 1; ; attempt++) {
        try {
          tableData = await loadTable(this.tableId);
          break;
        } catch (err) {
          if (
            !ServerTableEngineBase.isTransientDbError(err) ||
            attempt >= ServerTableEngineBase.START_LOAD_ATTEMPTS
          ) {
            throw err;
          }
          if (!this.running) return;
          const backoff = Math.min(500 * 2 ** (attempt - 1), 8_000);
          console.warn(
            `[ServerTableEngine:${this.tableId}] loadTable blipped on start (attempt ${attempt}/${ServerTableEngineBase.START_LOAD_ATTEMPTS}) - retrying in ${backoff}ms`
          );
          await this.sleep(backoff);
        }
      }
      if (!this.lifecycleCanMutate()) return;
      this.tableInfo = tableData as TableInfo;

      // V22 (2026-08-27, Phase 2): pre-warm the tournament ICM context the
      // moment the engine knows which tournament it serves. The cache used to
      // warm on the FIRST HORSE DECISION — with 7,000+ spins a day, the
      // opening hands of every event lacked real context while the fetch was
      // still in flight. The call is synchronous-cheap: it only kicks the
      // background refresh; Phase 6 labels any remaining warm-up explicitly.
      if (this.tableInfo?.tournament_id) {
        try {
          refreshTournamentBrainContext(String(this.tableInfo.tournament_id));
        } catch {
          /* warming is best-effort */
        }
      }

      // FIX 123: Bible V8 §6.2 + Dan's directive — Time bank auto-extend ONLY if:
      //   1. Table has time_bank_enabled = true
      //   2. Player has time banks available (checked in TimeBankEngine.activate())
      // If disabled or depleted → player gets folded on timeout, then client shows buy-more popup.
      const timeBankEnabled = this.tableInfo.time_bank_enabled ?? true;
      // Bible V8 §6.2: each time bank adds exactly 20 seconds. The standard
      // decision clock is 15s (action_time_seconds) — these are two different
      // numbers and conflating them is what produced FIX 200, which set the
      // grant to 15 "was incorrectly 20". 20 is correct: 15 to decide, +20 if
      // you spend a bank. Owner ruling, 2026-08-18; §6.2 updated to match.
      // TimeBankEngine DEFAULT_CONFIG has secondsPerUse: 20 — keep in step.
      this.timeBankEngine.configure(this.tableId, {
        totalBankSeconds: (this.tableInfo.time_bank_max_uses ?? 120) * 20, // uses × 20s each
        maxUses: this.tableInfo.time_bank_max_uses ?? 120,
        secondsPerUse: 20, // Bible V8 §6.2: each time bank adds exactly 20 seconds
        autoActivate: timeBankEnabled, // FIX 123: Respect table setting — false means no auto-extend
      });

      // Bible V8 §6.3: Configure disconnect engine with table-specific settings
      this.disconnectEngine.configure(this.tableId, {
        disconnectTimeoutSeconds: this.tableInfo.disconnect_timeout_seconds ?? 30,
        maxConsecutiveTimeouts: this.tableInfo.max_consecutive_timeouts ?? 3,
        preferCheckOverFold: this.tableInfo.prefer_check_over_fold ?? true,
        reconnectGraceSeconds: 5,
      });

      // Run It Twice — see applyRunItTwiceConfig(). Extracted 2026-08-27 so it
      // can be re-evaluated per hand instead of once per process lifetime.
      const { insuranceEnabled } = this.applyRunItTwiceConfig();

      // Bible V8 §4.19: Configure Insurance engine
      this.insuranceEngine.configure(this.tableId, {
        enabled: insuranceEnabled,
      });

      // Bible V8 §4.4 / FIX 114: Configure Straddle engine — UTG only
      if (this.tableInfo.straddle_enabled) {
        this.straddleEngine.configure(this.tableId, {
          enabled: true,
          maxStraddles: 1, // FIX 114: UTG straddle only — always 1
          straddleMultiplier: 2, // Standard 2x BB
          // A6/A7: mandatory UTG straddle when the host chose "Auto UTG Straddle"
          mandatoryUtg: (this.tableInfo as any).auto_utg_straddle === true,
        });
      }

      // RakebackEngine (FIX 144 equal-share, inert since RAKE-AUDIT
      // 2026-07-24) was DELETED on 2026-08-29 under the weighted contributed
      // rake law. Rakeback runs exclusively through rake_records ->
      // RakebackSettlerService, allocated by services/rakeAllocation.ts.

      // ── Dan 2026-08-16 — SEED handCount FROM PERSISTED HISTORY ──
      //
      // handCount is declared `= 0` and was previously only ever restored by
      // checkCrashRecovery(), which requires an incomplete-hand snapshot. On
      // any clean restart (deploy, reboot, table reactivation) there is no
      // snapshot, so the counter silently restarted at 1 and a long-lived
      // table accumulated several distinct hands all numbered #1, #2, #3 ...
      //
      // Money was never affected: settlement keys off rake_records.hand_id and
      // Replay keys off hand_history.id, both unique. But
      // (table_id, hand_number) was NOT unique, so every hand-number lookup,
      // support query, and "hand #N" reference on a restarted table was
      // ambiguous.
      //
      // Seeding from MAX(hand_number) makes the sequence monotonic across
      // restarts. Deliberately runs BEFORE checkCrashRecovery() so a crash
      // snapshot still wins — recovery resumes an in-flight hand and must be
      // able to reuse that hand's exact number.
      await this.seedHandCountFromHistory();
      if (!this.lifecycleCanMutate()) return;

      // Dan 2026-08-25, BINDING: "IN THE EVENT OF AN ENGINE RESTART, WHILE PLAY
      // IS RUNNING, IT MUST ALWAYS RESTART IN THE SAME POSITION."
      await this.restoreButtonFromHistory();
      if (!this.lifecycleCanMutate()) return;

      // FIX 137: Bible V8 §7.17 — Check for interrupted hand from a server crash
      const recovered = await this.checkCrashRecovery();
      if (!this.lifecycleCanMutate()) return;
      if (recovered) {
        console.log(
          `[ServerTableEngine:${this.tableId}] Crash recovery complete - resuming from hand #${this.handCount}`
        );
      }

      /* ═══ PRESENCE SURVIVES THE SCHEDULED RESTART (2026-09-04, audit item 2) ═══
         checkCrashRecovery restores the presence FSM only from an INCOMPLETE
         hand snapshot, and the :55 park guarantees there is none: every table
         finishes its hand before the cut-over. So on the one restart that
         happens every hour, every seat booted CONNECTED with its strikes,
         away-blind budget, sit-out reason and /away stamp wiped. The park
         writes the FSM to engine_presence_parked (see the dealing loop) and
         this reads it back, once, while it is fresh. restoreFsmStates never
         clobbers a seat that has already re-registered, so a player who is
         genuinely back loses nothing to a stale row. */
      if (!recovered) {
        try {
          const parked = await loadPresenceFromPark(this.tableId);
          if (!this.lifecycleCanMutate()) return;
          if (parked && Object.keys(parked).length > 0) {
            const restored = this.disconnectEngine.restoreFsmStates(this.tableId, parked);
            console.log(
              `[ServerTableEngine:${this.tableId}] presence restored from the park: ${restored}/${Object.keys(parked).length} seats`
            );
          }
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.presence_restore');
        }
      }

      // Bible V8 §3.1: Table FSM — empty → waiting (engine started, waiting for players)
      this.tableFSM.transition('waiting');
      // READY IS NOT DEALING: the row is loaded, every sub-engine is configured
      // and the waiting snapshot can be published. On-demand callers may
      // return now; the wait for players below is this engine's business.
      this.settleReady(true);

      // 2026-08-29: open the manual-bomb listener once the table row is loaded
      // (bomb_pot_enabled is known by now) and before any hand is dealt, so a
      // host clicking during the wait-for-players phase is not missed. Only
      // bomb-enabled tables pay for a subscription; the throttled refresh
      // opens it later if the owner enables bomb pots mid-session.
      if (this.tableInfo?.bomb_pot_enabled === true) this.subscribeManualBomb();

      // Wait for the host's AutoStart figure (2 unless they raised it)
      this.setLoopPhase('start_wait_for_players');
      // The first sweep is the boot read, not a change: nothing was known
      // before it, and a game with anyone seated is on every pass already.
      let firstWaitSweep = true;
      while (this.running) {
        /**
         * THE QUIET TABLE PARKS TOO (Dan 2026-09-01).
         *
         * This loop is where a table below minPlayersToDeal waits, possibly
         * for hours, and it never reaches the dealing loop — so before this
         * gate it was the one place on the platform that ignored a pause
         * entirely. Two things followed from that, both bad:
         *
         *   1. `evictExpiredSitOuts` below kept running every five seconds
         *      THROUGH the maintenance break, standing players up and cashing
         *      them out during a break they had just been told their seat was
         *      safe in.
         *
         *   2. The table never reached the pause gate, so it never counted as
         *      parked — and the restart gate, which requires EVERY table to be
         *      parked, could never open on any fleet with a quiet table on it.
         *      The deploy would have waited 14 minutes and given up, every
         *      hour, forever.
         *
         * At the top of the iteration on purpose, matching the dealing loop:
         * every branch below exits with `continue` or `break`, so a gate
         * placed lower would be unreachable for exactly the tables that need
         * it most.
         */
        if (
          this.maintenancePaused ||
          this.finalTableDealPaused ||
          this.terminalCloseoutPaused ||
          this.tournamentMovePauseOwners.size > 0 ||
          (this.handForHandPaused && this.holdBeforeNextHand)
        ) {
          this.setLoopPhase('parked_for_pause');
          await this.awaitPauseGate();
          if (!this.running) break;
          this.setLoopPhase('start_wait_for_players');
        }
        const idsBeforeSweep = new Set(this.seatedPlayers.map((p) => p.user_id));
        try {
          this.seatedPlayers = await loadSeatedPlayers(this.tableId);
          if (!this.lifecycleCanMutate()) return;
        } catch (err) {
          // This is a POLL. It already runs every 5s, so a failed sweep costs
          // one sweep — while letting it escape aborted start() entirely and
          // killed the engine, which is how a table with players waiting on it
          // ended up in a respawn loop. broadcastCurrentState below has been
          // guarded like this since it was added; the read above never was.
          reportError(err, 'ServerTableEngine.' + this.tableId + '.start_seat_sweep_failed');
          await this.sleep(5000);
          continue;
        }
        // A SEAT CHANGED WHILE WAITING (2026-09-09, must-move audit). The
        // dealing loop's roster diff wakes the game's ClusterController; this
        // loop, where a one-player Main 1 or a fresh feeder spends its life,
        // did not - so the second chair that takes a feeder live, or the seat
        // that opens on a waiting Main 1, reached the controller at the next
        // pass instead of inside a second. Same wake, same debounce.
        if (
          !firstWaitSweep &&
          (this.seatedPlayers.length !== idsBeforeSweep.size ||
            this.seatedPlayers.some((p) => !idsBeforeSweep.has(p.user_id)))
        ) {
          this.wakeClusterGame('seat_change');
        }
        firstWaitSweep = false;
        /* A cash table below its deal minimum never reaches dealingLoop(). A
           bust rebuy can still be committed from the player's cashier while
           the table waits here, so this boundary must run the same exact,
           envelope-aware pending-row consumer before it decides there are too
           few funded seats. The sweep flag starts true once per engine and is
           raised again by every in-process add-on / observed bust rebuy. */
        if (!this.isTournamentTable()) {
          await this.processPendingAddOns(this.seatedPlayers);
          if (!this.lifecycleCanMutate()) return;
        }
        // BEFORE the sit-out restore, always: registering a player first would
        // block the adoption (restoreFsmStates never clobbers a live entry).
        this.adoptMovedPresence();
        this.restoreSitOutsFromSeats();
        // Dan 2026-08-30: and the cash entry holds, for the same reason the
        // sit-out restore is here rather than only in the dealing loop — a
        // table below the minimum to deal never reaches that loop, so a player
        // held for the big blind on a table that went quiet would have their
        // hold restored only if and when the table filled again. Guarded to
        // once per process, so the two call sites cannot double-restore.
        this.restoreEntryHoldsFromSeats();
        // THE CASE DAN REPORTED. This loop is where a table below the minimum
        // to deal waits — possibly forever — and the sit-out rule used to live
        // only in the dealing loop, which is never reached from here. So the
        // last player at a table could sit out and hold the seat indefinitely,
        // with the five-minute clock never once being asked the time.
        // countOrbit false: nothing is being dealt, so no orbit has passed.
        await this.evictExpiredSitOuts({ countOrbit: false }).catch((err) =>
          reportError(err, 'ServerTableEngine.' + this.tableId + '.wait_loop_sitout_evict')
        );
        if (!this.lifecycleCanMutate()) return;
        // MUST-MOVE (2026-09-05). The same shape, the same reason: a lone
        // player on a feeder waits HERE, and the move the controller planned
        // for them was executed only from the dealing loop, which this table
        // never reaches. Production 00:28-00:45 UTC: seventeen must-move rows
        // for one horse, one a minute, every one expired, while Main 1 sat one
        // short beside it. A table below the minimum is at a hand boundary
        // all the time; every pending move lands now.
        await this.executeIdleSeatMoves().catch((err) =>
          reportError(err, 'ServerTableEngine.' + this.tableId + '.wait_loop_seat_moves')
        );
        if (!this.lifecycleCanMutate()) return;
        await this.stopIfClusterTableClosed().catch((err) =>
          reportError(err, 'ServerTableEngine.' + this.tableId + '.wait_loop_cluster_closed')
        );
        if (!this.lifecycleCanMutate()) return;
        // IDLE BROADCAST (2026-08-22): publish the waiting-state snapshot so
        // a client joining an idle table gets a real SNAPSHOT (seats, stacks,
        // 'waiting' stage) instead of an eternal spinner. The hub drops
        // empty-patch publishes, so repeating this every sweep costs nothing
        // when nothing changed.
        try {
          await this.broadcastCurrentState();
        } catch {
          /* idle publish must never stall the wait loop */
        }
        if (!this.lifecycleCanMutate()) return;
        if (this.seatedPlayers.length >= this.minPlayersToDeal()) break;
        // A completed waiting sweep proves this loop is alive even when one
        // player cannot start a hand. Discovery also watches tournament-owned
        // tables, so an unchanged clock rebuilt healthy lone-seat tables every
        // 180 seconds. Stamp only after the fresh read and awaited wait work:
        // a rejected read or hung sweep must still age into recovery.
        this.markProgress();
        console.log(
          `[ServerTableEngine:${this.tableId}] Waiting for players... (${this.seatedPlayers.length}/${this.minPlayersToDeal()})`
        );
        await this.sleep(5000);
      }

      if (!this.lifecycleCanMutate()) return;

      // Bible V8 §3.1: Table FSM — waiting → seating → running (players seated, ready to deal)
      this.tableFSM.transition('seating');
      this.tableFSM.transition('running');

      // FIX 147 + Phase 1.2 PR-G-real: heartbeat check via DeadlineScheduler.
      // Recurring schedule pattern — the callback re-arms itself so a single
      // process-global tick loop drives every table's heartbeat check.
      // FIX: Horses are server-side bots — send simulated heartbeats so they don't time out.
      this.heartbeatActive = true;
      this.scheduleHeartbeatCheck();

      // A2 FIX (2026-08-08): sweep up any add-on that was durably debited but
      // never delivered — e.g. this engine (or its predecessor) died between
      // the wallet debit and the end of the hand. The ledger rows outlive the
      // process, so recovery is just "resolve whatever is still open". Doing it
      // here as well as in postHandTasks matters for a table that goes idle:
      // otherwise an orphaned row would wait for a next hand that never comes.
      await this.resolveOrphanedAddOns();
      if (!this.lifecycleCanMutate()) return;

      // Start dealing loop.
      //
      // 2026-08-15 ROOT-CAUSE FIX. This promise used to be discarded. The loop
      // is async and its own catch block contains awaits and a JSON.stringify
      // over a possibly-circular error, so a throw from INSIDE the catch
      // escapes the `while (this.running)` loop entirely. index.ts swallows the
      // unhandled rejection ("don't crash — keep running"), `running` stays
      // true, isRunning() keeps lying, GameServer never reaps the engine and
      // discovery never replaces it. Result: a table that is permanently dead
      // with funded seats. Attaching a catch that marks the engine dead turns
      // that permanent freeze into a <5s automatic rebuild.
      const dealingLoop = this.dealingLoop().catch((err) => {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.dealingLoop_died');
        this.killForRestart('dealing_loop_threw');
        throw err;
      });
      this.dealingLoopPromise = dealingLoop;
      // Observe immediately so a loop failure can never become an unhandled
      // rejection while its owner is arranging the terminal teardown.  The
      // rejected promise itself remains retained for performStop() to include
      // in the ownership-failure certificate.
      void dealingLoop.catch(() => undefined);
    } catch (err) {
      this.settleReady(false);
      reportError(err, `ServerTableEngine.${this.tableId}.failed_to_start`);
      // 2026-08-22: was a bare `running = false`, which could leak an armed
      // heartbeat scheduler entry (scheduleHeartbeatCheck runs before the
      // awaits later in start()) and left partial state for the reaper to
      // delete uncleaned. killForRestart is the one true teardown-for-rebuild.
      // Name the stage, exactly as the dealing-loop kills now do. A kill
      // reason that is the same string for every possible cause is how 1,603
      // dealing_loop_dead rows produced no diagnosis at all.
      this.killForRestart('start_failed:' + this.loopPhase, false);
      // The owner installed this generation in its map before awaiting start.
      // Resolving here made every GameServer cleanup handler unreachable: the
      // dead generation stayed addressable until a later discovery scan found
      // running=false, and an on-demand reconnect could therefore be admitted
      // to an engine that had already failed. Reject the same causal attempt so
      // its owner tears down, releases the map/lease, and may retry immediately.
      throw err;
    }
  }

  /**
   * Stop the engine
   */
  stop(): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;

    // Capture the exact writers BEFORE changing `running`. The dealing loop
    // reacts to that fence and may return in the same microtask turn; neither
    // it nor its current settlement may disappear from the ownership proof.
    const dealingLoopAtFence = this.dealingLoopPromise;
    const settlementsAtFence = [...(this.settlementInFlight ?? new Set<Promise<void>>())];
    if (this.postHandTasksPromise) settlementsAtFence.push(this.postHandTasksPromise);
    settlementsAtFence.push(...this.tournamentMoveOperations);

    // Publish the terminal fence synchronously. Any start/restart attempt in
    // the same turn observes it before teardown reaches its first await.
    this.terminal = true;
    this.running = false;
    this.clearEngineLeaseExpiryTimer();
    this.clearUnclaimedTournamentMovePauses();
    this.releasePendingPauseWait();
    this.notifyBoundaryPauseWaiters();
    // A stop before `waiting` is a "never got there"; after it, a no-op.
    this.settleReady(false);

    const teardown = this.performStop(dealingLoopAtFence, settlementsAtFence);
    this.teardownPromise = teardown;
    return teardown;
  }

  private async performStop(
    dealingLoopAtFence: Promise<void> | null = this.dealingLoopPromise,
    settlementsAtFence: readonly Promise<void>[] = [
      ...(this.settlementInFlight ?? new Set<Promise<void>>()),
      ...(this.postHandTasksPromise ? [this.postHandTasksPromise] : []),
      ...this.tournamentMoveOperations,
    ]
  ): Promise<void> {
    const failures: unknown[] = [];

    // FIX 147 + Phase 1.2 PR-G-real: set the flag first so any heartbeat
    // callback already mid-flight bails before re-arming.
    this.heartbeatActive = false;

    // Bible V8 §3.1: Table FSM — running/waiting → closing → closed
    this.tableFSM.transition('closing');

    // OWNERSHIP BARRIER: `running = false` prevents new work, but it does not
    // cancel a hand or a transaction that was already accepted. Join the exact
    // dealing-loop generation captured at the fence, then drain settlement to
    // a fixed point. A hand that was in the air at the fence can install its
    // settlement while the loop unwinds, which is why a one-time field read is
    // insufficient. No timeout is allowed here: elapsed wall time cannot make
    // it safe for a replacement engine to acquire this table while the prior
    // owner is still writing money/history.
    const joined = new Set<Promise<void>>();
    const joinOwnedWriter = async (writer: Promise<void> | null): Promise<void> => {
      if (!writer || joined.has(writer)) return;
      joined.add(writer);
      const result = await Promise.allSettled([writer]);
      if (result[0].status === 'rejected') failures.push(result[0].reason);
    };

    if (dealingLoopAtFence) await joinOwnedWriter(dealingLoopAtFence);
    for (const settlementAtFence of settlementsAtFence) {
      await joinOwnedWriter(settlementAtFence);
    }
    while (
      (this.settlementInFlight?.size ?? 0) > 0 ||
      this.postHandTasksPromise ||
      this.tournamentMoveOperations.size > 0
    ) {
      const settlements = [...(this.settlementInFlight ?? new Set<Promise<void>>())];
      const postHandTasks = this.postHandTasksPromise;
      const tournamentMoves = [...this.tournamentMoveOperations];
      for (const settlement of settlements) await joinOwnedWriter(settlement);
      await joinOwnedWriter(postHandTasks);
      for (const tournamentMove of tournamentMoves) await joinOwnedWriter(tournamentMove);
      if (this.postHandTasksPromise === postHandTasks) this.postHandTasksPromise = null;
    }
    if (this.dealingLoopPromise === dealingLoopAtFence) this.dealingLoopPromise = null;
    // A cashout accepted before the terminal fence remains an owned writer.
    // Do not release this engine's resources until its transaction returns.
    await this.seatBoundaryTail;

    // CROSS-INSTANCE GUARD (2026-08-22): if a replacement engine for this
    // tableId has already been constructed, every shared resource (scheduler
    // entries, precise timers, module deadline keys, the snapshot row) now
    // belongs to IT. A superseded instance cancelling "its" entries would
    // actually cancel the live engine's heartbeat + turn clocks — the exact
    // bug that made tables permanently lose their watchdog. Superseded
    // instances drop in-memory state only.
    this.clearHandSafetyTimer();
    this.clearLooseHandTimers();
    // 2026-08-29: drop the manual-bomb listener with the engine that opened
    // it. Local state only, so this is safe on a superseded instance too — a
    // channel belongs to one instance and closing ours cannot disturb the
    // successor's, which is the trap the guard below exists for.
    this.unsubscribeManualBomb();
    if (
      !this.claimedProcessOwnership ||
      ServerTableEngineBase.isCurrentEngineFor(this.tableId, this)
    ) {
      this.clearTurnTimer();
      // C15: flush any coalesced snapshot BEFORE dropping the controller — after
      // handController is null saveSnapshot() early-returns, so a pending write
      // would be silently lost on every shutdown.
      try {
        await this.flushSnapshot(true);
      } catch (error) {
        // stop() is shared by cash tables and tournament tables that do not
        // necessarily have a durable terminal receipt. Keep the failure in the
        // teardown certificate while still completing physical cleanup below;
        // committed-terminal callers may retire this exact generation only
        // after hasReleasedProcessOwnership() proves that cleanup completed.
        failures.push(error);
        reportError(error, 'ServerTableEngine.terminal_snapshot_flush_failed', {
          tableId: this.tableId,
        });
      }
    }
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.handController = null;

    // TOCTOU FIX (2026-08-22 review): ownership MUST be re-read AFTER the
    // flushSnapshot await. That Supabase write can take up to 15s on a
    // degraded DB - exactly when engines get reaped - and the owner now
    // rebuilds a replacement directly from the terminal-generation signal. A
    // pre-await ownership snapshot would
    // resume `true` here and cancel the NEW engine's heartbeat/turn deadlines
    // on the shared scheduler, silently recreating the permanent-freeze bug
    // this guard exists to prevent.
    if (
      !this.claimedProcessOwnership ||
      ServerTableEngineBase.isCurrentEngineFor(this.tableId, this)
    ) {
      // FIX 147 + Phase 1.2 PR-G-real: tear down heartbeat scheduler entry.
      deadlineScheduler.cancel(this.tableId, ServerTableEngineBase.HEARTBEAT_EVENT_ID);

      // Step 4: Dispose ported core modules
      for (const dispose of [
        () => this.preciseTimer.dispose(),
        () => this.actionValidator.dispose(),
        () => this.stateVerifier.dispose(),

        // Step 5: Dispose supporting modules
        () => this.timeBankEngine.disposeAll(),
        () => this.disconnectEngine.disposeAll(),
        () => this.preActionEngine.disposeAll(),
        () => this.atomicStackService.dispose(),

        // Step 6: Dispose advanced modules
        () => this.straddleEngine.disposeAll(),
        () => this.runItTwiceEngine.disposeAll(),
        () => this.insuranceEngine.disposeAll(),

        // Step 7: Dispose tournament & extras modules
        () => this.engineTelemetry.dispose(),
      ]) {
        try {
          dispose();
        } catch (error) {
          failures.push(error);
        }
      }

      ServerTableEngineBase.releaseCurrentEngine(this.tableId, this);
    }
    // Note: chipRaceEngine, tableBalancer, tableBreakEngine are stateless per-call — no dispose needed

    // Phase 1.1 PR-5: no Supabase channel to clean up — engine WS is now the
    // only game-state transport. TableStateHub.dropTable is called by the
    // discovery / tournament-break paths elsewhere.
    // Bible V8 §3.1: Table FSM — closing → closed (cleanup complete)
    this.tableFSM.transition('closed');

    console.log(
      `[ServerTableEngine:${this.tableId}] Stopped. Dealt ${this.handsDealtThisSession} hands.`
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Table engine ${this.tableId} teardown failed in ${failures.length} operation(s)`
      );
    }
  }

  /**
   * FIX 147 + Phase 1.2 PR-G-real: heartbeat check loop, scheduled through
   * DeadlineScheduler instead of setInterval. The callback re-arms itself
   * for the next tick so a single process-global tick loop drives every
   * table's heartbeat. heartbeatActive guards against races: stop() flips
   * it to false and cancels the pending entry; any callback that fires
   * between flag flip and cancel sees `running === false || heartbeatActive === false`
   * and bails without re-arming.
   *
   * IMPORTANT: horses are server-side bots without real WS clients sending
   * heartbeats, so the loop synthesises one for every seated horse before
   * sweeping for stale heartbeats. Removing this would cause every horse
   * at the table to time out every 10s and fold their hand. (Dan flagged
   * this explicitly during the PR-G-real refactor.)
   */
  /**
   * CHIP CONTINUITY: open the door for every held leave whose clock has run
   * out. Runs after each presence sweep (10 s). The database is asked through
   * the same guarded call as any other voluntary leave, so a mirror that is
   * ahead of the truth is simply refused again and the mirror re-adopts the
   * database's remaining time.
   */
  protected async releaseLeavesHeldByClock(): Promise<void> {
    if (this.leaveHeldByClock.size === 0 || this.isTournamentTable()) return;
    if (isMaintenanceFrozen()) return;
    const releaseSeatBoundary = await this.acquireSeatBoundary();
    try {
      while (this.postHandTasksPromise) {
        const pending = this.postHandTasksPromise;
        await pending;
        if (this.postHandTasksPromise === pending) break;
      }
      for (const [userId, occupancyId] of [...this.leaveHeldByClock]) {
        const seated = this.seatedPlayers.find((p) => p.user_id === userId);
        if (!seated || seated.occupancy_id !== occupancyId) {
          // Gone by another path (eviction, kick): nothing to release.
          this.leaveHeldByClock.delete(userId);
          continue;
        }
        if (this.chipContinuity.leaveLock(userId, seated.stack).locked) continue;
        if (this.handController) {
          const live = this.handController.getState().players.find((p) => p.user_id === userId);
          if (live) continue; // dealt in after all: wait for the boundary
        }
        const res = await atomicCashoutVoluntary(
          userId,
          this.tableId,
          seated.seat_number,
          seated.occupancy_id
        );
        if (this.seatedPlayers.some((p) => p.user_id === userId && p.occupancy_id !== occupancyId))
          continue;
        if (res.ok) {
          this.seatedPlayers = this.seatedPlayers.filter(
            (p) => p.user_id !== userId || p.occupancy_id !== occupancyId
          );
          this.leaveHeldByClock.delete(userId);
          this.disconnectEngine.unregisterPlayer(this.tableId, userId);
          this.timeBankEngine.removePlayer(this.tableId, userId);
          this.straddleEngine.removePlayer(this.tableId, userId);
          this.preActionEngine.removePlayer(this.tableId, userId);
          this.chipContinuity.forget(userId);
          this.hub?.emitEvent(this.tableId, {
            type: 'seat_left',
            table_id: this.tableId,
            seat: seated.seat_number,
            user_id: userId,
            mid_hand: false,
            timestamp: Date.now(),
          });
          console.log(
            `[ServerTableEngine:${this.tableId}] held leave released for ${userId} - stay clock reached zero`
          );
          void this.broadcastCurrentState();
        } else if (res.code === 'LEAVE_LOCKED') {
          this.chipContinuity.noteRefusal(userId, res.stayRemainingMs);
        }
      }
    } finally {
      releaseSeatBoundary();
    }
  }

  /**
   * CHIP CONTINUITY (OPORD 1.3 section 6.3): the stay clock ticks only while
   * the player is seated, in, and here. Sitting out (or asked to after this
   * hand), disconnected, or away (page hidden, AFK strikes) all freeze it -
   * the remainder is kept, never reset.
   */
  /**
   * CHIP CONTINUITY: a leave_pending seat was refused at the door (the player
   * won the hand they asked to leave during and is now ahead with clock
   * left). They are still seated - sat out by their own request - and are
   * told the countdown. Nothing is torn down.
   */
  protected onLeaveRefusedAtSettlement(
    userId: string,
    stayRemainingMs: number,
    occupancyId: string
  ): void {
    const current = this.seatedPlayers.find((p) => p.user_id === userId);
    const original = occupancyId;
    if (!original || current?.occupancy_id !== original) return;
    this.leaveHeldByClock.set(userId, original);
    this.chipContinuity.noteRefusal(userId, stayRemainingMs);
    console.log(
      `[ServerTableEngine:${this.tableId}] leave_pending refused at settlement for ${userId} - stay clock ${stayRemainingMs}ms remaining`
    );
    this.hub?.emitEvent(this.tableId, {
      type: 'leave_blocked',
      table_id: this.tableId,
      user_id: userId,
      stay_remaining_ms: stayRemainingMs,
      timestamp: Date.now(),
    });
  }

  /** Moves already announced to their player (once per move id). */
  protected announcedSeatMoves: Set<string> = new Set();

  /**
   * A SWAP SIDE HOLDING FOR ITS PARTNER (Dan 2026-09-05). Two seat-change
   * requests that would take each other's table are swapped: both chairs are
   * occupied, so the first side to reach its hand boundary cannot land and is
   * held OUT OF THE DEAL here (not sat out: the sit-out clock and its
   * eviction are for a player who chose to leave the action) until the other
   * table's boundary lands both chairs in one transaction. Cleared when the
   * player vanishes from this table's roster (the swap landed), or when the
   * pending list no longer carries their move (it was cancelled or expired).
   */
  protected heldForSwap: Set<string> = new Set();

  /**
   * WHAT THIS ENGINE STILL HOLDS FOR A MOVE, AGAINST WHAT IS STILL PENDING
   * (2026-09-09, must-move audit).
   *
   * Both prunes used to live inside `announcePendingSeatMoves`, which runs
   * IMMEDIATELY BEFORE `dealHand` and therefore never runs on a table that
   * cannot deal. A held swap side is filtered out of `activePlayers`, so on a
   * two-handed table one hold drops the table below the minimum, it takes the
   * idle branch, and it never announces again: if that swap then died in a way
   * the executor is never asked about - the planner cancelling the request, or
   * plain expiry - the player stayed out of the deal for ever and the table
   * never dealt another hand. Called from the announce AND from every execute,
   * so both loops reach it (idle: every 3 s, waiting: every 5 s).
   *
   * NEVER CALLED WITH A FAILED READ. `pendingSeatMoves` returns null for that,
   * and pruning against a list that is empty only because PostgREST hiccuped
   * would release a hold whose entire job is to keep a player out of a hand
   * the other table is about to move them out of.
   */
  protected reconcileSeatMoveHolds(pending: readonly PendingSeatMove[]): void {
    const live = new Set(pending.map((m) => m.move_id));
    for (const id of this.announcedSeatMoves) {
      if (!live.has(id)) this.announcedSeatMoves.delete(id);
    }
    // A held swap side whose move is no longer pending (cancelled, expired,
    // or landed from the other table) is released; if they are still seated
    // here they are simply back in the deal.
    const liveHeld = new Set(pending.filter((m) => m.ready_at != null).map((m) => m.player_id));
    for (const uid of this.heldForSwap) {
      if (!liveHeld.has(uid)) this.heldForSwap.delete(uid);
    }
  }

  /**
   * MUST-MOVE, the engine's half (OPORD 1.3 s9.5, OPORD 1.4 s18.3). At the
   * START of a hand every player with a planned move is told, once:
   * "Seat Open On Main 2. Moving After This Hand." Nothing is asked.
   *
   * THE PROMISE IS WRITTEN DOWN (2026-09-05): the row is stamped announced_at
   * and its expiry extended to cover the hand, so settlement executes exactly
   * the moves the deal promised, and a slow hand cannot expire one from under
   * the player who was told. Called immediately before dealHand, so it only
   * ever speaks of a hand that is about to be dealt.
   */
  /**
   * The pending list, or `null` when the read FAILED.
   *
   * `pendingSeatMoves` THROWS on an unreadable answer (#3974, and see the long
   * note on that function). That is the right contract for the service: an
   * enumeration nobody could read must never be mistaken for an empty one, and
   * a throw cannot be ignored by accident the way a value can.
   *
   * At these two call sites the correct response to "I could not tell" is to
   * CHANGE NOTHING - do not prune, do not release a swap hold, do not announce
   * - and then carry on. A notice that could not be read must never stop a
   * table dealing, and an unread list must never look like an empty one. So
   * the throw is translated here, once, and reported: everything above this
   * line keeps main's contract, everything below it keeps this lane's
   * invariant.
   */
  private async readPendingSeatMoves(): Promise<PendingSeatMove[] | null> {
    try {
      return await pendingSeatMoves(this.tableId);
    } catch (err) {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.pending_seat_moves_unreadable');
      return null;
    }
  }

  protected async announcePendingSeatMoves(): Promise<void> {
    if (this.isTournamentTable() || !this.tableInfo?.cluster_id) return;
    const pending = await this.readPendingSeatMoves();
    // A read that failed says nothing about what is pending: announce nothing,
    // release nothing. The next hand asks again.
    if (pending === null) return;
    this.reconcileSeatMoveHolds(pending);
    const fresh: string[] = [];
    for (const m of pending) {
      /* PRESENCE FOLLOWS THE PLAYER (2026-09-05). Stamped here, once per
         hand, for EVERY pending move rather than only for the ones this
         engine executes - because a SWAP is landed by the OTHER table's
         transaction, so the partner's own engine never runs an executor and
         this is its only chance to hand its player's presence over. Harmless
         for a move that never lands: an unclaimed deposit expires. */
      this.depositPresenceForMove(m.player_id, m.to_table_id);
      if (m.announced_at == null) fresh.push(m.move_id);
      if (this.announcedSeatMoves.has(m.move_id)) continue;
      this.announcedSeatMoves.add(m.move_id);
      this.hub?.emitEvent(this.tableId, {
        type: 'seat_move_pending',
        table_id: this.tableId,
        user_id: m.player_id,
        to_table_id: m.to_table_id,
        to_role: m.to_role,
        to_main_index: m.to_main_index,
        reason: m.reason,
        swap: m.swap_move_id != null,
        message: seatMoveNotice(m),
        timestamp: Date.now(),
      });
    }
    if (fresh.length > 0) await announceSeatMoves(fresh);
  }

  /**
   * A HELD PLAYER IS NOT IN THE DEAL. Read wherever the table counts who is
   * playing the next hand (activePlayers, the liveness count).
   */
  protected isHeldForSwap(userId: string): boolean {
    return this.heldForSwap.has(userId);
  }

  /**
   * A SEAT CHANGED (or a hand ended) on this table. If the table belongs to a
   * must-move game, tell the ClusterController so the game is ticked now,
   * debounced, instead of at the next 5 s pass - and instead of the 30 s rest
   * a dormant game takes. In-process, leader-only, and a no-op everywhere
   * else; `wakeCluster` never throws, and this wrapper makes sure of it, so a
   * controller fault can never become a table fault. 2026-09-05.
   */
  protected wakeClusterGame(_reason: string): void {
    const gameId = this.tableInfo?.cluster_id;
    if (!gameId || this.isTournamentTable()) return;
    try {
      wakeCluster(String(gameId));
    } catch {
      /* wakeCluster reports its own errors; nothing reaches the loop */
    }
  }

  /**
   * At the END of a hand (announced moves only) and whenever the table is
   * below the minimum to deal (every pending move - there is no hand to
   * finish) the planned moves are executed: chair, chips and session go to
   * the other table in one SQL transaction; this engine forgets the player
   * the way it forgets a leaver, except that nothing is cashed out and no
   * clock is closed. The destination engine sees the new seat on its next
   * deal (loadSeatedPlayers) and the controller wakes a dealer for a table
   * that has none.
   */
  protected async cashoutVoluntaryStay(
    player: SeatedPlayer
  ): Promise<Awaited<ReturnType<typeof atomicCashoutVoluntary>> | null> {
    // Snapshot before awaiting: callers may retain a mutable roster object.
    const { user_id, seat_number, occupancy_id } = player;
    const mayReflect = () => {
      if (!this.lifecycleCanMutate()) return false;
      const current = this.seatedPlayers.find((seat) => seat.user_id === user_id);
      return (
        !current || (current.occupancy_id === occupancy_id && current.seat_number === seat_number)
      );
    };
    if (!mayReflect()) return null;
    const result = await atomicCashoutVoluntary(user_id, this.tableId, seat_number, occupancy_id);
    // The durable outcome is still retained, but a later stay must not inherit
    // either its refusal clock or the cleanup of its local presence trackers.
    return mayReflect() ? result : null;
  }

  protected async executeIdleSeatMoves(): Promise<string[]> {
    const release = await this.acquireSeatBoundary();
    try {
      if (!this.lifecycleCanMutate()) return [];
      const raw = this.executePendingSeatMoves();
      const budgeted = this.withStepBudget(
        'idle_seat_moves',
        ServerTableEngineBase.DEAL_STEP_BUDGET_MS,
        raw
      );
      // A time budget cannot cancel a committed or in-flight transfer.
      // Keep the boundary until the original operation has actually settled.
      const [outcome, budget] = await Promise.allSettled([raw, budgeted]);
      if (outcome.status === 'rejected') throw outcome.reason;
      if (budget.status === 'rejected') throw budget.reason;
      return outcome.value;
    } finally {
      release();
    }
  }

  protected async executePendingSeatMoves(
    opts: { announcedOnly: boolean } = { announcedOnly: false },
    /** Read at this boundary by the caller; `null` is a read that FAILED. */
    prefetched?: readonly PendingSeatMove[] | null
  ): Promise<string[]> {
    if (this.isTournamentTable() || !this.tableInfo?.cluster_id) return [];
    /* ONE READ, USED TWICE (2026-09-09). The list is what the service would
       have fetched anyway, so this costs the same single round trip - and
       having it HERE is what lets a table that cannot deal still release a
       swap hold whose move has died (see reconcileSeatMoveHolds). */
    const pending = prefetched === undefined ? await this.readPendingSeatMoves() : prefetched;
    if (!this.lifecycleCanMutate()) return [];
    if (pending === null) return [];
    this.reconcileSeatMoveHolds(pending);
    const { done, held, refused } = await executePendingSeatMoves(this.tableId, opts, pending);
    // The SQL move is durable and idempotent, but this process's mirrors and
    // broadcasts belong only to the exact engine generation that requested it.
    if (!this.lifecycleCanMutate()) return [];
    // A MOVE THAT DID NOT HAPPEN IS SAID OUT LOUD (2026-09-09, must-move
    // audit). The deal promised "Moving After This Hand"; the executor then
    // found the seat taken, the table closed, or the swap partner gone, and
    // cancelled the row with a note. The row said so and the player was told
    // nothing - the corner notice simply vanished on the next lobby poll. They
    // keep the chair they are in; this says so, once, for the one player it
    // is about. The row is already terminal, so it cannot repeat.
    for (const r of refused) {
      this.announcedSeatMoves.delete(r.move_id);
      this.heldForSwap.delete(r.player_id);
      this.hub?.emitEvent(this.tableId, {
        type: 'seat_move_cancelled',
        table_id: this.tableId,
        user_id: r.player_id,
        move_id: r.move_id,
        reason: r.reason,
        message: seatMoveCancelledNotice(r.reason),
        timestamp: Date.now(),
      });
      console.log(
        `[ServerTableEngine:${this.tableId}] move ${r.move_id} for ${r.player_id} refused (${r.reason}) - the player keeps their chair`
      );
    }
    // The first side of a swap to reach its boundary: held out of the deal
    // until the other table lands both chairs. Told once.
    for (const h of held) {
      const current = this.seatedPlayers.find((sp) => sp.user_id === h.player_id);
      if (!current || current.occupancy_id !== h.source_occupancy_id) continue;
      // A held side is still seated HERE and will be moved by the other
      // table's transaction: refresh its deposit while this engine still has
      // its presence to give.
      this.depositPresenceForMove(h.player_id, h.to_table_id);
      if (this.heldForSwap.has(h.player_id)) continue;
      this.heldForSwap.add(h.player_id);
      this.hub?.emitEvent(this.tableId, {
        type: 'seat_move_held',
        table_id: this.tableId,
        user_id: h.player_id,
        to_table_id: h.to_table_id,
        message: 'Seat Change: Waiting For The Other Table To Finish Its Hand.',
        timestamp: Date.now(),
      });
    }
    const movedIds: string[] = [];
    for (const m of done) {
      const current = this.seatedPlayers.find((sp) => sp.user_id === m.player_id);
      if (current && current.occupancy_id !== m.source_occupancy_id) continue;
      movedIds.push(m.player_id);
      this.announcedSeatMoves.delete(m.move_id);
      this.heldForSwap.delete(m.player_id);
      const seated = this.seatedPlayers.find((sp) => sp.user_id === m.player_id);
      /* PRESENCE FOLLOWS THE PLAYER. The freshest possible stamp: taken
         immediately before this engine forgets them, so the destination
         adopts what they were half a second ago rather than what they were at
         the start of the hand. */
      this.depositPresenceForMove(m.player_id, m.to_table_id);
      this.disconnectEngine.unregisterPlayer(this.tableId, m.player_id);
      this.timeBankEngine.removePlayer(this.tableId, m.player_id);
      this.straddleEngine.removePlayer(this.tableId, m.player_id);
      this.preActionEngine.removePlayer(this.tableId, m.player_id);
      this.leaveHeldByClock.delete(m.player_id);
      // The session row followed the player; only this engine's mirror of
      // it is dropped. The destination engine rebuilds its mirror from rows.
      this.chipContinuity.forget(m.player_id);
      /* THE TAB FOLLOWS THE CHAIR, EVEN THROUGH A DROPPED SOCKET (2026-09-09,
         must-move audit). `seat_moved` is the one packet that tells the
         hero's client their chair is now at another table. It was fire-once:
         a hero whose socket was between reconnects for the instant the move
         landed came back to a table they no longer sit at, with nothing to
         tell them where they went. `replay_until` asks the hub to hand it to
         a subscriber that (re)joins this room inside a minute (D3 retention:
         once per subscriber, never to one that already got it live). */
      this.hub?.emitEvent(this.tableId, {
        type: 'seat_moved',
        table_id: this.tableId,
        seat: seated?.seat_number ?? null,
        user_id: m.player_id,
        to_table_id: m.to_table_id,
        to_seat: m.to_seat_number,
        stack: m.stack,
        reason: m.reason,
        timestamp: Date.now(),
        replay_until: Date.now() + 60_000,
      });
      console.log(
        `[ServerTableEngine:${this.tableId}] ${m.player_id} moved to ${m.to_table_id} seat ${m.to_seat_number} with ${m.stack} (${m.reason})`
      );
      // A SWAP LANDED FROM THIS SIDE: the partner left the OTHER table in the
      // same transaction, and that table's engine will only see an empty
      // chair. Tell that table now, so the partner's client follows them the
      // way every mover's does; that engine drops its own mirrors the moment
      // its roster no longer carries them (the gone-player prune).
      if (m.partner) {
        this.hub?.emitEvent(m.partner.from_table_id, {
          type: 'seat_moved',
          table_id: m.partner.from_table_id,
          seat: null,
          user_id: m.partner.player_id,
          to_table_id: m.partner.to_table_id,
          to_seat: m.partner.to_seat_number,
          stack: m.partner.stack,
          reason: 'seat_change',
          timestamp: Date.now(),
          replay_until: Date.now() + 60_000,
        });
        console.log(
          `[ServerTableEngine:${this.tableId}] swap: ${m.partner.player_id} arrived from ${m.partner.from_table_id} into seat ${m.partner.to_seat_number}`
        );
      }
    }
    if (movedIds.length > 0) {
      this.seatedPlayers = this.seatedPlayers.filter((sp) => !movedIds.includes(sp.user_id));
      void this.broadcastCurrentState();
      // The game's seats changed at two tables at once; one wake covers both.
      this.wakeClusterGame('seat_move');
    }
    return movedIds;
  }

  /**
   * Hand this player's presence to the table they are moving to.
   *
   * The FSM entry is exactly what a restart persists to
   * `engine_presence_parked` - `getFsmState` is the one function that answers
   * "what is this seat's presence right now", so the move and the restart
   * carry the same thing and can never drift apart. A player this engine has
   * never registered (a chair created mid-buy-in, or a move planned before the
   * first deal) has no entry and nothing is deposited: the destination then
   * registers them the ordinary way, which is what happened before any of
   * this existed.
   */
  protected depositPresenceForMove(playerId: string, toTableId: string): void {
    if (!playerId || !toTableId || toTableId === this.tableId) return;
    const fsm = this.disconnectEngine.getFsmState(this.tableId, playerId);
    if (!fsm) return;
    const bank = this.timeBankEngine.getPlayerBank(this.tableId, playerId);
    const meta = this.timeBankMeta.get(playerId);
    depositMovedPresence(playerId, toTableId, {
      fsm,
      fromTableId: this.tableId,
      timeBank: bank
        ? {
            remainingSeconds: bank.remainingSeconds,
            usesRemaining: bank.usesRemaining,
            initialSeconds: meta?.initialSeconds ?? bank.remainingSeconds,
            baseSeconds: meta?.baseSeconds ?? this.timeBankBaseSeconds,
            dbConsumedSeconds: meta?.dbConsumedSeconds ?? 0,
          }
        : null,
    });
  }

  /**
   * ADOPT WHAT ARRIVED WITH THE PLAYER (2026-09-05).
   *
   * Called on every seat sweep, from BOTH the start-up wait loop and the
   * dealing loop, for the same reason `restoreSitOutsFromSeats` is called from
   * both: a table below the minimum to deal never reaches the dealing loop,
   * and a feeder's mover often lands on exactly such a table.
   *
   * IT MUST RUN BEFORE `restoreSitOutsFromSeats`, and the order is load-
   * bearing rather than tidy. `restoreSitOutsFromSeats` calls
   * `registerPlayer`, and `restoreFsmStates` refuses - correctly - to clobber
   * a live entry, so registering first would leave the arriving player with a
   * fresh CONNECTED state and throw the strikes, the away-blind budget and the
   * sit-out clock away, which is the whole bug this closes.
   *
   * The time bank is seeded here too, and only here: the dealing loop's own
   * seeding is guarded on `!getPlayerBank(...)`, so a bank adopted now is the
   * one the player keeps and the free refill never happens for a mover.
   */
  protected adoptMovedPresence(): void {
    for (const p of this.seatedPlayers) {
      const carried = claimMovedPresence(p.user_id, this.tableId);
      if (!carried) continue;
      const restored = this.disconnectEngine.restoreFsmStates(this.tableId, {
        [p.user_id]: carried.fsm,
      });
      if (carried.timeBank && !this.timeBankEngine.getPlayerBank(this.tableId, p.user_id)) {
        this.timeBankEngine.initializePlayer(this.tableId, p.user_id, {
          remainingSeconds: carried.timeBank.remainingSeconds,
          usesRemaining: carried.timeBank.usesRemaining,
        });
        this.timeBankMeta.set(p.user_id, {
          initialSeconds: carried.timeBank.initialSeconds,
          baseSeconds: carried.timeBank.baseSeconds,
          dbConsumedSeconds: carried.timeBank.dbConsumedSeconds,
        });
      }
      console.log(
        `[ServerTableEngine:${this.tableId}] presence followed ${p.user_id} from ` +
          `${carried.fromTableId}: ${carried.fsm.state}` +
          (restored ? '' : ' (a live observation already won)')
      );
    }
  }

  /** Last time the empty-cluster-table check read the row. See below. */
  private lastClusterClosedCheckAt = 0;

  /**
   * AN ENGINE ON A CLOSED CLUSTER TABLE STOPS (2026-09-05). The controller
   * closes a breaking table the moment its last chair empties, and nothing
   * on the engine side read that: the engine sat in the idle branch for ever,
   * asking for seats, add-ons, leavers and moves every three seconds on a
   * table no one can join. Asked once a minute, only while the table is
   * empty; a closed row ends this engine, the reaper drops it from the map,
   * and discovery would rebuild it if a seat ever appeared (it cannot: the
   * door refuses a closed table).
   */
  protected async stopIfClusterTableClosed(): Promise<void> {
    if (this.isTournamentTable() || !this.tableInfo?.cluster_id) return;
    if (this.seatedPlayers.length > 0) return;
    const now = Date.now();
    if (now - this.lastClusterClosedCheckAt < 60_000) return;
    this.lastClusterClosedCheckAt = now;
    const { data, error } = await supabase
      .from('tables')
      .select('lifecycle, status')
      .eq('id', this.tableId)
      .maybeSingle();
    if (error) {
      // Once a minute and harmless to miss once - but a read that keeps
      // failing keeps an engine on a closed table for ever, and a swallowed
      // error is how nobody finds out (CLAUDE.md 10.86).
      reportError(error, 'ServerTableEngine.' + this.tableId + '.cluster_closed_read_failed');
      return;
    }
    if (!data) return;
    const row = data as { lifecycle?: string | null; status?: string | null };
    if (row.lifecycle === 'closed' || row.status === 'closed') {
      console.log(
        `[ServerTableEngine:${this.tableId}] cluster table is ${row.lifecycle ?? row.status} and empty - stopping the engine`
      );
      await this.stop();
    }
  }

  protected isContinuityActive(userId: string): boolean {
    // A leave the clock is holding serves the clock: the player asked to go,
    // and the sit-out that keeps them out of the deal is the engine's, not
    // their choice.
    if (this.leaveHeldByClock.has(userId)) return true;
    if (this.pendingSitOut.has(userId)) return false;
    if (this.disconnectEngine.isSittingOut(this.tableId, userId)) return false;
    if (!this.disconnectEngine.isConnected(this.tableId, userId)) return false;
    if (this.disconnectEngine.isAway(this.tableId, userId)) return false;
    return true;
  }

  protected scheduleHeartbeatCheck(): void {
    deadlineScheduler.schedule({
      tableId: this.tableId,
      eventId: ServerTableEngineBase.HEARTBEAT_EVENT_ID,
      deadlineMs: Date.now() + ServerTableEngineBase.HEARTBEAT_INTERVAL_MS,
      callback: () => {
        if (!this.running || !this.heartbeatActive) return;
        // 2026-08-15: this callback is the ONLY thing that re-arms the
        // heartbeat, and the heartbeat is what drives horse liveness, stale
        // disconnect detection AND the table watchdog. Previously only
        // runTableWatchdog() was wrapped, so a throw from the horse heartbeat
        // loop or checkStaleHeartbeats permanently killed all three for that
        // table — including the freeze recovery. Everything is inside the try,
        // and the re-arm is in a finally so it survives any of them throwing.
        try {
          // Keep horses alive — server-driven seats have no real client to
          // heartbeat, so the engine synthesises one for each.
          for (const p of this.seatedPlayers ?? []) {
            if (p.is_horse) {
              this.disconnectEngine.heartbeat(this.tableId, p.user_id);
            }
          }
          this.disconnectEngine.checkStaleHeartbeats(this.tableId);
          this.runTableWatchdog();
          // Phase 6: refresh cached tournament facts from a lifecycle-owned
          // tick, never while a horse's action clock is being constructed.
          if (this.tableInfo?.tournament_id) {
            refreshTournamentBrainContext(String(this.tableInfo.tournament_id));
          }
          // CHIP CONTINUITY: presence just got re-evaluated above (stale
          // heartbeats -> disconnected), so this is the moment to tell the
          // database which stay clocks pause and which resume. Only
          // transitions cross the wire; a quiet table costs nothing.
          void this.chipContinuity
            .sweepPresence(this.seatedPlayers ?? [], (uid) => this.isContinuityActive(uid))
            .then(() => this.releaseLeavesHeldByClock())
            .catch((err) =>
              reportError(err, 'ServerTableEngine.' + this.tableId + '.continuity_sweep_threw')
            );
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.heartbeat_tick_threw');
        } finally {
          // cancel() in stop() will purge any entry queued here if a stop
          // happens between scheduling and tick.
          if (this.running && this.heartbeatActive) {
            this.scheduleHeartbeatCheck();
          }
        }
      },
    });
  }

  /**
   * Called from every path that PROVES the table is alive. Cheap by design —
   * it is on the hot path of every action.
   */
  protected markProgress(): void {
    this.lastProgressAtMs = Date.now();
    this.watchdogTrips = 0;
    this.pendingRecoveryEventClass = null;
  }

  /** Ms since this table last did anything observable. */
  msSinceProgress(): number {
    return Date.now() - this.lastProgressAtMs;
  }

  /**
   * Did this engine stop without tearing itself down? Cancel what it left, and
   * say what that was.
   *
   * Every path that clears `running` today — stop(), killForRestart() — does
   * full teardown at source, so this is expected to return null forever. But
   * GameServer's reaper deletes a not-running engine on TRUST that this is so,
   * and the cost of that trust being wrong once is a heartbeat entry and armed
   * turn deadlines belonging to a table nothing owns any more: the table stops
   * being watched, and every stall on it becomes permanent.
   *
   * The ownership guard is what makes the cleanup safe. If a replacement engine
   * has already claimed this tableId then the scheduler entries are ITS entries
   * and cancelling them would cause the exact freeze this is guarding against —
   * so a superseded instance reports and cancels nothing.
   */
  public reconcileTeardown(): string | null {
    if (this.running) return null;
    if (!ServerTableEngineBase.isCurrentEngineFor(this.tableId, this)) return null;
    // persistPending is the scheduler's read-only view of one table's entries
    // (it serializes them, it does not remove them). listTable lives on the
    // inner heap and is not public.
    const stranded = deadlineScheduler.persistPending(this.tableId);
    if (stranded.length === 0) return null;
    const ids = stranded
      .map((d) => d.eventId)
      .sort()
      .join(', ');
    deadlineScheduler.cancelAll(this.tableId);
    return ids;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // DEALING-LOOP PHASE — Dan 2026-08-22: "find every reason games freeze"
  //
  // On 2026-08-22 the live fleet logged 1,603 `dealing_loop_dead` kills in six
  // hours. EVERY running cash table was killed 22-30 times, each one after an
  // average of THREE hands, and hand_history showed the shape exactly: normal
  // 8-45s hand spacing, then a gap of 107s, 107s, 114s, 87s — the two 90s
  // watchdog trips plus the rebuild, over and over, on fully funded tables
  // that nothing was actually wrong with.
  //
  // The kills carried no cause. `dealing_loop_dead` is inferred from the
  // OUTSIDE: no handController, two dealable seats, no progress for 90s. That
  // is the symptom of every possible stall in the between-hands path and it
  // names none of them, so six hours of fleet-wide breakage produced 1,603
  // identical rows and not one clue.
  //
  // The loop now says where it is. Every step stamps a phase, so a stall is
  // reported as the thing it is (`load_seats+96s`) rather than as an
  // anonymous death, and `msSinceLoopPhase()` gives the watchdog a way to ask
  // "is this loop WEDGED" instead of only "has a hand started lately" — a
  // question a table waiting on a slow database answers wrongly.
  // ═════════════════════════════════════════════════════════════════════════

  /** Where dealingLoop is right now. See the block above. */
  protected loopPhase: string = 'not_started';
  /** When the loop entered `loopPhase`. */
  protected loopPhaseSinceMs: number = Date.now();

  /**
   * Stamp the loop's current step. Re-stamping the SAME phase still refreshes
   * the clock: a loop cycling load_seats -> deal -> load_seats is alive, and
   * the second visit is new evidence of that, not a continuation of the first.
   */
  protected setLoopPhase(phase: string): void {
    this.loopPhase = phase;
    this.loopPhaseSinceMs = Date.now();
  }

  /** Ms the dealing loop has been sitting in its current step. */
  msSinceLoopPhase(): number {
    return Date.now() - this.loopPhaseSinceMs;
  }

  /**
   * Did the database blink, as opposed to the code being wrong?
   *
   * This list already existed, inline, inside dealingLoop's catch — and
   * `start()` had no equivalent, so THE SAME transient error was survivable in
   * one and fatal in the other. On 2026-08-22, after the dealing-loop kills
   * were fixed, `start_failed` became the fleet's dominant fault: 117 in
   * fifteen minutes, in bursts (86 across 43 tables in a single minute). Two
   * places that must agree cannot agree while only one of them has the list.
   */
  protected static isTransientDbError(err: unknown): boolean {
    const msg =
      err instanceof Error
        ? err.message
        : (err as { message?: string })?.message ||
          (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err));
    return (
      msg.includes('Project not specified') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('Failed to fetch') ||
      msg.includes('fetch failed') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('socket hang up') ||
      msg.includes('supabase_timeout') ||
      msg.includes('This operation was aborted') ||
      msg.includes('The operation was aborted') ||
      msg.includes('deal_step_timeout') ||
      /* A SERIALIZATION FAILURE IS THE DATABASE BLINKING, BY DEFINITION
         (2026-09-12).
         Every entry above is a TRANSPORT failure. The one error Postgres
         itself defines as "this conflicted, run it again" was missing, so the
         question in this method's own title was answered "the code is wrong"
         for the textbook case of the database blinking.
         `smarter_private.f06_try_lane` raises exactly this when it cannot take
         the shared `ca:tournament-terminal-settlement:v1` lock, and it spells
         the remedy into the message:
             RAISE EXCEPTION 'F06_RETRY_CANONICAL_LANE' USING ERRCODE='40001'
         Nothing has been written when it fires - the lock is taken before the
         work - and the caller sees `atomic_hand_rolled_back`, so a retry
         re-runs a transaction that committed nothing.
         Measured on production 2026-09-12: 412 hands in two hours whose
         history was never written, 820 alerts in all, because the engine
         treated an explicit request to retry as a terminal refusal. */
      msg.includes('F06_RETRY_CANONICAL_LANE') ||
      /^40001$/.test(String((err as { code?: unknown })?.code ?? '')) ||
      msg.includes('could not serialize access') ||
      msg.includes('deadlock detected')
    );
  }

  /**
   * Did the database roll the WHOLE hand back and ask to be run again?
   *
   * `fn_ca_commit_hand_settlement` answers a refusal with a reason, and two of
   * those reasons mean "this transaction wrote nothing":
   * `atomic_hand_rolled_back` (the accepted-hand core's own
   * `EXCEPTION WHEN OTHERS`) and `rolled_back` (the stack core's). They reach
   * the engine as `atomic hand commit refused (<reason>): <sqlerrm>`, and
   * `insertHandHistoryRow` throws them without a retry because every string
   * containing "atomic hand commit refused" is treated as deterministic.
   *
   * Most of them ARE deterministic and must stay terminal - a conservation
   * violation, a negative stack, a constraint, a missing column. What
   * separates the rest is the SQLERRM the reason carries, so this asks BOTH
   * questions: the database said it rolled back, AND the cause is the one
   * Postgres defines as "this conflicted, run it again". Only then is another
   * attempt a re-run of a transaction that committed nothing.
   *
   * Measured on production 2026-09-12, 10:00-11:35 UTC: 1,021 of 1,023
   * semantic refusals were exactly this pair - `atomic_hand_rolled_back` or
   * `rolled_back`, carrying `F06_RETRY_CANONICAL_LANE`. Not one carried a
   * rounding, denomination, pot-total or seat-set reason.
   */
  protected static isRolledBackSerializationRefusal(err: unknown): boolean {
    const msg =
      err instanceof Error
        ? err.message
        : (err as { message?: string })?.message ||
          (typeof err === 'object' && err !== null ? JSON.stringify(err) : String(err));
    return (
      /atomic hand commit refused \((?:atomic_hand_)?rolled_back\)/.test(msg) &&
      ServerTableEngineBase.isTransientDbError(err)
    );
  }

  /** `load_seats+96s` — for recovery-event details and /health. */
  describeLoopPhase(): string {
    return this.loopPhase + '+' + Math.round(this.msSinceLoopPhase() / 1000) + 's';
  }

  /**
   * Await `work`, but never for longer than `budgetMs`.
   *
   * Every await in the between-hands path is a Supabase round trip, and the
   * sum of them was unbounded while the watchdog that judges them was not.
   * Database slowness is CORRELATED across tables, so one slow minute did not
   * stall one table — it stalled the whole fleet at once, got every engine
   * killed at once, and the rebuild storm that followed put the database
   * under more load than the slowness that started it. A self-feeding spiral
   * is how 1,603 kills happen in six hours.
   *
   * On timeout this REJECTS rather than returning a partial result: a hand
   * dealt from a half-loaded seat list is worse than a hand not dealt. The
   * message is in the dealing loop's existing transient list, so the loop
   * backs off and retries the step instead of counting it toward the 10-error
   * shutdown.
   */
  protected async withStepBudget<T>(phase: string, budgetMs: number, work: Promise<T>): Promise<T> {
    this.setLoopPhase(phase);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'deal_step_timeout: ' + phase + ' exceeded ' + Math.round(budgetMs / 1000) + 's'
                )
              ),
            budgetMs
          );
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Overridden in ServerTableEngineTurns, which is the first subclass with
   * access to the turn timer and the hand controller. No-op here so Base can
   * drive it from the heartbeat without a circular dependency.
   */
  protected runTableWatchdog(): void {}

  /**
   * Mark the engine dead and signal its exact map owner to tear it down and
   * install a fresh generation (crash recovery rehydrates from
   * hand_state_snapshots). The slower liveness scanners remain diagnostic
   * defense; they are no longer the primary recovery mechanism. Leaving
   * `running` true is what turned every transient stall into a permanent one.
   */
  protected killForRestart(
    reason: string,
    notifyOwner = true,
    recoveryEventClass?: EngineRecoveryEventClass
  ): void {
    reportError(
      new Error('Engine self-terminating for restart: ' + reason),
      'ServerTableEngine.' + this.tableId + '.watchdog_kill',
      { handCount: this.handsDealtThisSession, currentHandNumber: this.handCount }
    );
    this.recordRecoveryEvent(
      'watchdog_kill_rebuild',
      reason,
      recoveryEventClass ?? this.pendingRecoveryEventClass ?? AUTOMATIC_RECOVERY_EVENT_CLASS
    );
    // A terminal kill is the end of the recovery chain. Non-terminal recovery
    // records deliberately leave drill provenance armed until real progress
    // proves the injected fault has ended.
    this.pendingRecoveryEventClass = null;
    this.terminal = true;
    this.running = false;
    this.clearEngineLeaseExpiryTimer();
    this.clearUnclaimedTournamentMovePauses();
    this.releasePendingPauseWait();
    this.settleReady(false);
    this.heartbeatActive = false;
    this.clearHandSafetyTimer();
    this.clearLooseHandTimers();
    // CROSS-INSTANCE GUARD (2026-08-22): only the authoritative instance may
    // touch the shared scheduler — see stop() for the full rationale.
    if (ServerTableEngineBase.isCurrentEngineFor(this.tableId, this)) {
      deadlineScheduler.cancel(this.tableId, ServerTableEngineBase.HEARTBEAT_EVENT_ID);
      this.preciseTimer.clearTable(this.tableId);
      // preciseTimer.clearTable only covers `turn:*`. insurance_offer:*, rit_offer
      // and table_break:* live on the same shared scheduler under this tableId and
      // would otherwise fire callbacks bound to this dead engine instance forever.
      deadlineScheduler.cancelAll(this.tableId);
      // Keep process ownership until stop() completes. The map and this
      // registry now agree that a killed generation is quarantined, so a
      // replacement cannot claim the shared scheduler while module teardown
      // is still pending.
    }
    this.handController = null;
    if (notifyOwner) this.signalRestartRequired(reason);
  }

  /**
   * Subscribe the exact map owner to this generation's terminal signal.
   * Runtime dealing/watchdog failures are detached from start(), so rejection
   * cannot reach the owner. This one-shot callback is their causal replacement
   * for waiting on a later discovery scan. Start failures still reject start()
   * directly and deliberately do not emit a second cleanup signal.
   */
  onRestartRequired(callback: (reason: string) => void): () => void {
    this.restartRequiredCallback = callback;
    return () => {
      if (this.restartRequiredCallback === callback) this.restartRequiredCallback = null;
    };
  }

  private signalRestartRequired(reason: string): void {
    if (this.restartRequiredSignalled) return;
    this.restartRequiredSignalled = true;
    const callback = this.restartRequiredCallback;
    if (!callback) return;
    queueMicrotask(() => {
      if (this.restartRequiredCallback !== callback) return;
      try {
        callback(reason);
      } catch (error) {
        reportError(error, 'ServerTableEngine.restart_required_callback_failed', {
          tableId: this.tableId,
          reason,
        });
      }
    });
  }

  isRunning(): boolean {
    if (!this.engineLeaseAuthorityIsCurrent()) {
      this.expireEngineLeaseAuthority();
      return false;
    }
    return this.running;
  }

  /**
   * Whether this generation can no longer own any process-global deadline or
   * timer slot. performStop deliberately completes that release before it
   * reports aggregated cleanup diagnostics; owners use this narrow proof to
   * distinguish "teardown failed before the fence" from "teardown completed
   * but a non-ownership cleanup also failed".
   */
  hasReleasedProcessOwnership(): boolean {
    return (
      !this.claimedProcessOwnership || !ServerTableEngineBase.isCurrentEngineFor(this.tableId, this)
    );
  }

  /**
   * Is this hand's money still being written?
   *
   * postHandTasks is the settlement, the rake record and the hand history.
   * `running` going false does not stop it - it is a promise already in
   * flight, and it keeps writing until it resolves or the process dies.
   *
   * GameServer.drainHands() reads this. Before 2026-09-06 the drain counted
   * a table as "parked at a hand boundary" the moment !isRunning(), so a
   * SIGTERM at :55 - which arrives EVERY HOUR - could report a clean drain
   * and exit with a settlement half-written. Postgres protects the atomicity
   * of the settlement transaction itself; what it cannot protect is the rest
   * of postHandTasks, which is exactly where the unbanked-rake and
   * board_not_recorded detectors have been finding their work.
   */
  hasSettlementInFlight(): boolean {
    return (this.settlementInFlight?.size ?? 0) > 0;
  }

  /** Continuous age of the owned settlement; null after completion. */
  settlementAgeMs(): number | null {
    if (!this.hasSettlementInFlight() || this.settlementStartedAtMs === null) return null;
    return Math.max(0, Date.now() - this.settlementStartedAtMs);
  }

  /**
   * Follow one settlement promise to its end.
   *
   * `postHandTasksPromise` is cleared by the DEALING loop, at the top of the
   * next hand - which is the wrong clock for a drain, because a table that
   * stops between hands never runs that line again and would hold the drain
   * open for its whole 18-second budget on every single restart. This field
   * is cleared by the promise itself, so it answers "is money still moving"
   * rather than "has the next hand started".
   *
   * Identity-checked on both settle paths: a later hand's barrier replaces
   * this field, and a stale promise resolving afterwards must not clear a
   * newer one.
   */
  protected trackSettlementInFlight(p: Promise<void> | null): void {
    // Some recovery/test harnesses are deliberately constructed without the
    // class field initializers. Re-establish the same empty-set invariant at
    // the ownership boundary instead of throwing while trying to record the
    // very writer teardown must wait for.
    const settlements =
      this.settlementInFlight ?? (this.settlementInFlight = new Set<Promise<void>>());
    if (!p) {
      settlements.clear();
      this.settlementStartedAtMs = null;
      this.notifyBoundaryPauseWaiters();
      return;
    }
    // Extending a hand's barrier must retain its original age. Retry
    // heartbeats prove the process runs, not that this settlement completed.
    if (settlements.size === 0) this.settlementStartedAtMs = Date.now();
    settlements.add(p);
    const tracked = p;
    const clear = (failed: boolean): void => {
      settlements.delete(tracked);
      if (failed) this.terminalBoundaryPersistenceFailed = true;
      if (settlements.size === 0) this.settlementStartedAtMs = null;
      if (this.postHandTasksPromise === tracked) this.postHandTasksPromise = null;
      this.notifyBoundaryPauseWaiters();
    };
    /* .then(clear).catch(clear) rather than .then(clear, clear): the two-arg
       form handles rejection just as well, but noUnhandledRejections.law reads
       `void ....then(` and asks for a visible .catch, and a reader scanning for
       one deserves the same answer the linter gets. */
    void tracked.then(() => clear(false)).catch(() => clear(true));
  }
  /**
   * Allocate this hand's GLOBAL hand number (2026-08-18).
   *
   * One `nextval` per hand, at deal time. Deliberately NOT batched into
   * per-table blocks: a block would let table A hold 1,000,100-1,000,199 while
   * table B deals 1,000,200, so the numbers would no longer ascend in the order
   * hands were actually dealt — which is the property that makes them useful
   * for investigating "what happened next".
   *
   * ON FAILURE IT REFUSES TO DEAL, by design. A hand that cannot be numbered
   * also cannot be settled, raked, recorded to history, or paid a jackpot —
   * every one of those needs the same database. Dealing an unnumbered ghost
   * hand would produce real money movement that no number can ever identify,
   * which is precisely the situation this work exists to end. Failing here
   * stalls one hand; dealing anyway corrupts the audit trail permanently.
   */
  protected async allocateGlobalHandNumber(): Promise<number> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { data, error } = await supabase.rpc('fn_next_hand_number');
        if (error) throw error;
        const n = Number(data);
        // A sequence never returns 0, NULL or anything below its MINVALUE, so
        // any of those means we did not get a real allocation.
        if (Number.isFinite(n) && n >= 1000000) return n;
        throw new Error(`allocator returned an unusable value: ${JSON.stringify(data)}`);
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 100 * attempt));
        }
      }
    }

    reportError(
      new Error(
        `[HandNumber] Could not allocate a global hand number for table ${this.tableId} ` +
          `after ${MAX_ATTEMPTS} attempts - refusing to deal. A hand that cannot be numbered ` +
          `cannot be settled or audited. Underlying error: ${String(
            (lastErr as { message?: string })?.message ?? lastErr
          )}`
      ),
      'ServerTableEngine.hand_number_allocation_failed'
    );
    throw new Error('hand number allocation failed');
  }

  /** Hands dealt by this engine (a count). NOT the global hand number. */
  getHandCount(): number {
    return this.handCount;
  }

  /**
   * 2026-08-15 observability. `/health` previously reported process-up only, so
   * a process where every table was frozen still answered
   * {"status":"ok","running":true} — which is also exactly what the deploy
   * gate grepped for. These three accessors are what make a freeze detectable
   * from outside without a human noticing.
   */
  seatedCount(): number {
    return this.seatedPlayers.length;
  }

  dealableCount(): number {
    // Tournament sit-outs are still dealt in (blind-off) — count them, or a
    // table of sat-out players would read idle-by-design and never finish.
    return this.seatedPlayers.filter(
      (p) =>
        p.stack > 0 &&
        (this.isTournamentTable() ||
          !this.disconnectEngine.isSittingOut(this.tableId, p.user_id)) &&
        !this.waitingForBB.has(p.user_id) &&
        !this.heldForSwap.has(p.user_id)
    ).length;
  }

  isTournament(): boolean {
    return this.isTournamentTable();
  }

  /**
   * Humans (not horses) currently seated with chips. Drives the deploy drain
   * gate: restarting the engine voids whatever hand is in flight, which is
   * invisible in aggregate metrics but very visible to the person it happens
   * to. A deploy consults this so a routine server/ push can't blow up a live
   * pot at a table with real people at it.
   */
  humansSeated(): number {
    return this.seatedPlayers.filter((p) => !p.is_horse && p.stack > 0).length;
  }

  /**
   * Horses currently seated with chips, the twin of humansSeated() for the
   * fleet gauges (`poker_horses_seated`, `poker_tables_with_horses` in
   * GameServer.getPrometheusMetrics). Identification only (CLAUDE.md 10.5):
   * it counts, it decides nothing. Dan 2026-09-11: the page for "the horses
   * can't play" needs the number of horses playing to exist as a series.
   */
  horsesSeated(): number {
    return this.seatedPlayers.filter((p) => p.is_horse === true && p.stack > 0).length;
  }

  /**
   * Drill-only public wrapper over the protected killForRestart path.  The
   * classification is structural rather than inferred from the reason text:
   * a drill may deliberately use a real-looking reason while exercising the
   * exact production path, but it still cannot become kill-storm evidence.
   */
  killForRestartPublic(reason: string): void {
    this.killForRestart(reason, true, FAULT_INJECTION_EVENT_CLASS);
  }

  /**
   * Seated roster, used by the fault-injection safety gate to refuse a drill on
   * any table where a real person is sitting.
   */
  seatedRoster(): Array<{ user_id: string; seat_number: number; is_horse: boolean }> {
    return this.seatedPlayers.map((p) => ({
      user_id: p.user_id,
      seat_number: p.seat_number,
      is_horse: !!p.is_horse,
    }));
  }

  // FIX 153: Expose telemetry snapshot for health endpoint
  getTelemetrySnapshot() {
    return this.engineTelemetry.getSnapshot();
  }

  // FIX-224: Bible V8 §9.1.1/§9.1.2 — Record action processing performance
  recordActionPerformance(userId: string, action: string, processingMs: number): void {
    // broadcastMs tracked separately when available; pass null for now
    this.engineTelemetry.recordActionProcessingTime(
      this.tableId,
      userId,
      action,
      processingMs,
      null
    );
  }

  // FIX-224: Bible V8 §9.1 — Expose performance summary for health endpoint
  getPerformanceSummary() {
    return this.engineTelemetry.getPerformanceSummary();
  }

  // Bible V8 §10.4 — Prometheus text exposition format.
  // Correct for ONE engine in isolation. The fleet endpoint must NOT
  // concatenate these: every global gauge in here is unlabelled, so N engines
  // produce N samples of the same series. Use `telemetry` with
  // `EngineTelemetry.renderFleetMetrics` instead — see the note there.
  getPrometheusMetrics(): string {
    return this.engineTelemetry.getPrometheusMetrics();
  }

  /** The telemetry instance, so the fleet renderer can aggregate globals once. */
  get telemetry(): EngineTelemetry {
    return this.engineTelemetry;
  }

  onHandComplete(
    callback: (tableId: string, players: { user_id: string; stack: number }[]) => void
  ): void {
    this.handCompleteCallback = callback;
  }

  /** Subscribe this exact engine generation to its between-hands pause edge. */
  onPauseReady(callback: (tableId: string) => void): () => void {
    this.pauseReadyCallback = callback;
    return () => {
      if (this.pauseReadyCallback === callback) this.pauseReadyCallback = null;
    };
  }

  /**
   * Pause dealing after the current hand finishes.
   *
   * Used by hand-for-hand (pauses measured in seconds) and by synchronized
   * breaks (pauses measured in minutes).
   *
   * Dan 2026-08-19: the park inside the deal loop carries a safety timeout so a
   * table can never wedge forever. It was hard-coded to 120 SECONDS — right for
   * hand-for-hand, fatally short for a break, which runs five minutes AFTER the
   * last hand lands. Every table would silently resume dealing two minutes into
   * the break no matter what the manager wanted. Callers that need a longer
   * pause now say so; the safety net still exists, it is just sized to the
   * pause being requested.
   */
  pauseAfterHand(
    maxWaitMs?: number,
    opts?: { beforeNextHand?: boolean; untilResumed?: boolean }
  ): void {
    this.handForHandPaused = true;
    this.pauseMaxWaitMs = maxWaitMs && maxWaitMs > 0 ? maxWaitMs : null;
    // See holdBeforeNextHand. Sticky within one pause: a break already holding
    // the table must not be downgraded by a later ordinary pause request.
    if (opts?.beforeNextHand) this.holdBeforeNextHand = true;
    if (opts?.untilResumed) this.pauseRequiresExplicitResume = true;
    if (this.pausedSinceMs === 0) this.pausedSinceMs = Date.now();
  }

  /**
   * Pause for the scheduled maintenance break (Dan 2026-09-01).
   *
   * Separate from pauseAfterHand so that hand-for-hand's resume cannot lift
   * it — see the `maintenancePaused` field for the incident this prevents.
   * Same guarantee otherwise: the hand in front of the player finishes, and
   * the loop parks at the TOP of its next iteration so an idle table stops
   * too rather than dealing the moment a seat fills mid-break.
   */
  pauseForMaintenance(maxWaitMs: number): void {
    this.maintenancePaused = true;
    this.holdBeforeNextHand = true;
    // 2026-09-04 (audit item 2): the break is the restart. Persist the
    // presence FSM now, and again when the loop actually parks (a seat can
    // drop between the announcement and the park). Fire-and-forget: the
    // break must not wait on a write.
    void this.persistPresenceForRestart('announced');
    if (maxWaitMs > 0) {
      // Take the LONGER of the two budgets. A hand-for-hand pause armed a
      // moment ago must not shorten the break's safety window.
      this.pauseMaxWaitMs = Math.max(this.pauseMaxWaitMs ?? 0, maxWaitMs);
    }
    if (this.pausedSinceMs === 0) this.pausedSinceMs = Date.now();
  }

  /**
   * Stop before the next hand so a unanimous final-table deal is priced from
   * a fully settled stack snapshot. The caller must wait for
   * `isParkedForFinalTableDeal()` before moving money.
   */
  pauseForFinalTableDeal(maxWaitMs: number): void {
    this.finalTableDealPaused = true;
    this.holdBeforeNextHand = true;
    if (maxWaitMs > 0) {
      this.pauseMaxWaitMs = Math.max(this.pauseMaxWaitMs ?? 0, maxWaitMs);
    }
    if (this.pausedSinceMs === 0) this.pausedSinceMs = Date.now();
  }

  /** Register the one hand whose durable stack boundary is about to begin. */
  protected beginTerminalBoundaryPersistence(): number {
    if (
      !this.terminalCloseoutPaused &&
      this.terminalBoundaryPendingGenerations.size === 0 &&
      !this.hasSettlementInFlight()
    ) {
      this.terminalBoundaryPersistenceFailed = false;
    }
    const generation = ++this.terminalBoundaryPersistenceGeneration;
    this.terminalBoundaryPendingGenerations.add(generation);
    this.notifyBoundaryPauseWaiters();
    return generation;
  }

  /** Resolve exactly the generation opened immediately before HandController.start. */
  protected finishTerminalBoundaryPersistence(generation: number, succeeded: boolean): void {
    if (!this.terminalBoundaryPendingGenerations.delete(generation)) return;
    if (!succeeded) this.terminalBoundaryPersistenceFailed = true;
    this.notifyBoundaryPauseWaiters();
  }

  /** Wake every closeout waiter after a relevant lifecycle edge. */
  private notifyBoundaryPauseWaiters(): void {
    const registered = this.boundaryPauseWaiters;
    if (!registered || registered.size === 0) return;
    const waiters = [...registered];
    registered.clear();
    for (const wake of waiters) wake();
  }

  /**
   * Install an irreversible-until-explicit-release next-hand fence and wait
   * until the table is physically inside that fence with every accepted hand
   * writer drained.  Timeout returns false but deliberately leaves the fence
   * armed; elapsed wall time is never authority to start another hand.
   */
  async parkForTerminalCloseout(maxWaitMs: number): Promise<boolean> {
    this.terminalCloseoutPaused = true;
    this.holdBeforeNextHand = true;
    if (this.pausedSinceMs === 0) this.pausedSinceMs = Date.now();
    this.notifyBoundaryPauseWaiters();

    const deadline = Date.now() + Math.max(0, maxWaitMs);
    for (;;) {
      if (!this.running || this.terminalBoundaryPersistenceFailed) return false;
      if (
        this.handForHandResolve !== null &&
        this.isBetweenHands() &&
        this.terminalBoundaryPendingGenerations.size === 0 &&
        !this.hasSettlementInFlight() &&
        this.postHandTasksPromise === null
      ) {
        return true;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        let finished = false;
        const wake = (): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          this.boundaryPauseWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        (timer as { unref?: () => void }).unref?.();
        this.boundaryPauseWaiters.add(wake);
      });
    }
  }

  /**
   * Fence this exact source engine before a tournament player is moved.
   *
   * A caller may wait only a small slice of its shared scheduler budget.  If
   * the current hand needs longer, the owner remains armed and the next
   * deterministic tournament sweep claims the already-parked boundary.  The
   * fence becomes time-bounded only AFTER the engine is physically parked;
   * this guarantees a long legitimate hand cannot outrun the request while a
   * stale planner can never leave a healthy table parked forever.
   */
  async parkForTournamentMove(ownerId: string, maxWaitMs: number): Promise<boolean> {
    if (!ownerId) return false;
    // Recovery may have stopped and fully drained this exact generation while
    // an earlier lost response remains unresolved. Its claimed owner survives
    // teardown, and the stopped object is then a safe quarantine for replay:
    // it cannot deal, owns no process scheduler, and still proves the UUID's
    // source generation. No new owner may be created on a stopped engine.
    if (!this.running) {
      return (
        this.claimedTournamentMovePauseOwners.has(ownerId) &&
        this.terminal &&
        this.hasReleasedProcessOwnership() &&
        this.tournamentMoveOperations.size === 0 &&
        !this.hasSettlementInFlight() &&
        this.postHandTasksPromise === null
      );
    }
    this.tournamentMovePauseOwners.add(ownerId);
    this.holdBeforeNextHand = true;
    if (this.pausedSinceMs === 0) this.pausedSinceMs = Date.now();
    this.notifyBoundaryPauseWaiters();

    const deadline = Date.now() + Math.max(0, maxWaitMs);
    for (;;) {
      if (!this.running || this.terminalBoundaryPersistenceFailed) {
        this.releaseTournamentMovePause(ownerId);
        return false;
      }
      if (
        this.tournamentMovePauseOwners.has(ownerId) &&
        this.handForHandResolve !== null &&
        this.isBetweenHands() &&
        this.terminalBoundaryPendingGenerations.size === 0 &&
        !this.hasSettlementInFlight() &&
        this.postHandTasksPromise === null
      ) {
        this.claimedTournamentMovePauseOwners.add(ownerId);
        const expiry = this.tournamentMovePauseExpiryTimers.get(ownerId);
        if (expiry) clearTimeout(expiry);
        this.tournamentMovePauseExpiryTimers.delete(ownerId);
        return true;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        let finished = false;
        const wake = (): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          this.boundaryPauseWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        (timer as { unref?: () => void }).unref?.();
        this.boundaryPauseWaiters.add(wake);
      });
    }
  }

  /** Release only the tournament-move owner named by the caller. */
  releaseTournamentMovePause(ownerId: string): void {
    // An early or duplicate release may not erase the physical fence beneath
    // an RPC that still owns this source. The awaited caller must release again
    // after executeTournamentMoveAtBoundary has removed its exact barrier.
    if (this.tournamentMoveOperationByOwner.has(ownerId)) return;
    this.tournamentMovePauseOwners.delete(ownerId);
    this.claimedTournamentMovePauseOwners.delete(ownerId);
    const expiry = this.tournamentMovePauseExpiryTimers.get(ownerId);
    if (expiry) clearTimeout(expiry);
    this.tournamentMovePauseExpiryTimers.delete(ownerId);
    this.notifyBoundaryPauseWaiters();
    if (
      this.tournamentMovePauseOwners.size > 0 ||
      this.handForHandPaused ||
      this.maintenancePaused ||
      this.finalTableDealPaused ||
      this.terminalCloseoutPaused
    )
      return;
    this.releasePauseGate();
  }

  /** Start the stale-planner deadline only after the source is truly parked. */
  private armUnclaimedTournamentMovePauseExpiry(): void {
    for (const ownerId of this.tournamentMovePauseOwners) {
      if (
        this.claimedTournamentMovePauseOwners.has(ownerId) ||
        this.tournamentMovePauseExpiryTimers.has(ownerId)
      )
        continue;
      const timer = setTimeout(() => {
        if (!this.claimedTournamentMovePauseOwners.has(ownerId)) {
          this.releaseTournamentMovePause(ownerId);
        }
      }, ServerTableEngineBase.TOURNAMENT_MOVE_UNCLAIMED_PARK_MS);
      (timer as { unref?: () => void }).unref?.();
      this.tournamentMovePauseExpiryTimers.set(ownerId, timer);
    }
  }

  /** Engine teardown owns every local pause timer and waiter. */
  private clearUnclaimedTournamentMovePauses(): void {
    for (const timer of this.tournamentMovePauseExpiryTimers.values()) clearTimeout(timer);
    this.tournamentMovePauseExpiryTimers.clear();
    for (const ownerId of [...this.tournamentMovePauseOwners]) {
      if (!this.claimedTournamentMovePauseOwners.has(ownerId)) {
        this.tournamentMovePauseOwners.delete(ownerId);
      }
    }
  }

  /**
   * Run the one source-seat RPC inside a claimed physical boundary.  The
   * non-rejecting barrier is process ownership: engine replacement and stop()
   * must join it before another dealer generation can start on this table.
   */
  async executeTournamentMoveAtBoundary<T>(
    ownerId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const stoppedQuarantine =
      !this.running &&
      this.terminal &&
      this.hasReleasedProcessOwnership() &&
      this.tournamentMoveOperations.size === 0 &&
      !this.hasSettlementInFlight() &&
      this.postHandTasksPromise === null;
    const livePhysicalBoundary =
      this.running &&
      this.handForHandResolve !== null &&
      this.isBetweenHands() &&
      this.terminalBoundaryPendingGenerations.size === 0 &&
      !this.hasSettlementInFlight() &&
      this.postHandTasksPromise === null;
    if (
      !this.claimedTournamentMovePauseOwners.has(ownerId) ||
      (!livePhysicalBoundary && !stoppedQuarantine)
    ) {
      throw new Error('tournament move source boundary is not physically owned');
    }

    if (this.tournamentMoveOperationByOwner.has(ownerId)) {
      throw new Error('tournament move source owner already has an operation in flight');
    }

    const result = operation();
    const barrier = result.then(
      () => undefined,
      () => undefined
    );
    this.tournamentMoveOperations.add(barrier);
    this.tournamentMoveOperationByOwner.set(ownerId, barrier);
    this.notifyBoundaryPauseWaiters();
    try {
      return await result;
    } finally {
      this.tournamentMoveOperations.delete(barrier);
      if (this.tournamentMoveOperationByOwner.get(ownerId) === barrier) {
        this.tournamentMoveOperationByOwner.delete(ownerId);
      }
      this.notifyBoundaryPauseWaiters();
    }
  }

  /** A replacement dealer may not cross an unresolved move outcome. */
  hasClaimedTournamentMoveBoundary(): boolean {
    return this.claimedTournamentMovePauseOwners.size > 0 || this.tournamentMoveOperations.size > 0;
  }

  /** Only a proven pre-commit refusal may call this terminal release. */
  releaseTerminalCloseoutPause(): void {
    this.terminalCloseoutPaused = false;
    this.notifyBoundaryPauseWaiters();
    if (
      this.tournamentMovePauseOwners.size > 0 ||
      this.handForHandPaused ||
      this.maintenancePaused ||
      this.finalTableDealPaused
    )
      return;
    this.releasePauseGate();
  }

  /** Owners that forbid opening the next hand, including an operator hold. */
  protected isNextHandPaused(): boolean {
    return (
      this.adminPauseLock ||
      this.maintenanceLock ||
      this.maintenancePaused ||
      this.finalTableDealPaused ||
      this.terminalCloseoutPaused ||
      this.tournamentMovePauseOwners.size > 0 ||
      (this.handForHandPaused && this.holdBeforeNextHand)
    );
  }

  /** Drop an unstarted controller without a table, seat, stack or wallet write. */
  protected discardPreparedHandForPause(): boolean {
    if (!this.isNextHandPaused()) return false;
    this.handController = null;
    this.currentHandDealtStacks.clear();
    if (this.handSpan) {
      try {
        this.handSpan.end();
      } catch {
        // Tracing can never keep a terminal boundary open.
      }
      this.handSpan = null;
    }
    this.shadowRecorder = null;
    this.terminalCloseoutDiscardedPreparedHand = true;
    this.notifyBoundaryPauseWaiters();
    return true;
  }

  /**
   * Write this table's presence FSM to engine_presence_parked so the next
   * boot (loadPresenceFromPark in start()) continues it rather than
   * resetting it. Called when the break is announced and when the loop
   * parks. Never throws; a miss costs exactly what every boot cost before.
   */
  protected async persistPresenceForRestart(when: 'announced' | 'parked'): Promise<void> {
    try {
      const states = this.disconnectEngine.getFsmStatesForTable(this.tableId);
      if (Object.keys(states).length === 0) return;
      await savePresenceAtPark({
        tableId: this.tableId,
        disconnectStates: states,
        engineInstance: `${INSTANCE_ID}:${when}`,
      });
    } catch (err) {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.presence_persist');
    }
  }

  /**
   * Send this player the engine's current pre-action (or its absence) as a
   * private frame. Called on every PreActionEngine event and on RESYNC.
   */
  protected pushPreActionToPlayer(userId: string, extra?: { reason: string }): void {
    if (!this.hub || !userId) return;
    const entry = this.preActionEngine.getPreAction(this.tableId, userId);
    this.hub.sendToUser(this.tableId, userId, {
      kind: 'pre_action',
      hand_number: this.handCount,
      action: entry?.action ?? null,
      to_call_at_set: entry?.toCallAtSet ?? null,
      ...(extra ?? {}),
    });
  }

  /** RESYNC / reconnect: re-send the engine's pre-action for this player. */
  public rePushPreAction(userId: string): void {
    // Authoritative: a reconnecting bar takes the engine's copy as it stands,
    // armed or not. The reason lets the client tell this "nothing armed" from
    // one it should hold through an execution beat.
    this.pushPreActionToPlayer(userId, { reason: 'resync' });
  }

  /** Lift the maintenance break. Leaves any hand-for-hand pause in place. */
  resumeFromMaintenance(): void {
    this.maintenancePaused = false;
    if (
      this.tournamentMovePauseOwners.size > 0 ||
      this.handForHandPaused ||
      this.finalTableDealPaused ||
      this.terminalCloseoutPaused
    )
      return;
    this.releasePauseGate();
  }

  /** Lift only the final-table-deal authority. Other pause owners remain. */
  resumeFromFinalTableDeal(): void {
    this.finalTableDealPaused = false;
    if (
      this.tournamentMovePauseOwners.size > 0 ||
      this.handForHandPaused ||
      this.maintenancePaused ||
      this.terminalCloseoutPaused
    )
      return;
    this.releasePauseGate();
  }

  /**
   * True only after the deal authority has actually parked this running
   * engine between hands. Merely observing `handController === null` is not
   * enough because the dealing loop may already be opening the next hand.
   */
  isParkedForFinalTableDeal(): boolean {
    return (
      this.running &&
      this.finalTableDealPaused &&
      this.handForHandResolve !== null &&
      !this.hasSettlementInFlight() &&
      this.isBetweenHands()
    );
  }

  /** True while the scheduled maintenance break is holding this table. */
  isMaintenancePaused(): boolean {
    return this.maintenancePaused;
  }

  /**
   * Is this table stopped where stopping it is safe — between hands?
   *
   * `isWaitingForHandForHand()` is nearly this, and was the first thing the
   * maintenance break's restart gate used, but it is true only for a table
   * that reached the gate from the DEALING loop. A table below
   * minPlayersToDeal sits in the start-up wait loop instead and now parks
   * there too, so the gate needs a test that accepts both. Without this the
   * restart gate never opened at all on a fleet with any quiet table on it.
   */
  isParkedBetweenHands(): boolean {
    return this.handForHandResolve !== null || !this.running;
  }

  /** Shared by both resume paths: wake the loop sitting on the gate. */
  private releasePauseGate(): void {
    /**
     * ── THE PROGRESS CLOCK IS THAWED, NOT BURNED (2026-09-05) ──────────────
     *
     * CLAUDE.md §13 rule 4: "Deadlines are thawed, not burned. If you add a
     * wall-clock deadline a player can lose to, add it to fn_thaw_platform in
     * the same PR, or a five-minute break silently eats it."
     *
     * `lastProgressAtMs` is exactly such a deadline and it was never thawed.
     * It keeps running while a table is deliberately parked, so at :00 every
     * table on the fleet stops being `paused` — which is what excludes it from
     * the stall predicate — and reappears already carrying the whole break as
     * "no progress". Not a climb; a jump, from invisible to five minutes stale
     * in one tick.
     *
     * MEASURED over 24 hours on 2026-09-05, from Prometheus:
     *
     *   the twelve largest stall spikes ALL fell between HH:00:07 and HH:00:37
     *   peak 120 tables at 18:00:22, the instant poker_paused_tables went 343 -> 0
     *   49.5% of ALL stalled table-seconds in the day sat in minute :00
     *   55.4% in :00-:03
     *   first-observed stall values cluster hard at 433-446s - one break plus
     *     the in-break restart, arriving whole
     *
     * Downstream that lie was expensive: it fed `poker_stalled_tables`, and
     * through it `liveness`, and sp-autoheal restarted production five times
     * in one day on the strength of it. Fixing the liveness rule stopped the
     * restarts (see engineLiveness.test.ts); this stops the false reading that
     * caused them.
     *
     * It belongs HERE rather than in either caller because both resume paths -
     * `resumeFromMaintenance()` and `resumeDealing()` - funnel through this
     * gate, so one line covers the maintenance break and hand-for-hand alike,
     * and any third pause authority added later inherits it for free.
     *
     * This is not "hiding" a stall. The table has been parked ON PURPOSE and
     * every second of that is already published as `poker_paused_tables`. The
     * clock measures time a table should have been dealing and was not; time
     * it was told not to deal is not that.
     */
    this.markProgress();
    this.pausedSinceMs = 0;
    this.lastPauseAlarmAtMs = 0;
    this.pauseMaxWaitMs = null;
    this.pauseRequiresExplicitResume = false;
    this.holdBeforeNextHand = false;
    // Bible V8 §3.1: Table FSM — paused → running
    if (this.tableFSM.state === 'paused' && !this.adminPauseLock && !this.maintenanceLock) {
      this.tableFSM.transition('running');
    }
    this.releasePendingPauseWait();
  }

  /** Resolve one parked dealing loop and retire its now-obsolete timeout. */
  private releasePendingPauseWait(): void {
    if (this.pauseGateTimer) {
      clearTimeout(this.pauseGateTimer);
      this.pauseGateTimer = null;
    }
    if (!this.handForHandResolve) return;
    const resolve = this.handForHandResolve;
    this.handForHandResolve = null;
    resolve();
  }

  /** Resume dealing (all tables finished their hand-for-hand hand) */
  resumeDealing(): void {
    this.handForHandPaused = false;
    // THE MAINTENANCE BREAK OUTRANKS HAND-FOR-HAND HERE. Hand-for-hand's
    // 500ms sync loop calls this the moment every table is waiting, which
    // during a break is immediately — and without this line it would deal a
    // hand inside the break and destroy the break's pause budget on the way
    // through. See the `maintenancePaused` field.
    if (
      this.tournamentMovePauseOwners.size > 0 ||
      this.maintenancePaused ||
      this.finalTableDealPaused ||
      this.terminalCloseoutPaused
    ) {
      this.pausedSinceMs = this.pausedSinceMs || Date.now();
      return;
    }
    // Drops the extended pause budget granted for a break, so the next
    // hand-for-hand pause gets its own short safety window rather than
    // inheriting a multi-minute one.
    this.releasePauseGate();
  }

  /** Check if engine is currently waiting for hand-for-hand resume */
  isWaitingForHandForHand(): boolean {
    return this.handForHandPaused && this.handForHandResolve !== null;
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════
   *  THE PARK. A PAUSED TABLE STOPS, WHATEVER IT WAS DOING (2026-08-27)
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * Dan: "AT THE :55 BREAK HAS STARTED, AND ALL HANDS FINISH. ONCE A TABLE HAS
   * FINISHED THE HAND, THEY STOP, AND DON'T RESTART UNTIL THE BREAK IS OVER."
   *
   * This block used to live INLINE in the dealing loop, immediately after
   * `await this.dealHand(...)`. That is the one place in the loop a table only
   * reaches when it actually dealt a hand, and every branch above it exits the
   * iteration with `continue`:
   *
   *   - `activePlayers.length < minPlayersToDeal()`  (sleep 3s, continue)
   *   - the spin-reveal hold                          (sleep <=1s, continue)
   *   - the mystery-bounty reveal gate                (sleep 250ms, continue)
   *   - the admin-pause / maintenance lock            (sleep 3s, continue)
   *
   * and the start-up wait loop hands control to the dealing loop without
   * passing it at all. So a table that was NOT mid-hand at :55 — one short a
   * player while the balancer moves somebody in, one holding for a spin wheel,
   * one that just filled — never parked. Two things followed, both wrong:
   *
   *   1. `isWaitingForHandForHand()` stayed false, so `areAllTablesParked()`
   *      was false, so the platform burned the whole LAST_HAND_GRACE_MS every
   *      single hour and logged "last hand did not land within 120s" for a
   *      table that had no hand in the air at all. Every break started two
   *      minutes late and ran two minutes past the hour.
   *
   *   2. Far worse: the instant that table got its players back — a balanced
   *      seat arriving, a wheel finishing — it went straight to `dealHand()`
   *      and played a full hand IN THE MIDDLE OF THE BREAK, only parking
   *      afterwards. That is precisely the thing the break exists to prevent.
   *
   * The gate is now a method and the loop awaits it at the TOP of every
   * iteration, before any of those branches and before the deal. A table with
   * cards in the air still finishes its hand first, because the loop cannot
   * come back around until `dealHand()` resolves — "all hands finish" and "no
   * new hand starts" are the same single check from here.
   *
   * The post-deal call site is retained so hand-for-hand still parks the
   * instant a hand settles rather than after the showdown display pause.
   */
  protected async awaitPauseGate(): Promise<void> {
    // Either authority holds the gate; see the `maintenancePaused` field.
    if (
      (!this.handForHandPaused &&
        !this.maintenancePaused &&
        !this.finalTableDealPaused &&
        !this.terminalCloseoutPaused &&
        this.tournamentMovePauseOwners.size === 0) ||
      !this.running
    )
      return;
    // Bible V8 §3.1: Table FSM — running → paused. GUARDED: the FSM has no
    // waiting → paused edge, and this gate is now reachable from the idle
    // branches where the table sits in 'waiting'. An unguarded transition
    // logged a false "Invalid transition" to Sentry on every idle park.
    if (this.tableFSM.state === 'running') {
      this.tableFSM.transition('paused');
    }
    console.log(
      `[ServerTableEngine:${this.tableId}] Parked between hands - waiting for the pause to lift...`
    );
    await new Promise<void>((resolve) => {
      this.handForHandResolve = resolve;
      this.armUnclaimedTournamentMovePauseExpiry();
      this.notifyBoundaryPauseWaiters();
      /**
       * Safety timeout so a table can never wedge forever.
       *
       * Dan 2026-08-19: this was hard-coded to 120 seconds. A synchronized
       * break is five minutes measured from AFTER the last hand completes, so
       * every table silently self-resumed two minutes in and dealt through the
       * rest of the break. The budget now comes from whoever requested the
       * pause (pauseAfterHand), defaulting to the original two minutes for
       * hand-for-hand.
       */
      const maxWaitMs = this.pauseMaxWaitMs ?? 120000;
      this.pauseGateTimer = setTimeout(() => {
        if (this.handForHandResolve === resolve) {
          if (
            this.pauseRequiresExplicitResume ||
            this.terminalCloseoutPaused ||
            this.claimedTournamentMovePauseOwners.size > 0
          ) {
            // A synchronized break can outlast its initial drain estimate.
            // Only its manager can release that pause after all hands finish.
            // Terminal closeout is fail-closed. Its caller has its own bounded
            // wait, but this table stays fenced until that caller explicitly
            // proves the transaction did not commit and releases it.
            this.pauseGateTimer = null;
            return;
          }
          console.warn(
            `[ServerTableEngine:${this.tableId}] Pause safety timeout after ${Math.round(
              maxWaitMs / 1000
            )}s - resuming to avoid a wedged table`
          );
          this.pauseGateTimer = null;
          this.handForHandResolve = null;
          resolve();
        }
      }, maxWaitMs);
      // The break is minutes long and this timer is the only thing keeping a
      // reference; unref so a shutdown inside a break is not held open by it.
      (this.pauseGateTimer as { unref?: () => void }).unref?.();

      // Notify only after the wait authority and its escape deadline exist.
      // The manager may synchronously release the barrier when this is the
      // final table to park, so publishing before either line above would
      // create a lost-resume race.
      try {
        this.pauseReadyCallback?.(this.tableId);
      } catch (error) {
        reportError(error, 'ServerTableEngine.pause_ready_callback_failed', {
          tableId: this.tableId,
        });
      }
    });
  }

  /**
   * C19: is this table at a point where stopping it destroys nothing?
   *
   * True when the engine is already stopped, or when it has parked at the
   * hand-for-hand gate — which the deal loop only reaches BETWEEN hands. A
   * table that is drained has no cards in the air, no pot mid-settlement and
   * no player owed an action, so a shutdown can take it without abandoning a
   * hand.
   *
   * Deliberately public and deliberately narrow: `handController === null` is
   * nearly the same test, but it is briefly true during setup as well, and a
   * drain must not mistake "not started yet" for "finished cleanly".
   */
  isDrained(): boolean {
    return (
      !this.hasSettlementInFlight() &&
      this.postHandTasksPromise === null &&
      (!this.running || this.isWaitingForHandForHand())
    );
  }

  /**
   * Are there no cards in the air at this table right now?
   *
   * The mystery bounty phase may only open BETWEEN hands (Dan's sections 1-3):
   * a player who committed his stack while a knockout was worth a flat bounty
   * must not find, when the hand is scored, that it was worth a chest. That is
   * the information changing under a decision already made.
   *
   * `handController === null` is the whole test. It is also briefly true during
   * setup, before the first hand — which is harmless here and deliberately not
   * excluded: seeding a chest inventory before any hand has been dealt is the
   * safest moment there is, whereas `isDrained()` (which does exclude it) would
   * report a running table as busy forever and the phase would never open.
   */
  isBetweenHands(): boolean {
    return this.handController === null;
  }

  /**
   * True while this table is stopped ON PURPOSE (hand-for-hand pause, or the
   * table FSM parked in 'paused'). The watchdog and the /health stall
   * detector must treat this as healthy: before this existed, a hand-for-hand
   * pause longer than the stall window read as a frozen table — the engine
   * killed and rebuilt it (losing the pause, so it dealt into hand-for-hand),
   * and /health flipped liveness to 'dead', which after three failed Docker
   * health probes restarted the ENTIRE engine over one legitimately paused
   * final-table bubble.
   */
  isPausedByDesign(): boolean {
    // THE MAINTENANCE BREAK IS A PAUSE BY DESIGN, AND FORGETTING THAT DEALT
    // 1204 HANDS INSIDE ONE (2026-09-02).
    //
    // #2537 split the break out of `pauseAfterHand` into its own authority so
    // hand-for-hand could not lift it. `pauseAfterHand` sets
    // `handForHandPaused`, which is what this predicate reads;
    // `pauseForMaintenance` deliberately does not. So the new authority was
    // wired into the new gate in the start-up loop and into nothing else, and
    // this predicate - the one the TURN loop actually consults
    // (ServerTableEngineTurns) - kept answering false all the way through a
    // break.
    //
    // Measured on the first armed break, 18:55-19:00: 1204 hands dealt,
    // against 0 in each of the two breaks on the build before it and 1299 in a
    // normal five minutes. The break had stopped stopping play.
    //
    // It also explains the hourly `watchdog_kill_rebuild` wave (#2651):
    // GameServer's `parkedOnPurpose` is this same predicate, so every table
    // held by a break looked like a stalled table to the watchdog, which
    // killed and rebuilt it.
    //
    // A table the maintenance break is holding is paused on purpose. That is
    // the whole meaning of this function, so it belongs here rather than at
    // each of the four call sites.
    //
    // ── A DEAL HOLD IS A PAUSE BY DESIGN TOO (2026-09-05) ────────────────
    //
    // `dealHoldUntilMs` is the third authority that stops a table on purpose,
    // and it was the only one this predicate did not know about. It is what
    // holds the first deal under a Spin reveal, and what holds a seat-first
    // tournament table between its seats selling and its advertised start.
    //
    // MEASURED on the live fleet, table row created -> tournament start_time:
    //   96e2d84f (5 Chip Spin PLO5)        2287s
    //   eadb2242 (NLH Heads-Up 50)         2212s
    //   d3b1c215 (50 Chip Deep Stack Spin) 3078s
    //
    // Through every one of those windows the table has two or more dealable
    // seats, is not `paused`, and its progress clock is running - so it reads
    // as stalled for up to fifty-one minutes while doing exactly what it was
    // told. A live poll of two such tables caught 56 stalled samples, and all
    // 56 had a dealing loop that had moved within the last two seconds. Not
    // one was wedged. That population is the whole of the long tail behind
    // "modal stalled count of 1", and it is the reason a third of the fleet's
    // tables logged at least one stall in twelve hours.
    //
    // Held, not broken - the same distinction the rest of this function
    // exists to make. The hold has a published deadline; when it expires the
    // table deals or it becomes a genuine stall, and either way the answer
    // arrives on its own.
    return (
      this.handForHandPaused ||
      this.maintenancePaused ||
      this.finalTableDealPaused ||
      this.terminalCloseoutPaused ||
      (this.tournamentMovePauseOwners.size > 0 && this.handForHandResolve !== null) ||
      this.dealHoldUntilMs > Date.now() ||
      this.tableFSM.state === 'paused'
    );
  }

  /**
   * A by-design pause that has TAKEN EFFECT - the question the table watchdog
   * and GameServer's zombie reaper ask before they stand down (2026-09-11).
   *
   * isPausedByDesign() goes true the moment an authority raises its flag, and
   * for what it was written for that is right: a parked table is not a stall.
   * But almost every authority is a "stop at the next hand boundary" fence,
   * raised on tables still playing a hand: the maintenance break at :53
   * (maintenancePaused, on EVERY table), the tournament's own synchronized
   * break at :55 and hand-for-hand (pauseAfterHand -> handForHandPaused, on
   * every table of the event), and a deal hold. None of them stops the turn
   * clock. Until the hand lands the table is PLAYING, and a hand that froze is
   * exactly as dead under one of those flags as without it.
   *
   * Both readers took the flag for the fact. The watchdog stood down for every
   * table still mid-hand when a flag went up, so a hand that lost its clock in
   * the last-hand window could not be rescued; the reaper exempted it for
   * MAX_HEALTHY_PAUSE_MS - ten minutes, longer than the whole break - so it
   * could not be reaped either. It never parked, and one table that never
   * parks keeps readyForRestart shut. On 2026-09-11 build 404948b3 froze
   * tournament tables mid-hand (#4225) and held 514, 526 and 523 of them
   * unparked through three countdowns: no certificate, no restart, and no way
   * for the fix to ship without an owner-approved exception.
   *
   * So: between hands every authority means what it says. Mid-hand, only a
   * fence a REBUILD WOULD LOSE still holds the table - the final-table deal,
   * the terminal closeout and an FSM 'paused' lock live on this engine alone.
   * The others survive a rebuild: MaintenanceBreak.adopt() parks every engine
   * created during the break, and TournamentManagerBase.
   * prepareManagedTableEngineForPlay() re-applies the tournament break, the
   * add-on break and hand-for-hand to a replacement before admitting it. So a
   * frozen hand under them is worked by the watchdog and reaped on its usual
   * clock, and its replacement arrives parked - the certificate is earned,
   * not waived.
   *
   * (First draft counted every non-maintenance authority at once, mid-hand
   * too. Review caught it: the :55 tournament break raises handForHandPaused
   * on every MTT table, so from :55 - the only minutes readyForRestart can
   * open - the draft shielded a frozen MTT hand again.)
   */
  isParkedByDesign(): boolean {
    if (this.isBetweenHands()) return this.isPausedByDesign();
    return (
      this.finalTableDealPaused || this.terminalCloseoutPaused || this.tableFSM.state === 'paused'
    );
  }

  /** Ms spent in the current by-design pause; 0 when not paused. */
  msPaused(): number {
    return this.pausedSinceMs === 0 ? 0 : Date.now() - this.pausedSinceMs;
  }

  /**
   * VIP time banks 2026-08-17: batch-fetch each player's EXTRA seconds
   * (VIP monthly remaining + purchased extensions) on top of the free
   * session base. Fail-open to base-only: an allowance outage must never
   * block dealing.
   */
  protected async fetchTimeBankExtras(userIds: string[]): Promise<Map<string, number>> {
    const extras = new Map<string, number>();
    if (userIds.length === 0) return extras;
    try {
      const { data, error } = await supabase.rpc('fn_time_bank_allowance', {
        p_user_ids: userIds,
      });
      if (error) throw new Error(error.message);
      for (const row of (data as Array<{ user_id: string; extra_seconds: number }>) ?? []) {
        extras.set(row.user_id, Math.max(0, Number(row.extra_seconds) || 0));
      }
    } catch (err) {
      reportError(err, 'TimeBank.allowance_fetch_failed');
    }
    return extras;
  }

  /**
   * VIP time banks 2026-08-17: commit DB-backed consumption when a time
   * bank use finishes (player acted, expired, or depleted). The free
   * session base is spent first; only the excess hits the DB. Best-effort:
   * accounting must never break gameplay.
   */
  private onTimeBankAccounting(event: TimeBankEvent): void {
    if (
      event.type !== 'TIME_BANK_STOPPED' &&
      event.type !== 'TIME_BANK_EXPIRED' &&
      event.type !== 'TIME_BANK_DEPLETED'
    ) {
      return;
    }
    try {
      const meta = this.timeBankMeta.get(event.playerId);
      if (!meta) return;
      const remaining = this.timeBankEngine.getRemainingSeconds(this.tableId, event.playerId);
      const usedTotal = Math.max(0, meta.initialSeconds - remaining);
      const owed = Math.max(0, usedTotal - meta.baseSeconds) - meta.dbConsumedSeconds;
      if (owed <= 0) return;
      meta.dbConsumedSeconds += owed;
      // Promise.resolve() so this is a real Promise with a .catch(), not the
      // PromiseLike the query builder returns. The enclosing try/catch below
      // covers only the SYNCHRONOUS part of this statement — see the note on
      // recordRecoveryEvent() for why the rejection path matters.
      void Promise.resolve(
        supabase.rpc('fn_consume_time_bank', { p_user_id: event.playerId, p_seconds: owed })
      )
        .then(({ error }) => {
          if (error) console.warn('[TimeBank] consume failed:', error.message);
        })
        .catch((err: unknown) => {
          console.warn('[TimeBank] consume threw:', (err as Error)?.message ?? err);
        });
    } catch {
      /* accounting must never break gameplay */
    }
  }

  /**
   * VIP time banks 2026-08-17: mid-session refresh. A diamond top-up (or
   * VIP renewal) after session init lives only in the DB - rebase the
   * in-memory bank to base-residue + fresh DB extras so the purchase is
   * usable without re-seating. Returns false if nothing could be refreshed.
   */
  protected async refreshTimeBankFromDb(userId: string): Promise<boolean> {
    const meta = this.timeBankMeta.get(userId);
    const bank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
    if (!meta || !bank || bank.isActive) return false;
    const extras = await this.fetchTimeBankExtras([userId]);
    if (!extras.has(userId)) return false;
    const usedTotal = Math.max(0, meta.initialSeconds - bank.remainingSeconds);
    const baseLeft = Math.max(0, meta.baseSeconds - Math.min(usedTotal, meta.baseSeconds));
    const newRemaining = baseLeft + (extras.get(userId) ?? 0);
    if (!this.timeBankEngine.rebase(this.tableId, userId, newRemaining)) return false;
    this.timeBankMeta.set(userId, {
      initialSeconds: newRemaining,
      baseSeconds: baseLeft,
      dbConsumedSeconds: 0,
    });
    return true;
  }

  /**
   * Durable, DB-visible record of an automatic recovery action. Best-effort
   * by design: recovery must never depend on the insert succeeding.
   *
   * 2026-08-18 — WHY THE .catch() BELOW IS LOAD-BEARING
   * `try { void p.then(...) } catch {}` does NOT make a promise safe. The
   * try/catch guards only the synchronous call that builds the chain; once the
   * statement returns, a rejection has nowhere to go and becomes an unhandled
   * rejection on the process.
   *
   * `.then(({ error }) => ...)` handles the RESOLVED-with-error case, which is
   * what supabase-js returns for most failures — that is why this looked
   * covered. It is not: a transport-level failure (DNS, socket reset, abort)
   * rejects instead, and under the test runner such a rejection is attributed
   * to whichever test happens to be executing when it lands. That is exactly
   * what made `CryptoRandom > is uniform over a range that does not divide
   * 2^32` fail intermittently in full-suite runs while passing in isolation.
   * The generator was never at fault: 160 trials / 11.2M draws produced a max
   * chi-square of 15.07 against a 22.46 threshold, with zero exceedances.
   */
  protected recordRecoveryEvent(
    event: string,
    detail: string,
    recoveryEventClass?: EngineRecoveryEventClass
  ): void {
    const eventClass =
      recoveryEventClass ?? this.pendingRecoveryEventClass ?? AUTOMATIC_RECOVERY_EVENT_CLASS;
    // Unit and law probes may run in shells that carry production credentials.
    // A test process is not an engine and must never write production
    // telemetry. This source fence is stronger than relying on every test to
    // remember to mock a shared service-role client.
    if (process.env.VITEST) return;

    try {
      void Promise.resolve(
        supabase.from('engine_recovery_events').insert({
          table_id: this.tableId,
          event,
          detail: detail.slice(0, 500),
          hand_count: this.handsDealtThisSession,
          event_class: eventClass,
        })
      )
        .then(({ error }) => {
          if (error) console.warn('[RecoveryEvent] insert failed:', error.message);
        })
        .catch((err: unknown) => {
          console.warn('[RecoveryEvent] insert threw:', (err as Error)?.message ?? err);
        });
    } catch {
      /* never let telemetry break recovery */
    }
  }

  /**
   * Which FORMAT this table is, for metrics. Dan, 2026-09-05: "you need to fix
   * the real time connection to the spins, heads up and mtt's as well. not
   * just the cash game tables."
   *
   * Every format already shares one ServerTableEngine and one table socket, so
   * the act-to-broadcast instrument covered them from the start - but it was
   * labelled only by audience, so a Spin's latency, an MTT final table's and a
   * cash table's were one indistinguishable number and nobody could answer
   * "are Spins slow?". This is the label that makes each answerable.
   *
   * Derived from the tournament brain context, which is a SYNCHRONOUS cached
   * read and already warmed for every tournament table this engine owns, so
   * this is safe on the broadcast path. A tournament whose context has not
   * landed yet reports 'mtt' rather than guessing - it is the majority shape
   * and it never silently becomes 'cash'.
   *
   * Four values, so at most eight series with the audience label. Never a
   * table_id: that is the cardinality the gated registry exists to avoid.
   */
  protected tableFormat(): 'cash' | 'spin' | 'hu_sng' | 'mtt' {
    if (!this.isTournamentTable()) return 'cash';
    try {
      const id = this.tableInfo?.tournament_id;
      const ctx = id ? peekTournamentBrainContext(String(id)) : null;
      // Phase 7 distinguishes multi-seat SNG utility from MTT utility inside
      // the horse snapshot. The table-feel metric deliberately keeps its
      // established four-value cardinality, so those SNG tables share the MTT
      // transport series rather than creating an unbounded label change.
      return ctx?.format === 'sng' ? 'mtt' : (ctx?.format ?? 'mtt');
    } catch {
      return 'mtt';
    }
  }

  protected isTournamentTable(): boolean {
    return !!(this.tableInfo?.tournament_id || this.tableInfo?.game_type === 'tournament');
  }

  /**
   * POST /addchips — Player bought chips (added to their stack).
   *
   * If a hand is in progress, chips are QUEUED and applied after the hand
   * completes in postHandTasks(). This prevents a scenario where a player
   * wins a large pot mid-hand and the add-on pushes them over the table's
   * max buy-in. The queued add-on is reduced or canceled as needed.
   *
   * If no hand is in progress, chips are applied immediately (no cap concern
   * because no pot can change the player's stack before next hand).
   */
  /** Table max buy-in (DB value or 200×BB fallback), TO THE CENT.
   *
   *  This number is the ceiling every add-on is sized against and is passed
   *  to `resolve_pending_addon` as `p_max_buy_in`, whose receipt must satisfy
   *  `applied + refunded = amount` exactly or the post-commit obligation
   *  refuses and the table stops dealing. `bb * 200` is a float product
   *  (0.07 * 200 = 14.000000000000002), and a `tables.max_buy_in` carrying a
   *  half-cent would be worse. */
  protected getMaxBuyIn(): number {
    const raw = this.tableInfo?.max_buy_in
      ? Number(this.tableInfo.max_buy_in)
      : (this.tableInfo?.big_blind || 2) * 200;
    return Number.isFinite(raw) ? Math.round(raw * 100) / 100 : 0;
  }
  protected pineappleDiscardTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * PINEAPPLE DISCARD DEADLINES, PER SEAT, ABSOLUTE (2026-08-31).
   *
   * The discard round used to be one flat `setTimeout` for the whole table and
   * nothing published about it, so the client counted down from its OWN copy of
   * action_time_seconds anchored to the moment it first saw the stage. Three
   * ways that lied: a table configured with a different action time showed the
   * wrong number; a reconnect restarted the countdown from full while the
   * server clock was half spent; and switching to the table from another tab
   * re-anchored it again. Dan was folded on a clock that read twelve seconds.
   *
   * Absolute epoch ms, per seat, published in the snapshot and enforced from
   * the same map, so what the player sees and what folds them are one number.
   * Per SEAT rather than per table because a time bank extends one player's
   * deadline without touching anybody else's.
   */
  protected pineappleDiscardDeadlines: Map<number, number> = new Map();
  /** The unextended deadline every seat started the round with. */
  protected pineappleDiscardBaseDeadlineMs: number | null = null;
  /** Round duration in ms, for the client's ring geometry. */
  protected pineappleDiscardDurationMs: number = 0;
  /**
   * Pending horse think-time timer. Tracked so it can be cancelled — a stray
   * horse action scheduled for a hand that has since ended is a real hazard
   * (the callback's identity guards catch it, but an untracked timer cannot be
   * cleared on teardown), and freeze drills need to suppress the horse action
   * to reproduce a genuine stall rather than one the horse papers over.
   */
  protected horseActionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Worker request for the current horse turn, including any V44 replay. */
  protected horseDecisionAbortController: AbortController | null = null;
  /** Delay before the current turn submits its V44 replay to the worker FIFO. */
  protected horseSecondLookTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Monotonic local fence for asynchronous horse work. A hand number and seat
   * can repeat after an engine replacement; this token cannot repeat within
   * the engine instance and is checked before any result can touch the table.
   */
  protected horseTurnToken = 0;

  /** Cancel every asynchronous unit owned by the current horse turn. */
  protected cancelHorseDecisionWork(): void {
    this.horseTurnToken += 1;
    this.horseDecisionAbortController?.abort();
    this.horseDecisionAbortController = null;
    if (this.horseSecondLookTimer) {
      clearTimeout(this.horseSecondLookTimer);
      this.horseSecondLookTimer = null;
    }
    if (this.horseActionTimer) {
      clearTimeout(this.horseActionTimer);
      this.horseActionTimer = null;
    }
  }

  /**
   * Bible V8 §2.3 — Calculate position labels for each seat (BTN, SB, BB, UTG, MP, CO, etc.)
   * Uses Appendix B position naming convention.
   */
  protected getPositionLabels(dealerSeat: number, players: SeatPlayer[]): Map<number, string> {
    const labels = new Map<number, string>();
    const seats = players.map((p) => p.seat).sort((a, b) => a - b);
    const n = seats.length;
    if (n === 0) return labels;

    // Find dealer seat index in sorted seats
    let dealerIdx = seats.indexOf(dealerSeat);
    if (dealerIdx === -1) {
      // Dealer seat not found in active players — use first seat
      dealerIdx = 0;
    }

    if (n === 2) {
      // FIX 177: Bible V8 §4.2 + Appendix B: Heads-up → dealer=BTN (is also SB), other=BB
      labels.set(seats[dealerIdx], 'BTN');
      labels.set(seats[(dealerIdx + 1) % n], 'BB');
    } else if (n === 3) {
      // AUDIT FIX 2026-07-19: 3-handed is BTN, SB, BB — the button is NOT the SB
      // (that's heads-up only). postBlinds posts SB at dealer+1 and BB at
      // dealer+2, so the previous BTN/BB/UTG labels mislabeled the SB as BB and
      // the BB as UTG on every 3-handed hand.
      labels.set(seats[dealerIdx], 'BTN');
      labels.set(seats[(dealerIdx + 1) % n], 'SB');
      labels.set(seats[(dealerIdx + 2) % n], 'BB');
    } else {
      // 4+ players — BTN, SB, BB, then positional names
      labels.set(seats[dealerIdx], 'BTN');
      labels.set(seats[(dealerIdx + 1) % n], 'SB');
      labels.set(seats[(dealerIdx + 2) % n], 'BB');

      // Bible V8 Appendix B position names
      const positionNames: Record<number, string[]> = {
        4: ['UTG'],
        5: ['UTG', 'CO'],
        6: ['UTG', 'MP', 'CO'],
        7: ['UTG', 'UTG+1', 'MP', 'CO'],
        8: ['UTG', 'UTG+1', 'MP', 'MP+1', 'CO'],
        9: ['UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO'],
      };
      const names = positionNames[n] || positionNames[9] || [];
      for (let i = 0; i < n - 3 && i < names.length; i++) {
        labels.set(seats[(dealerIdx + 3 + i) % n], names[i]);
      }
    }
    return labels;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // SEAT HELPERS
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Bible V8 §4.2: Get the BB seat for the current deal.
   * Used by wait-for-BB logic to know when a waiting player can enter.
   */
  /**
   * Predict the BB seat for the hand ABOUT to be dealt (called before dealHand
   * rotates the button). AUDIT FIX 2026-07-19: seat-based, computed from the
   * previous button seat over the same roster the deal will use — including
   * players waiting for the BB, so a waiting player's seat can be recognised as
   * the BB and they can be released. (Index-based version used the stale
   * dealerSeatIndex over a differently-filtered roster and released players on
   * the wrong hand.)
   */
  /**
   * Dan 2026-08-21, BINDING: "CASH GAME PLAYERS CAN NEVER BE DEALT INTO THE
   * SMALL BLIND. THEY MUST WAIT FOR THE BUTTON TO PASS." Same roster and
   * rotation as getBBSeatIndex, stopping one seat earlier.
   */
  protected getSBSeatIndex(): number {
    const roster = this.seatedPlayers.filter(
      (p) =>
        p.stack > 0 &&
        (this.isTournamentTable() || !this.disconnectEngine.isSittingOut(this.tableId, p.user_id))
    );
    if (roster.length < 2) return -1;
    const nextButton = this.predictButtonSeat(roster);
    return roster.length === 2 ? nextButton : this.getNextSeat(nextButton, roster);
  }

  /**
   * Dan 2026-08-25, BINDING: "NEW PLAYERS NEVER GET THE BUTTON WHEN SITTING
   * DOWN. It skips over them and moves to the correct person."
   *
   * The subset of a roster that may hold the button on the next hand: players
   * who have already been dealt at least one hand here. Returns the roster
   * UNCHANGED when nobody has played yet — a table dealing its very first hand
   * has none but new players and somebody has to take the button — so this can
   * never empty the rotation or make the caller spin.
   */
  protected buttonEligible(roster: SeatedPlayer[]): SeatedPlayer[] {
    // CASH ONLY. Dan's rule is about sitting down at a cash game. In a
    // tournament nobody "sits down": the seating sweep places late registrants
    // and TableBalancer moves players between tables deliberately, positioning
    // them relative to the big blind so the rotation stays honest. Filtering
    // those players out of the button rotation would silently override that
    // placement, and a table that has just been balanced into is mostly players
    // this set has never seen.
    if (this.isTournamentTable()) return roster;
    const veterans = roster.filter((p) => this.dealtInUserIds.has(p.user_id));
    return veterans.length > 0 ? veterans : roster;
  }

  /**
   * Where the button lands on the hand about to be dealt. ONE definition,
   * shared by the SB/BB predictors, the wait-for-BB gate and the rotation
   * itself — if these were separate walks they could disagree about who is on
   * the button, which is exactly the class of bug the shared sbSeat/bbSeat
   * computation in the dealing loop was introduced to kill.
   */
  protected predictButtonSeat(roster: SeatedPlayer[]): number {
    const eligible = this.buttonEligible(roster);
    const sortedSeats = eligible.map((p) => p.seat_number).sort((a, b) => a - b);
    if (sortedSeats.length === 0) return -1;
    if (this.lastButtonSeat > 0) {
      /**
       * HEADS-UP, THE BLINDS ADVANCE AND THE BUTTON FOLLOWS (2026-08-31,
       * Phase 3, carried from the Phase 2 audit).
       *
       * The dealing loop stopped rotating the button at two players and started
       * deriving it from the last big blind (TDA Rule 33 -- see
       * headsUpButton.ts). This predictor kept walking the old rotation, so for
       * every heads-up hand the wait-for-BB gate and the deal disagreed about
       * which seat was about to hold the button. Nothing broke, because at two
       * players there is no joiner to hold out, but two walks that disagree are
       * how the ORIGINAL bug got in: the dealing loop's comment says the shared
       * sb/bb computation exists precisely so "the day somebody fixes the
       * heads-up rule in one of them" the other cannot silently keep billing
       * the wrong seat. Same argument, one layer up.
       */
      if (roster.length === 2 && sortedSeats.length === 2 && this.lastBigBlindSeat > 0) {
        const headsUp = headsUpButtonSeat(sortedSeats, this.lastBigBlindSeat);
        if (headsUp !== null && headsUp > 0) return headsUp;
      }
      return this.getNextSeat(this.lastButtonSeat, eligible);
    }
    return sortedSeats[0];
  }

  /**
   * The button seat for the next hand, over the same roster the blinds use.
   * Used by the dealing loop to hold a brand-new joiner out for one hand when
   * they have sat down in the seat the button is about to reach.
   */
  protected getButtonSeatIndex(): number {
    const roster = this.seatedPlayers.filter(
      (p) =>
        p.stack > 0 &&
        (this.isTournamentTable() || !this.disconnectEngine.isSittingOut(this.tableId, p.user_id))
    );
    if (roster.length < 2) return -1;
    return this.predictButtonSeat(roster);
  }

  protected getBBSeatIndex(): number {
    // Roster that CAN hold the button/blinds this hand: has chips and isn't
    // sitting out. Waiting-for-BB players are included so the moving BB can
    // reach their seat and trigger release.
    const roster = this.seatedPlayers.filter(
      (p) =>
        p.stack > 0 &&
        // Tournament sit-outs stay in the blind rotation — they are dealt in
        // and blinded off, so the button/blinds must be able to reach them.
        (this.isTournamentTable() || !this.disconnectEngine.isSittingOut(this.tableId, p.user_id))
    );
    if (roster.length < 2) return -1;
    const nextButton = this.predictButtonSeat(roster);
    const sbSeat = roster.length === 2 ? nextButton : this.getNextSeat(nextButton, roster);
    return this.getNextSeat(sbSeat, roster);
  }

  protected getNextSeat(fromSeat: number, players: SeatedPlayer[]): number {
    const seats = players.map((p) => p.seat_number).sort((a, b) => a - b);
    if (seats.length === 0) return -1;
    for (const seat of seats) {
      if (seat > fromSeat) return seat;
    }
    return seats[0];
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // RAKE CONFIG
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Get rake config from the AUTHORITATIVE rake schedule (server/src/config/RakeConfig.ts).
   * Uses Dan's official schedule with exact SB/BB match, tier fallback, and BBJ support.
   */
  protected getRakeConfig(sb: number, bb: number): RakeConfig {
    const variant = this.tableInfo?.game_variant || 'nlh';
    const fullConfig = getFullRakeConfig(sb, bb, variant, this.getRakeOverride());
    return {
      percent: fullConfig.rakePercent,
      cap: fullConfig.rakeCap,
      noFlopNoDrop: true,
      // FIX 166: Bible V8 §7.19 — player-count-based rake caps
      playerCountCaps: getPlayerCountCaps(fullConfig.rakeCap),
    };
  }

  /**
   * Get full rake + BBJ config for the current table.
   * Used by postHandTasks for BBJ fee calculation and logging.
   */
  protected getFullRakeAndBBJConfig() {
    const sb = this.tableInfo?.small_blind ?? 1;
    const bb = this.tableInfo?.big_blind ?? 2;
    const variant = this.tableInfo?.game_variant || 'nlh';
    return getFullRakeConfig(sb, bb, variant, this.getRakeOverride());
  }

  /**
   * Resolve the rake override for this table: table setting first, then the
   * club default, then nothing (which means the published schedule).
   *
   * 2026-08-18 — the four owner-facing rake controls used to write columns the
   * engine never read. This is the only place the precedence is decided, and
   * both hand-config construction sites go through getFullRakeAndBBJConfig(),
   * so there is exactly one path. The clamping lives in getFullRakeConfig
   * because it must apply to the club values too.
   *
   * Note clubs.rake_cap is in BIG BLINDS despite its name — the label on the
   * club settings screen is literally "Rake Cap (BB)".
   */
  protected getRakeOverride(): RakeOverride | undefined {
    const pick = (a: number | null | undefined, b: number | null | undefined) => {
      const na = a === null || a === undefined ? NaN : Number(a);
      if (Number.isFinite(na) && na >= 0) return na;
      const nb = b === null || b === undefined ? NaN : Number(b);
      if (Number.isFinite(nb) && nb >= 0) return nb;
      return undefined;
    };
    const rakePercent = pick(this.tableInfo?.rake_percent, this.clubRakeDefaults?.rakePercent);
    const rakeCapBB = pick(this.tableInfo?.rake_cap_bb, this.clubRakeDefaults?.rakeCapBB);
    if (rakePercent === undefined && rakeCapBB === undefined) return undefined;
    return { rakePercent, rakeCapBB };
  }

  /**
   * Club-level rake defaults, refreshed on the same cadence as the table's own
   * rake columns (see refreshRakeConfig). Undefined until the first load, which
   * simply means "no club override yet" — the schedule still applies, so a slow
   * or failed read can never stop a table dealing or change what is taken.
   */
  protected clubRakeDefaults: { rakePercent: number | null; rakeCapBB: number | null } | null =
    null;

  /** Wall-clock of the last rake-config refresh; 0 = never. */
  protected lastRakeRefreshAtMs = 0;

  /**
   * BOMB POT STANDARDIZATION 2026-08-27 (Dan's spec §4): the per-table trigger
   * scheduler — every_n_hands, once_per_orbit, timed and bomb_pot_only modes,
   * single pending-token semantics, and the minimum-players gate. Replaces the
   * raw `handsSinceBombPot` counter (ROUND 3 AUDIT FIX 2026-08-20), whose
   * history matters: the trigger before it was `handCount % frequency === 0`
   * on the GLOBAL hand-number allocator, which made cadence a coin flip. The
   * scheduler keeps the per-table counter as internal state. Same restart
   * caveat as before: in-memory, resets on deploy, worst case the first bomb
   * after a restart arrives one full cycle later.
   */
  protected bombPotScheduler = new BombPotScheduler();

  /**
   * THE JUDGED VPIP OF EVERY SEAT (Dan 2026-09-04), refreshed at each hand
   * boundary on a table that runs the floor. Read by the horse brain for its
   * OWN row, so a horse at an Action / Madness table widens toward the floor
   * instead of being stood up every ten hands (10.5: a horse obeys the floor
   * identically, and obeying it means staying above it). Empty on a table
   * with no rule, and after a failed read - the brain then plays its prior.
   */
  protected nitStatus: Map<string, NitSeatStatus> = new Map();

  /** The floor a seat at this table must keep, percent; 0 when there is none. */
  protected vpipFloor(): number {
    if (this.tableInfo?.nit_game !== true) return 0;
    const min = Number(this.tableInfo?.maintain_percent_min ?? 0);
    return Number.isFinite(min) && min > 0 ? min : 0;
  }

  /**
   * FULL SCHEDULER PERSISTENCE (2026-08-28): last serialized scheduler state
   * written to tables.bomb_pot_sched_state — the change detector that keeps
   * the per-hand write down to one row only when something actually moved.
   */
  protected bombPotSchedPersistedJson: string | null = null;

  /**
   * SEPARATE BOMB BUTTON (spec §5.3): the bomb hands' own button seat when
   * bomb_pot_button_policy = 'separate'. Advances clockwise per bomb hand;
   * the regular rotation never sees bomb hands. Persisted in the scheduler
   * state jsonb (key `b`) so it survives restarts like everything else.
   */
  protected bombButtonSeat: number | null = null;

  /**
   * MANUAL BOMB: PUSHED, NOT POLLED (2026-08-29).
   *
   * MANUAL_NEXT_HAND must reach the engine before the next hand is dealt, and
   * the only mechanism it had was the engine ASKING — one round trip at the
   * top of every hand, on every bomb-enabled table, forever, for a flag that
   * is false essentially always, sitting on the hand-start critical path.
   *
   * `fn_request_manual_bomb_pot` now broadcasts on the `table:<id>` topic this
   * engine already opens for its own sends. This flag is what the broadcast
   * sets. The claim it triggers is unchanged and still atomic, so hearing the
   * broadcast twice — or hearing it in the same hand the throttled column read
   * also reports it — still fires exactly one bomb.
   *
   * A broadcast is best-effort by nature: an engine that restarted between the
   * click and the hand never hears it. That is what the throttled read is for
   * (see refreshRakeConfig, which now carries the column). The poll is demoted
   * from once per hand to once per refresh that was already happening; it is
   * not deleted, because a request must never be lost.
   */
  protected manualBombPushed = false;

  /**
   * Open the manual-bomb listener. Idempotent, and a failure to subscribe is
   * survivable — the throttled column read still finds the request.
   *
   * 2026-09-06: this used to open a Realtime channel named `table:<id>` PER
   * TABLE. One engine holds one Realtime socket and a socket caps at 100
   * channels, so 76 bomb-pot tables plus a channel per live tournament put the
   * engine permanently over the cap — 123,219 `ChannelRateLimitReached` errors
   * in 24 hours, and an unknown share of tables not listening at all. Every
   * table now registers on ONE shared channel (`engine:bomb-requests`) and the
   * bus dispatches by `table_id`. See server/src/services/BombRequestBus.ts.
   */
  protected subscribeManualBomb(): void {
    subscribeBombRequests(this.tableId, () => {
      this.manualBombPushed = true;
    });
  }

  /** Stop listening. Called from stop(); safe when never subscribed. */
  protected unsubscribeManualBomb(): void {
    unsubscribeBombRequests(this.tableId);
  }

  /**
   * Snapshot fields for the felt's bomb-pot indicators, shared by every
   * broadcast payload in ServerTableEngine. `bomb_pot_in` keeps its legacy
   * contract (hands until the bomb, 1 = next hand, null = no countdown);
   * `bomb_pot_next_at` is the timed mode's due timestamp (epoch ms) so the
   * client can render a clock instead of a hand counter (spec §15.2).
   */
  protected bombPotSnapshotFields(): {
    bomb_pot_in: number | null;
    bomb_pot_next_at: number | null;
    /**
     * WHY THE PROMISED BOMB HAS NOT ARRIVED (2026-08-29).
     *
     * A due bomb waits for `minPlayers` and the engine said nothing about it —
     * `isPending()` existed and had no production caller, so the felt showed
     * "BOMB POT NEXT HAND" and then dealt a normal hand, and another, and
     * another, with no way for anyone at the table to find out why.
     *
     * Null unless a bomb is genuinely waiting on the count; when it is, this
     * is how many players it is waiting for, so the pill can say so.
     */
    bomb_pot_waiting_for: number | null;
  } {
    if (!this.tableInfo) {
      return { bomb_pot_in: null, bomb_pot_next_at: null, bomb_pot_waiting_for: null };
    }
    const s = bombPotSettingsFromTable(this.tableInfo);
    const dueAt = this.bombPotScheduler.nextBombDueAt(s);
    /**
     * THE ANNOUNCE WINDOW IS ENFORCED HERE, NOT ON THE CLIENT (2026-08-29).
     *
     * `bomb_pot_announce_seconds` lets a host keep the timed clock quiet until
     * the bomb is close. It was read into tableInfo and then never used by the
     * engine: the snapshot published the exact due timestamp to every player,
     * every broadcast, and the ONLY thing honouring the setting was a
     * `remainMs > announce * 1000` test in the client's render.
     *
     * A host who sets a five-minute window is asking for the detonation time
     * to be secret until then. Shipping it in every snapshot and asking the
     * browser not to draw it is not a secret — anyone reading the websocket
     * has the number, which on a table with a forced ante is an edge over the
     * players who cannot. A rule about what players may know has to be
     * enforced where the knowledge is handed out.
     *
     * The client check stays: it is what makes the pill disappear mid-session
     * without waiting for the next snapshot, and it is now a presentation
     * detail rather than the whole enforcement.
     */
    const announceSec = Number(this.tableInfo.bomb_pot_announce_seconds ?? 0);
    const withheld = dueAt !== null && announceSec > 0 && dueAt - Date.now() > announceSec * 1000;
    // Seats dealt into the CURRENT hand is the number the scheduler gates on.
    // Falling back to the seated roster keeps the pill honest between hands.
    const dealtIn = this.seatedPlayers.filter((p) => !p.is_sitting_out).length;
    const waitingFor =
      s.enabled && this.bombPotScheduler.isPending() && dealtIn < s.minPlayers
        ? s.minPlayers
        : null;
    return {
      bomb_pot_in: this.bombPotScheduler.handsUntilDue(s),
      bomb_pot_next_at: withheld ? null : dueAt,
      bomb_pot_waiting_for: waitingFor,
    };
  }

  /**
   * Re-read the table's and club's rake settings so an owner's change takes
   * effect without restarting the engine. Called at the top of each hand and
   * throttled — tableInfo is otherwise loaded once per engine lifetime, and at
   * 500+ live tables a per-hand read of two rows is real load for a value that
   * changes perhaps twice a year.
   *
   * Deliberately best-effort: on any error the previous values stand.
   *
   * ── IT IS NOT ONLY RAKE ANY MORE (2026-09-09, lane E of the must-move audit)
   *
   * "A value that changes perhaps twice a year" was true of every column this
   * read, and stopped being true at Gate 5. A cluster table's rules are now
   * written by `fn_cash_apply_ruleset` on EVERY tick from the template its
   * players chose the game by, so the ante, the VPIP floor, run-it-N-times,
   * seven-deuce, the straddle switches, the buy-in band and the action clock
   * are all values the database can change under a running engine.
   *
   * They were not in this read. `this.tableInfo` has exactly three writers -
   * `start()` (once per process), `refreshBlinds()` (tournaments only) and
   * this method - so every one of them was a boot-time snapshot held until the
   * engine restarted.
   *
   * MEASURED: on 2026-09-09 the realignment turned antes off on 19 live
   * Classic tables and bombs off on 24. The bomb half followed within this
   * method's 60-second throttle because those columns were already here. The
   * ante half would have gone on being collected until each table's next
   * restart, on a game sold as "No Antes".
   *
   * The hourly :55 restart caps the damage at an hour. That is luck, not a
   * fix (10.11/10.12), so the whole templated rule set is read here now.
   * A rule the player was sold under the game's name follows the row.
   */
  protected async refreshRakeConfig(force = false): Promise<void> {
    if (!this.tableInfo || this.isTournamentTable()) return;
    const now = Date.now();
    if (!force && now - this.lastRakeRefreshAtMs < RAKE_CONFIG_TTL_MS) return;
    this.lastRakeRefreshAtMs = now;
    try {
      const { data: tableRow } = await supabase
        .from('tables')
        .select(
          // ROUND 3 (2026-08-20): bomb pot settings ride the same throttled
          // re-read — an owner toggling bomb pots (or double board) no longer
          // waits for an engine restart, same reason rake got this in
          // 2026-08-18.
          // BOMB POT STANDARDIZATION 2026-08-27: the five new canonical
          // columns ride along — board count, trigger mode, timed interval,
          // minimum players and fixed ante.
          // THE WHOLE TEMPLATED RULE SET RIDES ALONG TOO (2026-09-09, lane E
          // of the must-move audit). See the doc comment above for why: these
          // are no longer host settings that change twice a year, they are
          // rewritten by fn_cash_apply_ruleset on every cluster tick.
          'rake_percent, rake_cap_bb, bomb_pot_enabled, bomb_pot_frequency, bomb_pot_ante_multiplier, bomb_pot_double_board, bomb_pot_board_count, bomb_pot_trigger_mode, bomb_pot_interval_seconds, bomb_pot_min_players, bomb_pot_ante_fixed, bomb_pot_variant, bomb_pot_button_policy, bomb_pot_announce_seconds, bomb_pot_manual_pending, ante_enabled, ante, big_blind_ante_enabled, nit_game, maintain_percent_min, maintain_hands, career_percent_min, run_it_mode, run_it_twice, allow_run_it_twice, run_it_twice_enabled, insurance_enabled, seven_deuce_enabled, seven_deuce_amount, straddle_enabled, auto_utg_straddle, voluntary_straddle, min_buy_in, max_buy_in, action_time_seconds'
        )
        .eq('id', this.tableId)
        .maybeSingle();
      /* A DIAMOND TABLE'S RULES DO NOT LEAVE THE BOUNDARY UNDER IT (2026-09-11,
         restated 2026-09-12 when straddles and run it twice were admitted).

         Everything below re-reads the row roughly once a minute and applies
         it, which is right for a chip club: the rules follow the row. For an
         arena table it was a hole, because admission is the only OTHER place
         the Diamond boundary is checked, so a column flipped afterwards was
         honoured here whatever it said.

         The fix is not to freeze an arena table. A staff door may legitimately
         turn straddles or run it twice on for a table that is already running,
         and both are inside the boundary now, so the refreshed row SHOULD be
         applied and the table picks the change up without a restart. What must
         never be applied is a row the boundary would no longer admit - rake, a
         jackpot percentage, insurance, a bomb pot, a variant, or a run-it
         column that has gone unset. Those are refused here and the table keeps
         dealing under the rules its players sat down to, with the refusal
         recorded rather than silently swallowed. */
      if (tableRow && this.tableInfo && (this.tableInfo as any).arena?.asset === 'diamonds') {
        try {
          // The boundary of the table's own kind: a tournament table is held
          // to the tournament boundary, a cash table to the cash one.
          assertDiamondTable(tableRow as unknown as Record<string, unknown>);
        } catch (error) {
          console.error(
            `[refreshRakeConfig] Diamond table ${this.tableId} rules changed to something the ` +
              `arena boundary refuses; keeping the admitted rules. ${String(error)}`
          );
          return;
        }
      }
      if (tableRow && this.tableInfo) {
        this.tableInfo.rake_percent = tableRow.rake_percent ?? undefined;
        this.tableInfo.rake_cap_bb = tableRow.rake_cap_bb ?? undefined;
        this.tableInfo.bomb_pot_enabled = (tableRow as any).bomb_pot_enabled ?? false;
        this.tableInfo.bomb_pot_frequency = (tableRow as any).bomb_pot_frequency ?? 0;
        this.tableInfo.bomb_pot_ante_multiplier = (tableRow as any).bomb_pot_ante_multiplier ?? 2;
        this.tableInfo.bomb_pot_double_board = (tableRow as any).bomb_pot_double_board ?? false;
        this.tableInfo.bomb_pot_board_count = (tableRow as any).bomb_pot_board_count ?? undefined;
        this.tableInfo.bomb_pot_trigger_mode = (tableRow as any).bomb_pot_trigger_mode ?? null;
        this.tableInfo.bomb_pot_interval_seconds =
          (tableRow as any).bomb_pot_interval_seconds ?? null;
        this.tableInfo.bomb_pot_min_players = (tableRow as any).bomb_pot_min_players ?? undefined;
        this.tableInfo.bomb_pot_ante_fixed = (tableRow as any).bomb_pot_ante_fixed ?? null;
        this.tableInfo.bomb_pot_variant = (tableRow as any).bomb_pot_variant ?? null;
        this.tableInfo.bomb_pot_button_policy = (tableRow as any).bomb_pot_button_policy ?? null;
        this.tableInfo.bomb_pot_announce_seconds =
          (tableRow as any).bomb_pot_announce_seconds ?? null;
        // 2026-08-29: THE BACKSTOP FOR THE PUSH. fn_request_manual_bomb_pot
        // broadcasts, and manualBombPushed is normally how the engine hears
        // about a request. A broadcast is best-effort, so an engine that
        // restarted between the click and the hand would never hear it — this
        // read, which was already happening on its own throttle, catches that.
        // Latching rather than assigning: the flag is cleared only by a
        // successful claim, so a stale `false` here cannot un-arm a push that
        // arrived a moment ago.
        if ((tableRow as any).bomb_pot_manual_pending === true) {
          this.manualBombPushed = true;
        }
        // An owner who turns bomb pots ON mid-session gets the listener here,
        // rather than having to wait for an engine restart to be able to fire
        // a manual bomb at all.
        if (this.tableInfo.bomb_pot_enabled === true) this.subscribeManualBomb();

        /* ── THE TEMPLATED RULES, RE-READ (2026-09-09, lane E) ──────────────
           Everything below is a rule the PLAYER was sold under the game's
           name - Classic "No Antes, No Bombs, No VPIP Floor", Action "Small
           Blind Ante ...", Madness "Big Blind Ante ...". Until today only the
           bomb half of that promise was re-read; the rest was sampled once in
           start() and held for the life of the process.

           On 2026-09-09 the realignment migration turned the ante off on 19
           live Classic tables and the bombs off on 24. The bombs stopped
           inside a minute. THE ANTES WOULD HAVE KEPT BEING COLLECTED until
           each engine's next restart, in a game whose own card says it has
           none. Forced money out of a stack is not a cosmetic mismatch.

           The hourly :55 restart bounded that at one hour, which is why it
           never showed up as a flood. A defect that a restart happens to wash
           away is not fixed (CLAUDE.md 10.11/10.12); it is the platform
           getting lucky on a clock. So the rules follow the row. */
        this.tableInfo.ante_enabled = (tableRow as any).ante_enabled ?? undefined;
        this.tableInfo.ante = (tableRow as any).ante ?? undefined;
        this.tableInfo.big_blind_ante_enabled =
          (tableRow as any).big_blind_ante_enabled ?? undefined;
        this.tableInfo.nit_game = (tableRow as any).nit_game ?? undefined;
        this.tableInfo.maintain_percent_min = (tableRow as any).maintain_percent_min ?? undefined;
        this.tableInfo.maintain_hands = (tableRow as any).maintain_hands ?? undefined;
        this.tableInfo.career_percent_min = (tableRow as any).career_percent_min ?? undefined;
        this.tableInfo.run_it_mode = (tableRow as any).run_it_mode ?? undefined;
        this.tableInfo.run_it_twice = (tableRow as any).run_it_twice ?? undefined;
        this.tableInfo.allow_run_it_twice = (tableRow as any).allow_run_it_twice ?? undefined;
        this.tableInfo.run_it_twice_enabled = (tableRow as any).run_it_twice_enabled ?? undefined;
        this.tableInfo.insurance_enabled = (tableRow as any).insurance_enabled ?? undefined;
        (this.tableInfo as any).seven_deuce_enabled =
          (tableRow as any).seven_deuce_enabled ?? undefined;
        (this.tableInfo as any).seven_deuce_amount =
          (tableRow as any).seven_deuce_amount ?? undefined;
        this.tableInfo.straddle_enabled = (tableRow as any).straddle_enabled ?? undefined;
        (this.tableInfo as any).auto_utg_straddle =
          (tableRow as any).auto_utg_straddle ?? undefined;
        (this.tableInfo as any).voluntary_straddle =
          (tableRow as any).voluntary_straddle ?? undefined;
        this.tableInfo.min_buy_in = (tableRow as any).min_buy_in ?? undefined;
        this.tableInfo.max_buy_in = (tableRow as any).max_buy_in ?? undefined;
        this.tableInfo.action_time_seconds = (tableRow as any).action_time_seconds ?? undefined;

        /* The four run-it columns are not read directly at the offer; they are
           COMPILED into the RIT engine by applyRunItTwiceConfig. Refreshing
           the row without re-running it would leave the engine configured from
           the boot row, so the re-read would be silently ineffective for the
           one rule most likely to differ between two tables of one game.

           Insurance is deliberately NOT re-configured here: start() sets only
           `enabled` on that engine while other call sites also set houseMargin
           and offerTimeoutSeconds, so a partial re-configure mid-flow would
           drop them. applyRunItTwiceConfig only READS insurance_enabled (it
           returns it), so this is safe. The straddle and seven-deuce columns
           are read straight off tableInfo at the moment they matter, so the
           assignment above is the whole of their fix. */
        this.applyRunItTwiceConfig();
      }
      const clubId = this.tableInfo?.club_id;
      if (clubId) {
        const { data: clubRow } = await supabase
          .from('clubs')
          .select('default_rake_percent, rake_cap')
          .eq('id', clubId)
          .maybeSingle();
        if (clubRow) {
          this.clubRakeDefaults = {
            rakePercent: clubRow.default_rake_percent ?? null,
            rakeCapBB: clubRow.rake_cap ?? null,
          };
        }
      }
    } catch (err) {
      reportError(err, `ServerTableEngine.${this.tableId}.refreshRakeConfig_failed`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // UTILITY
  // ═════════════════════════════════════════════════════════════════════════════

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // FIX 137: Bible V8 §7.17 — CRASH RECOVERY HELPERS
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Save a snapshot of the current hand state to the database.
   * Called after every successful action and after hand start.
   * The snapshot excludes the `deck` field (not JSON-serializable).
   */
  /**
   * C15 FIX (2026-08-09): coalesce snapshot writes instead of paying one per action.
   *
   * saveSnapshot() serializes the whole hand state and does one upsert.
   * It was fired after EVERY accepted action — 20 to 80 writes per hand per
   * table — which at 500+ tables is enough on its own to saturate the connection
   * pool. And it buys very little today: rehydrate() is never called and
   * checkCrashRecovery() abandons in-flight hands (see B10), so the snapshot's
   * only live consumers are forensics and getActiveHandSnapshotFull.
   *
   * Rather than drop it (which would foreclose resume-after-restart) this
   * coalesces: write immediately if the last write is old enough, otherwise mark
   * dirty and let one trailing timer do it. Bursty streets collapse to ~1 write
   * per second per table while the LAST state of any burst is still persisted —
   * which is the state a crash would actually need.
   */
  protected requestSnapshot(): void {
    this.snapshotDirty = true;
    const since = Date.now() - this.lastSnapshotAtMs;
    if (since >= ServerTableEngineBase.SNAPSHOT_MIN_INTERVAL_MS) {
      void this.flushSnapshot();
      return;
    }
    if (this.snapshotTimer) return; // a trailing write is already queued
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null;
      void this.flushSnapshot();
    }, ServerTableEngineBase.SNAPSHOT_MIN_INTERVAL_MS - since);
    // Never hold the process open for a snapshot.
    this.snapshotTimer.unref?.();
  }

  /**
   * Write now if anything changed since the last write. Safe to call spuriously.
   * Gameplay-triggered snapshots stay best-effort; terminal teardown opts into a
   * rejection so its owner receives an honest cleanup certificate.
   */
  protected async flushSnapshot(rejectOnFailure = false): Promise<void> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    for (;;) {
      let write = this.snapshotFlushPromise;
      if (!write) {
        if (!this.snapshotDirty) return;
        this.snapshotDirty = false;
        this.lastSnapshotAtMs = Date.now();
        write = this.saveSnapshot();
        this.snapshotFlushPromise = write;
      }

      try {
        await write;
      } catch (error) {
        /* Gameplay remains best-effort; teardown observes the same writer. */
        if (rejectOnFailure) throw error;
        return;
      } finally {
        if (this.snapshotFlushPromise === write) this.snapshotFlushPromise = null;
      }

      // An action may have dirtied the snapshot while the prior write was in
      // flight. A teardown caller has already fenced actions and therefore
      // drains this loop to a stable point without letting a writer outlive it.
      if (this.snapshotFlushPromise && this.snapshotFlushPromise !== write) continue;
      if (!this.snapshotDirty) return;
    }
  }

  protected async saveSnapshot(): Promise<void> {
    if (!this.handController || !this.tableInfo) return;

    const state = this.handController.getState();

    // Serialize state — exclude `deck` (internal Deck instance, not JSON-safe)
    const { deck, ...serializableState } = state as any;

    const fullRakeConfig = this.getFullRakeAndBBJConfig();

    const config: HandConfig = {
      tableId: this.tableId,
      handNumber: this.handCount,
      gameVariant: this.dealtGameVariant() as GameVariant,
      smallBlind: this.tableInfo.small_blind,
      bigBlind: this.tableInfo.big_blind,
      ante: this.tableInfo.ante,
      // RAKE-AUDIT 2026-07-24: same tournament guard + BBJ default-enabled as
      // the primary hand-config site — see buildHandConfig comments there.
      rakeConfig: this.isTournamentTable()
        ? { percent: 0, cap: 0, noFlopNoDrop: true }
        : {
            percent: fullRakeConfig.rakePercent,
            cap: fullRakeConfig.rakeCap,
            noFlopNoDrop: true,
            // FIX 166: Bible V8 §7.19 — player-count-based rake caps (heads-up = 50%, 3-handed = 67%)
            playerCountCaps: getPlayerCountCaps(fullRakeConfig.rakeCap),
          },
      bbjConfig: {
        enabled:
          !this.isTournamentTable() &&
          fullRakeConfig.bbjEnabled &&
          ((this.tableInfo as any)?.bbj_percent ?? 100) > 0,
        feeBB: fullRakeConfig.bbjFeeBB,
        minPotBB: fullRakeConfig.rules.minPotBB,
        minPlayersDealt: fullRakeConfig.rules.minPlayersDealt,
      },
    };

    await saveHandStateSnapshot({
      tableId: this.tableId,
      handNumber: this.handCount,
      stateJson: serializableState,
      configJson: config as unknown as Record<string, unknown>,
      dealerSeat: this.currentHandDealerSeat,
      playersJson: state.players.map((p) => ({
        seat: p.seat,
        user_id: p.user_id,
        username: p.username,
        stack: p.stack,
        is_horse: p.is_horse ?? false,
      })),
      stage: state.stage,
      // Phase 1.2 PR-D: pending deadlines.
      // Phase 1.2 PR-E: disconnect FSM states.
      //
      // These used to be a SECOND statement against the row the line above had
      // just inserted. Measured 2026-09-04: 1,210,782 such updates in one stats
      // window against 1,209,476 inserts, on the largest table in the database,
      // and only 16.5% of them HOT - so ~83% rewrote a ~1.7 KB tuple and all
      // three indexes to fill in two columns we already had in hand. Folded
      // into the insert. The row that lands is identical.
      pendingDeadlines: deadlineScheduler.persistPending(this.tableId),
      disconnectStates: this.disconnectEngine.getFsmStatesForTable(this.tableId),
    });
  }

  /**
   * Continue hand numbering from where this table left off.
   *
   * handCount defaults to 0, and before this existed the ONLY thing that ever
   * restored it was checkCrashRecovery(), which needs an incomplete-hand
   * snapshot. A clean restart (deploy, reboot, table reactivation) has no
   * snapshot, so numbering silently began again at 1 and (table_id,
   * hand_number) stopped being unique for the table.
   *
   * Failure is non-fatal by design: if the lookup errors we leave handCount at
   * its current value and carry on. A duplicated hand number is an annoyance;
   * refusing to start the table would be an outage.
   */
  private async seedHandCountFromHistory(): Promise<void> {
    try {
      // ── 2026-08-17: why this query, and what it survived ──
      //
      // The first version ordered by hand_number DESC LIMIT 1 with NO index on
      // (table_id, hand_number) — only (table_id) and (table_id, created_at).
      // Postgres index-scanned the whole partition and SORTED it (cost 14218)
      // against a 10 GB / ~1.58M-row table, so it blew the statement timeout on
      // exactly the tables this seed matters most for. Seen in production:
      //
      //   [ServerTableEngine:87fc21ed-...] Could not seed hand counter
      //   (canceling statement due to statement timeout) - continuing from #0
      //
      // That table had 12,919 prior hands and restarted at #1 regardless. A
      // bounded 500-row read through the created_at index shipped as a stopgap
      // (113 ms, an approximation of MAX rather than MAX).
      //
      // 2026-08-17, later the same day: THE INDEX NOW EXISTS, so this is the
      // exact MAX again rather than the bounded approximation described above.
      //   idx_hand_history_table_handnum (table_id, hand_number DESC), 55 MB
      // Re-measured on 87fc21ed, the table that used to time out:
      //   Index Only Scan, Heap Fetches: 1, Execution Time 3.481 ms
      // (previously: index scan of the whole partition + Sort, cost 14218,
      // cancelled by the statement timeout).
      // .maybeSingle() not .single(): a table that has never dealt a hand
      // returns zero rows, and .single() raises PGRST116 on zero rows.
      const { data, error } = await supabase
        .from('hand_history')
        .select('hand_number')
        .eq('table_id', this.tableId)
        .order('hand_number', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Could not seed hand counter (${error.message}) - ` +
            `continuing from #${this.handCount}. Hand numbers may repeat for this table.`
        );
        return;
      }

      const last = Number((data as { hand_number?: number } | null)?.hand_number ?? 0);
      // 2026-08-18: hand numbers now come from the global sequence, allocated
      // fresh at each deal, so there is no counter to "resume" — the next hand
      // cannot collide with anything no matter what this engine last saw. This
      // is kept only to log where the table left off, which is genuinely useful
      // when reading a crash trail.
      if (Number.isFinite(last) && last > 0) {
        console.log(
          `[ServerTableEngine:${this.tableId}] Last persisted hand on this table: #${last}`
        );
      }
    } catch (err) {
      console.warn(
        `[ServerTableEngine:${this.tableId}] Hand counter seed threw (${(err as Error)?.message}) - ` +
          `continuing from #${this.handCount}.`
      );
    }
  }

  /**
   * EVICT SEATS THAT HAVE OUTSTAYED THE SIT-OUT RULE.
   *
   * Dan 2026-08-25: "IF YOU ARE SITTING OUT IT NEVER KICKS YOU OFF THE TABLE.
   * YOU CAN LITERALLY HOLD THAT SEAT FOREVER. IT SHOULD BE 2 ORBITS OR 5
   * MINUTES, WHICHEVER IS FIRST AND YOU GET AUTO BOOTED."
   *
   * The rule was implemented and lived in ONE place: the dealing loop. And the
   * dealing loop is not running in precisely the situation the player is
   * describing — `start()` parks in a wait-for-players loop until the table has
   * enough seats to deal, and only then launches it. A table with one seated
   * player (which GameServer deliberately keeps an engine alive for), or one
   * that fell below AutoStart, never reaches the sweep at all. The last person
   * at the table sits out and holds the seat indefinitely, and the five-minute
   * clock never runs because nothing ever asks it the time.
   *
   * Extracted here so both the wait loop and the dealing loop can call it.
   * `countOrbit` is true only when a hand is actually being dealt — an idle tick
   * is not an orbit.
   *
   * Cash tables only: a tournament sit-out is blinded off by design and must
   * never be stood up.
   */
  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  ONE DOOR OUT FOR A BUSTED SEAT (final sweep, 2026-09-08)
   * ═════════════════════════════════════════════════════════════════════════
   *
   * A busted player who is not coming back leaves through THIS, whether they
   * are a human who let the rebuy prompt lapse or a horse at its stop-loss or
   * with no treasury behind it. Before this helper there were five copies of
   * the exit and they disagreed in three ways the felt can see:
   *
   *   - the human copy went through atomicCashout (the money path, so the exit
   *     is on the ledger's books) and emitted `seat_left` AFTER the write
   *     confirmed; the four horse copies called markSeatAsLeft by hand;
   *   - three of the four horse copies emitted no `seat_left` at all, so a
   *     busted horse's seat cleared on every client only when a snapshot
   *     happened to be diffed - the exact tell the 10.5 comment on the fourth
   *     copy was written to remove;
   *   - the fourth emitted `seat_left` BEFORE the write, so a failed write
   *     left every client showing an empty chair with the row still occupied.
   *
   * Same door, same order, same event, same reason, for everyone (CLAUDE.md
   * 10.5). Returns true when the seat is confirmed released. On any failure it
   * reports, leaves the roster and every tracker exactly as they were, and
   * returns false: an unknown outcome is not a leave, and the next sweep asks
   * the same cashout again under the same idempotency key.
   */
  protected async releaseBustedSeat(
    player: { user_id: string; seat_number: number; username?: string; occupancy_id?: string },
    reason: 'busted_no_rebuy' | 'busted_stop_loss' | 'busted_unfunded'
  ): Promise<boolean> {
    try {
      /* atomicCashout, not markSeatAsLeft-by-hand: it takes the seat lock,
         credits any residual stack through atomic_credit_wallet_and_log under
         an idempotency key, and stamps left_at - all in one RPC. The stack is
         zero here by definition, so no chips move, but the exit is on the
         money path's books either way (CLAUDE.md 11.5). */
      await atomicCashout(player.user_id, this.tableId, player.seat_number, {
        leaveMode: 'forced',
        occupancyId: player.occupancy_id,
      });
    } catch (err) {
      reportError(err, 'ServerTableEngine.' + this.tableId + '.busted_release_cashout', {
        userId: player.user_id,
        seat: player.seat_number,
        reason,
      });
      return false;
    }
    if (
      this.seatedPlayers.some(
        (p) => p.user_id === player.user_id && p.occupancy_id !== player.occupancy_id
      )
    )
      return false;
    // The event goes out only once the row says the chair is empty.
    this.hub?.emitEvent(this.tableId, {
      type: 'seat_left',
      table_id: this.tableId,
      seat: player.seat_number,
      user_id: player.user_id,
      mid_hand: false,
      reason,
      timestamp: Date.now(),
    });
    this.chipContinuity.forget(player.user_id);
    this.disconnectEngine.unregisterPlayer(this.tableId, player.user_id);
    this.timeBankEngine.removePlayer(this.tableId, player.user_id);
    this.straddleEngine.removePlayer(this.tableId, player.user_id);
    this.preActionEngine.removePlayer(this.tableId, player.user_id);
    return true;
  }

  protected async evictExpiredSitOuts(opts: { countOrbit: boolean }): Promise<void> {
    if (this.isTournamentTable()) return;
    // THE FREEZE (CLAUDE.md 13.5): this sweep stands players up and cashes
    // them out. The wait loop and the dealing loop both park on
    // `maintenancePaused` before reaching it, but that flag is this engine's
    // memory and the freeze is the platform's; an engine booted mid-break has
    // the one and not the other. The gate the law names, here, so it holds
    // from every call site.
    if (isMaintenanceFrozen()) return;
    const releaseSeatBoundary = await this.acquireSeatBoundary();
    try {
      while (this.postHandTasksPromise) {
        const settlement = this.postHandTasksPromise;
        await settlement;
        if (this.postHandTasksPromise === settlement) break;
      }
      if (this.terminal || isMaintenanceFrozen()) return;
      const originalOccupancies = new Map(this.seatedPlayers.map((p) => [p.user_id, { ...p }]));
      const seatedIds = [...originalOccupancies.keys()];
      if (seatedIds.length === 0) return;

      const sitOutEvictable = this.disconnectEngine.tickSitOutsAndCollectEvictions(
        this.tableId,
        seatedIds,
        { countOrbit: opts.countOrbit }
      );
      // Dan 2026-08-23, BINDING: away-blind cap. "IF A PLAYER IS AWAY FROM THE
      // CASH GAME TABLE, ONCE THEY LOSE ONE BB AND ONE SB THEY MUST BE AUTO
      // REMOVED." Collected together so one pass removes the seat once.
      const blindEvictable = this.disconnectEngine.collectAwayBlindEvictions(
        this.tableId,
        seatedIds
      );

      // Dan 2026-08-25, table-creation parity: NIT GAME. `nit_game` and its three
      // numbers were columns the creation page wrote and nothing read, while the
      // toggle's own tooltip promised a "Penalty for tight play".
      //
      // The rule is a QUERY (fn_nit_evictions) rather than engine state, because
      // ca_hand_facts already stores VPIP per player per hand from the same
      // derivation the player's own HUD shows. A second counter here would be a
      // second answer, and the two would part company the first time this process
      // restarted mid-session.
      //
      // GATED ON THE COLUMN so the round trip never happens on a table without the
      // rule — which is every table today. A failure returns an empty list: a
      // stats query that cannot answer must not throw anyone out of a hand they
      // were entitled to play.
      //
      // Merged into this shared method 2026-08-25: it arrived on main inside the
      // inline block this method replaced, and it belongs wherever the other two
      // eviction reasons live — including the start-up wait loop.
      const nitEvictable: string[] = [];
      if (this.tableInfo?.nit_game === true) {
        // The board every seat is judged on, kept for the brain (Dan
        // 2026-09-04). Read beside the eviction, at the same boundary, from the
        // same rows, so what a horse steers by is what it is stood up on.
        this.nitStatus = await collectNitStatus(this.tableId);
        const nits = await collectNitEvictions(this.tableId);
        for (const n of nits) {
          console.log(
            `[ServerTableEngine:${this.tableId}] nit game: ${n.userId} is at ` +
              `${n.vpip}% VPIP over ${n.hands} hands, table requires ${n.required}%`
          );
          nitEvictable.push(n.userId);
        }
      }

      // 2026-09-04: a seat nobody is behind for five minutes, never sat out and
      // never charged a blind (a quiet table), is released on the same clock
      // as a sit-out. See DisconnectEngine.collectAbandonedSeatEvictions.
      const abandonedEvictable = this.disconnectEngine.collectAbandonedSeatEvictions(
        this.tableId,
        seatedIds
      );

      const blindEvictSet = new Set(blindEvictable);
      const nitEvictSet = new Set(nitEvictable);
      const abandonedEvictSet = new Set(abandonedEvictable);
      const evictable = Array.from(
        new Set([...sitOutEvictable, ...blindEvictable, ...nitEvictable, ...abandonedEvictable])
      );
      if (evictable.length === 0) return;

      // Dan 2026-08-26, binding: "a player can never leave the table while they
      // are all in. they must wait for the hand to be finished." An eviction is
      // still a departure, and this one cashes the seat out. Both call sites are
      // between hands today, so this should never fire - which is the point: the
      // safety was call-site placement rather than a check, and a future caller
      // would not know that. leaveTable() refuses the same case explicitly.
      const evictHand = this.handController?.getState();

      const departed = new Set<string>();
      for (const userId of evictable) {
        if (this.terminal || isMaintenanceFrozen()) break;
        const seated = originalOccupancies.get(userId);
        if (
          !seated ||
          !this.seatedPlayers.some(
            (p) =>
              p.user_id === userId &&
              p.occupancy_id === seated.occupancy_id &&
              p.seat_number === seated.seat_number
          )
        )
          continue;
        const evictSelf = evictHand?.players.find((p) => p.user_id === userId);
        if (evictSelf?.is_all_in && !evictSelf.is_folded) {
          console.log(
            `[ServerTableEngine:${this.tableId}] NOT evicting ${userId} - all-in in a live hand`
          );
          continue;
        }
        // Folding removes winning eligibility, not a participant's unsettled
        // contribution. Every live-hand participant waits for settlement.
        if (evictSelf) continue;
        // Presence can change while an eligibility read or an earlier
        // player's cashout is awaited. Recheck this original occupant now,
        // without charging another orbit.
        const stillTimedOut = this.disconnectEngine
          .tickSitOutsAndCollectEvictions(this.tableId, [userId], { countOrbit: false })
          .includes(userId);
        const stillAway = this.disconnectEngine
          .collectAwayBlindEvictions(this.tableId, [userId])
          .includes(userId);
        const stillAbandoned = this.disconnectEngine
          .collectAbandonedSeatEvictions(this.tableId, [userId])
          .includes(userId);
        if (!stillTimedOut && !stillAway && !stillAbandoned && !nitEvictSet.has(userId)) continue;
        const awayBlindEvict = blindEvictSet.has(userId) && stillAway;
        const nitEvict = !awayBlindEvict && nitEvictSet.has(userId);
        const abandonedEvict =
          !awayBlindEvict &&
          !nitEvict &&
          !stillTimedOut &&
          abandonedEvictSet.has(userId) &&
          stillAbandoned;
        console.log(
          awayBlindEvict
            ? `[ServerTableEngine:${this.tableId}] evicting ${userId} - away, already charged one SB and one BB`
            : nitEvict
              ? `[ServerTableEngine:${this.tableId}] evicting ${userId} - below this nit game's VPIP floor`
              : abandonedEvict
                ? `[ServerTableEngine:${this.tableId}] evicting ${userId} - gone for 5 minutes with nobody behind the seat`
                : `[ServerTableEngine:${this.tableId}] evicting ${userId} - sat out past the 2-orbit / 5-minute limit`
        );
        try {
          // BOOTED FOR LOW VPIP = BARRED FOR TWO HOURS (Dan 2026-09-05): the
          // database writes the bar from this leave mode; every other eviction
          // stays a plain system exit.
          await atomicCashout(userId, this.tableId, seated.seat_number, {
            occupancyId: seated.occupancy_id,
            ...(nitEvict ? { leaveMode: 'vpip_evicted' as const } : {}),
          });
          if (
            this.seatedPlayers.some(
              (p) => p.user_id === userId && p.occupancy_id !== seated.occupancy_id
            )
          )
            continue;
          departed.add(seated.occupancy_id!);
          this.hub?.emitEvent(this.tableId, {
            type: 'seat_left',
            table_id: this.tableId,
            seat: seated.seat_number,
            user_id: userId,
            mid_hand: false,
            reason: awayBlindEvict
              ? 'away_blind_cap'
              : nitEvict
                ? 'nit_game_vpip'
                : abandonedEvict
                  ? 'abandoned_seat'
                  : 'sit_out_timeout',
            timestamp: Date.now(),
          });
          this.disconnectEngine.unregisterPlayer(this.tableId, userId);
          this.timeBankEngine.removePlayer(this.tableId, userId);
          this.straddleEngine.removePlayer(this.tableId, userId);
          this.preActionEngine.removePlayer(this.tableId, userId);
          this.leaveHeldByClock.delete(userId);
          this.chipContinuity.forget(userId);
        } catch (err) {
          reportError(err, 'ServerTableEngine.' + this.tableId + '.sitout_evict_cashout');
          // Keep the roster and tracking until the next pass confirms departure.
          // Retrying through a different helper would discard the eviction mode.
        }
      }
      this.seatedPlayers = this.seatedPlayers.filter(
        (p) => !p.occupancy_id || !departed.has(p.occupancy_id)
      );
    } finally {
      releaseSeatBoundary();
    }
  }

  /**
   * PUT SITTING-OUT PLAYERS BACK IN THE CHAIR THEY LEFT.
   *
   * Restart fidelity, Dan 2026-08-25. The engine writes `table_seats
   * .is_sitting_out` on every PLAYER_SAT_OUT / PLAYER_SAT_BACK and, until now,
   * never read it back — `loadSeatedPlayers` did not even select the column.
   * DisconnectEngine's sit-out set is in memory, so a restart between hands
   * emptied it and the very next deal dealt cards, and took blinds, from
   * players who had sat out. Every client meanwhile read the column and
   * correctly showed them as out: the felt and the database disagreed, and the
   * felt was the one taking money.
   *
   * REGISTER FIRST. This is the whole reason the first version of this method
   * did nothing at all: `DisconnectEngine.sitOut()` opens with
   * `const state = this.playerStates.get(key); if (!state) return;`, and that
   * Map is only ever populated by `registerPlayer`, which runs inside dealHand.
   * At boot it is empty, so every sitOut() here returned at the guard — while
   * the console.log below still announced a restore that had not happened. A
   * log that lies is worse than no log: it makes the bug unfindable.
   *
   * `registerPlayer` is idempotent (it returns early when the key exists), so
   * calling it here cannot disturb a player the dealing loop has already set up.
   *
   * Called from BOTH the start-up wait loop and the dealing loop's seat sweep,
   * so a seat that appears later — someone mid-buy-in when the engine booted —
   * still gets its state applied. Never un-sits anyone: sitting back in is a
   * player action, and a stale `false` must not override a live sit-out.
   */
  protected restoreSitOutsFromSeats(): void {
    for (const p of this.seatedPlayers) {
      if (p.is_sitting_out !== true) continue;
      if (this.disconnectEngine.isSittingOut(this.tableId, p.user_id)) continue;
      this.disconnectEngine.registerPlayer(this.tableId, p.user_id);
      /* THE CLOCK COMES FROM THE DATABASE, NOT FROM now() (2026-08-28).
       *
       * This call used to omit the fourth argument, so sitOut() stamped
       * `sitOutSince = Date.now()`. That single line is why the five-minute
       * cash eviction never fired in production: this method runs on every
       * pass of BOTH the start-up wait loop and the dealing loop, so every
       * engine restart — deploy, lease change, killForRestart, watchdog —
       * silently handed every sat-out seat a fresh five minutes. A table whose
       * engine recycled more often than that could never evict anyone, and the
       * player kept the seat indefinitely.
       *
       * `sit_out_at` is written by a database trigger on the transition into
       * sitting out and cleared on the way out, so it is the only stamp in the
       * system that a restart cannot move. Falling back to now() when it is
       * absent keeps a pre-migration row working rather than pinning it at
       * epoch 0 and evicting it instantly. */
      const stampedAt = p.sit_out_at ? Date.parse(p.sit_out_at) : NaN;
      this.disconnectEngine.sitOut(
        this.tableId,
        p.user_id,
        'voluntary',
        Number.isFinite(stampedAt) ? stampedAt : undefined
      );
      // Report the OUTCOME, not the attempt.
      if (this.disconnectEngine.isSittingOut(this.tableId, p.user_id)) {
        console.log(
          `[ServerTableEngine:${this.tableId}] Restored sit-out for ${p.user_id} from table_seats`
        );
      } else {
        reportError(
          new Error(`sit-out restore had no effect for ${p.user_id}`),
          'ServerTableEngine.sit_out_restore_no_effect'
        );
      }
    }
  }

  /**
   * WRITE THE CASH ENTRY HOLD DOWN, SO A DEPLOY CANNOT CANCEL IT.
   *
   * Dan 2026-08-30. `waitingForBB`, `postBBWhenClear` and `postingBBToEnter`
   * are Sets on this process and every push to `server/**` redeploys it. The
   * dealing loop's first-iteration block then adds every seated player to
   * `knownPlayerIds` AND `dealtInUserIds` — right for someone who really was
   * playing before the restart, wrong for someone who was being HELD, who came
   * back released, unbilled and button-eligible. One deploy, three house rules
   * switched off: the wait, "no free hands", and "a new player never gets the
   * button".
   *
   * Fire-and-forget on purpose, in the house style of the other seat-state
   * writes. This is a DURABILITY improvement over a Set in memory; awaiting it
   * inside the dealing loop would put a network round trip between a player
   * tapping a button and the engine acting on it, to protect against a restart
   * landing inside a few hundred milliseconds. The in-memory set stays
   * authoritative for the running process; this column is only ever read by
   * `restoreEntryHoldsFromSeats()` on boot.
   *
   * Scoped to the live seat (`left_at IS NULL`) so it can never resurrect state
   * onto a historical row for a player who has since left and come back.
   */
  /**
   * WRITE ORDER IS THE STATE (2026-08-30). persistEntryHold is fire-and-forget
   * by design, but two forgotten fires can land out of order — and did, in
   * production: a player who sat down in the very seat the big blind was
   * arriving at was registered ('waiting') and released (null) in the same
   * loop iteration, the two HTTP writes raced, and the CLEAR lost. The row
   * then said 'waiting' for a player the engine was actively dealing — which
   * is harmless right up until the next restart, when
   * restoreEntryHoldsFromSeats would re-hold a player who had already paid
   * their way in. Seat 7, table 08746c1a, 2026-08-31 00:27 UTC: entry_hold
   * was still 'waiting' when the seat was evicted ten minutes after the
   * player posted a live big blind. One chain per user, so a user's writes
   * apply in the order the engine decided them; different users still write
   * concurrently. Entries are removed when their chain drains, so the map
   * stays bounded by in-flight writers, not by table lifetime.
   */
  private entryHoldWriteChains: Map<string, Promise<void>> = new Map();

  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  A TABLE THAT CANNOT DEAL HOLDS NOBODY FOR A BLIND
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Waiting for the big blind exists so a newcomer cannot enter behind the
   * blinds and take the button for free. It is a rule about a hand that is
   * being dealt. On a table that is NOT dealing it is a deadlock, and on
   * 2026-09-11 it was holding seven live must-move tables shut:
   *
   *   tbl      | seated | waiting | active | oldest | hands in 30m
   *   2755c54c |      6 |       5 |      1 |  94min |            0
   *   1c45cada |      6 |       5 |      1 |  94min |            0
   *   9e851fff |      6 |       5 |      1 |  94min |            0
   *   1dc09e13 |      4 |       3 |      1 |  94min |            0
   *   e670d636 |      4 |       3 |      1 |  34min |            0
   *   5fceabfd |      2 |       1 |      1 |   7min |            0
   *   140532e7 |      2 |       1 |      1 |   6min |            0
   *
   * Every one of the 129 open cluster tables that was seated-but-not-dealing
   * was a table with a waiter on it, and no other table was stuck: the
   * correlation was exact. The cycle is closed and cannot break itself -
   * `activePlayers` excludes a waiter, so the deal gate sees one player and
   * sleeps; no deal means the big blind never moves; the big blind never
   * moving means the natural release at the top of the loop never fires. The
   * only other way out is the player tapping "post to enter", and these were
   * horses, which never tap. Six funded seats sat at a dead table for an hour
   * and a half while the floor showed the game as running.
   *
   * So: while the table cannot deal, nobody waits. There is no blind in
   * flight to dodge, the next deal is the table's first hand and its blinds
   * post by position - which is exactly what the dealing loop already says
   * about its own first iteration. The released seat is NOT seeded into
   * `dealtInUserIds`: it has never been dealt a hand here, so "a new player
   * never gets the button" still holds on the hand it enters.
   *
   * THIS IS NOT THE FREE RELEASE DAN REVERSED, and the difference is the
   * whole point. Dan 2026-08-26, binding: "Every single player needs to
   * either wait for the BB or post when entering a cash game... no free hands
   * or coming in behind the blinds" - which killed a release that let a
   * waiter in on the NEXT TICK of a running table, behind blinds that had
   * already been posted. Nothing here runs at a running table. The gate above
   * this call has already decided the table cannot deal, so there are no
   * blinds to come in behind and no hand to come in behind it: every seat
   * enters on the same hand and that hand posts its blinds by position,
   * identical to six players opening a brand-new table, which this engine
   * already deals without making anyone wait. `EntryPostingAndButton` still
   * owns the running-table rule and is untouched.
   *
   * Only when the release actually starts the game. If the table would still
   * be short with everyone let in, the hold costs nothing and stays - it is
   * still a real hold for whenever the table fills.
   *
   * @returns how many seats were released, for the caller to log.
   */
  protected releaseWaitersNoBlindCanReach(): number {
    if (this.isTournamentTable()) return 0;
    if (this.waitingForBB.size === 0) return 0;

    // The deal gate's own predicate, minus the one exclusion under test.
    const dealableIgnoringTheWait = this.seatedPlayers.filter(
      (p) =>
        p.stack > 0 &&
        !this.disconnectEngine.isSittingOut(this.tableId, p.user_id) &&
        !this.isHeldForSwap(p.user_id)
    );
    if (dealableIgnoringTheWait.length < this.minPlayersToDeal()) return 0;

    let released = 0;
    for (const p of dealableIgnoringTheWait) {
      if (!this.waitingForBB.has(p.user_id)) continue;
      this.waitingForBB.delete(p.user_id);
      // Same write as the natural big-blind release: the seat owes nothing
      // from here, so a standing post agreement goes with the hold rather
      // than surviving to bill a second blind.
      this.postBBWhenClear.delete(p.user_id);
      this.postingBBToEnter.delete(p.user_id);
      this.persistEntryHold(p.user_id, { hold: null, agreed: false });
      released += 1;
    }
    if (released > 0) {
      console.log(
        `[ServerTableEngine:${this.tableId}] released ${released} seat(s) held for a big blind that could not arrive: ` +
          `${dealableIgnoringTheWait.length} funded seat(s) and nothing being dealt`
      );
    }
    return released;
  }

  protected persistEntryHold(
    userId: string,
    state: { hold: 'waiting' | 'posting' | null; agreed?: boolean }
  ): void {
    if (this.isTournamentTable()) return;
    const patch: Record<string, unknown> = { entry_hold: state.hold };
    if (state.agreed !== undefined) patch.entry_post_agreed = state.agreed;
    /* Promise.resolve() around the builder, deliberately. A PostgREST query
       builder is a THENABLE, not a Promise: it has `.then` and no `.catch`, so
       `void builder.then(...).catch(...)` does not compile — and without the
       `.catch` an unhandled rejection takes the engine down (that is what
       noUnhandledRejections.test.ts pins). Promise.resolve turns the thenable
       into a real Promise, which is the only shape that has both. */
    const prevWrite = this.entryHoldWriteChains.get(userId) ?? Promise.resolve();
    const thisWrite: Promise<void> = prevWrite
      .then(() =>
        Promise.resolve(
          supabase
            .from('table_seats')
            .update(patch)
            .eq('table_id', this.tableId)
            .eq('user_id', userId)
            .is('left_at', null)
        )
      )
      .then(({ error }) => {
        if (error) {
          console.warn(
            `[ServerTableEngine:${this.tableId}] entry hold write failed for ${userId.slice(0, 8)}: ${error.message}`
          );
        }
      })
      // A fire-and-forget promise without a .catch() takes the process down on
      // an unhandled rejection, which for THIS write would mean a transient
      // network blip killing the engine to protect a durability nicety. The
      // in-memory set is still authoritative for the running process, so a
      // lost write costs only restart fidelity.
      .catch((err: unknown) => {
        console.warn(
          `[ServerTableEngine:${this.tableId}] entry hold write threw for ${userId.slice(0, 8)}:`,
          err
        );
      })
      // Drop the chain entry once it drains, IF this write is still the tail —
      // a later write may have chained past it already, and deleting that one
      // would let the write after it start unordered. Runs after the .catch,
      // so this promise can never reject.
      .then(() => {
        if (this.entryHoldWriteChains.get(userId) === thisWrite) {
          this.entryHoldWriteChains.delete(userId);
        }
      });
    this.entryHoldWriteChains.set(userId, thisWrite);
  }

  /**
   * PUT THE HOLD BACK, ONCE, ON BOOT.
   *
   * The counterpart of persistEntryHold. Runs exactly once per process — NOT
   * on every pass like `restoreSitOutsFromSeats`, and the difference matters:
   * sit-out state is a fact the database owns continuously, whereas an entry
   * hold is released by the engine itself mid-orbit. Re-reading it every pass
   * would race the fire-and-forget write that clears it and re-hold a player
   * the engine had just let in.
   *
   * A restored waiter is deliberately NOT added to `dealtInUserIds` by the
   * caller. They have never been dealt a hand here, so they must not be
   * button-eligible; that is half the hole this closes.
   */
  protected restoreEntryHoldsFromSeats(): void {
    if (this.entryHoldsRestored) return;
    this.entryHoldsRestored = true;
    if (this.isTournamentTable()) return;

    let restored = 0;
    for (const p of this.seatedPlayers) {
      const hold = (p as { entry_hold?: string | null }).entry_hold ?? null;
      const agreed = (p as { entry_post_agreed?: boolean | null }).entry_post_agreed === true;
      if (hold === 'waiting') {
        this.waitingForBB.add(p.user_id);
        if (agreed) this.postBBWhenClear.add(p.user_id);
        restored += 1;
      } else if (hold === 'posting') {
        // They paid to come in and the restart landed before the deal that
        // bills it. Put the debt back rather than the hold: they are entitled
        // to the next hand, and they owe the live big blind for it.
        this.postingBBToEnter.add(p.user_id);
        restored += 1;
      } else if (hold === 'moved') {
        // Moved here by the game (must-move / break) and the restart landed
        // before this table's first deal read the marker: they are dealt in
        // owing nothing, exactly as the arrival path would have done, and the
        // marker is cleared so nothing reads it twice.
        this.persistEntryHold(p.user_id, { hold: null, agreed: false });
      }
    }

    if (restored > 0) {
      console.log(
        `[ServerTableEngine:${this.tableId}] Restored ${restored} cash entry hold(s) from table_seats`
      );
    }
  }

  /**
   * PUT THE BUTTON BACK WHERE IT WAS.
   *
   * Dan 2026-08-25, BINDING: "IN THE EVENT OF AN ENGINE RESTART, WHILE PLAY IS
   * RUNNING, IT MUST ALWAYS RESTART IN THE SAME POSITION... EVERYTHING RESTARTS
   * EXACTLY AS IT WAS BEFORE THE RESTART."
   *
   * `lastButtonSeat` is declared `= 0` and nothing ever restored it. The
   * rotation reads that as "no hand dealt yet" and falls back to
   * `buttonSeats[0]` — THE LOWEST OCCUPIED SEAT NUMBER. So every engine restart
   * threw the button backwards to seat 1 regardless of where it actually was,
   * and the blinds were taken again from whoever sat in the seats behind it.
   * A player could pay the big blind, watch the engine restart, and pay it
   * again on the next hand. On a busy table that is real money, silently, every
   * deploy.
   *
   * The seat was already being written to `hand_history.button_seat` on every
   * settled hand and read by nobody (100% populated in production). Reading it
   * back costs one indexed row and closes the hole with no schema change.
   *
   * Deliberately NOT fatal: a table that cannot read its history still deals.
   * Losing the button costs one orbit of position; refusing to start costs the
   * whole table.
   */
  private async restoreButtonFromHistory(): Promise<void> {
    try {
      // Same (table_id, hand_number DESC) index seedHandCountFromHistory uses.
      const { data, error } = await supabase
        .from('hand_history')
        .select('button_seat, players')
        .eq('table_id', this.tableId)
        .order('hand_number', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Could not restore button seat (${error.message}) - ` +
            `it will start at the lowest occupied seat and blinds may be re-taken for one orbit.`
        );
        return;
      }

      const row = data as { button_seat?: number; players?: Array<{ seat?: number }> } | null;
      const seat = Number(row?.button_seat ?? 0);
      /**
       * The big blind seat comes back with the button, derived from the same
       * row rather than stored separately: `players` carries the seats that
       * were dealt in and `button_seat` says where the button was, which is
       * all the blind walk needs. Without it a restart between two heads-up
       * hands leaves lastBigBlindSeat at 0, the dead-button rule stands down,
       * and the very bug it fixes reappears for one hand on every deploy.
       */
      const seats = Array.isArray(row?.players)
        ? row.players
            .map((p) => Number(p?.seat))
            .filter((s) => Number.isFinite(s) && s > 0)
            .sort((a, b) => a - b)
        : [];
      if (seats.length >= 2 && Number.isFinite(seat) && seat > 0) {
        const nextOf = (from: number) => seats.find((s) => s > from) ?? seats[0];
        const sb = seats.length === 2 ? seat : nextOf(seat);
        this.lastBigBlindSeat = nextOf(sb);
      }
      if (Number.isFinite(seat) && seat > 0) {
        this.lastButtonSeat = seat;
        console.log(
          `[ServerTableEngine:${this.tableId}] Button restored to seat ${seat} from the last settled hand`
        );
      }
    } catch (err) {
      console.warn(
        `[ServerTableEngine:${this.tableId}] Button restore threw (${(err as Error)?.message}) - ` +
          `starting from the lowest occupied seat.`
      );
    }
  }

  /**
   * Check for an incomplete hand snapshot on server startup.
   * If found, log it for now — full resume requires reconstructing HandController
   * from serialized state, which is a future enhancement.
   */
  async checkCrashRecovery(): Promise<boolean> {
    // Phase 1.2 PR-D: use the extended snapshot reader so pending deadlines
    // and disconnect states come back with the hand state. Full HandController
    // reconstruction still waits for a later PR; for now we log visibility
    // into what would rehydrate + mark the orphaned hand complete.
    const snapshot = await getActiveHandSnapshotFull(this.tableId);
    if (!snapshot) return false;

    /**
     * B10 FIX (2026-08-20): actually USE the persisted disconnect states.
     *
     * They were written on every snapshot and read back only to be counted in
     * this log line. The engine then restarted believing every seated player
     * was connected, so anyone who had dropped before the crash was handed a
     * full turn clock on every orbit until the heartbeat checker re-detected
     * them — the table paying that player's entire think-time, every hand, for
     * no reason.
     *
     * The HAND is still not resumed, and that remains the right call: players
     * keep their last-known stacks and a fresh hand is dealt. But connectivity
     * is a property of the PLAYER, not of the abandoned hand, so it survives.
     *
     * pending_deadlines is deliberately NOT rehydrated: every one of those
     * deadlines belongs to the hand we are about to abandon, so reinstating
     * them would fire turn timers for a hand that no longer exists. It is kept
     * in the snapshot for forensics (and for the full-resume work in PR-E),
     * which is why it is counted here rather than dropped from the write.
     */
    const restoredFsm = this.disconnectEngine.restoreFsmStates(
      this.tableId,
      snapshot.disconnectStates
    );

    console.warn(
      `[ServerTableEngine:${this.tableId}] CRASH RECOVERY: Found incomplete hand #${snapshot.handNumber} ` +
        `(stage: ${snapshot.stage}, last updated: ${snapshot.updatedAt}). ` +
        `${snapshot.pendingDeadlines.length} pending deadlines (not rehydrated - they belong to the abandoned hand), ` +
        `${Object.keys(snapshot.disconnectStates).length} disconnect-FSM entries, ${restoredFsm} restored. ` +
        `Marking hand complete and starting fresh - players retain their last-known stacks.`
    );

    // For now: mark the orphaned hand as complete so we don't get stuck.
    // Full state reconstruction (rebuilding HandController from snapshot) is
    // tracked in Phase 1.2 PR-E. The snapshot data IS preserved in the DB
    // for manual recovery/auditing if needed.
    await completeHandSnapshot(this.tableId, snapshot.handNumber);

    // Set handCount to continue from where we left off
    this.handCount = snapshot.handNumber;

    return true;
  }

  // ── Implemented by ServerTableEngineSeating (layer 2/8) ──
  protected abstract resolveOrphanedAddOns(): Promise<void>;
  protected abstract processPendingAddOns(players: SeatedPlayer[]): Promise<void>;

  // ── Implemented by ServerTableEngineTurns (layer 3/8) ──
  protected abstract clearTurnTimer(): void;
  protected abstract rearmTurnTimerIfCurrent(userId: string): void;
  protected abstract handlePlayerDisconnectedMidTurn(userId: string): void;

  // ── Implemented by ServerTableEngineDealing (layer 5/8) ──
  protected abstract dealingLoop(): Promise<void>;
  abstract rePushHoleCards(userId: string): Promise<void>;

  // ── Implemented by ServerTableEngineHandEvents (layer 7/8) ──
  protected abstract handleHandEvent(
    event: HandEvent,
    players: SeatedPlayer[],
    persistenceGeneration?: number
  ): Promise<void>;

  // ── Implemented by ServerTableEngine (layer 8/8) ──
  protected abstract broadcastCurrentState(): Promise<void>;
}
