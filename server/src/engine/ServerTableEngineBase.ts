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
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { ServerActionValidator } from './ServerActionValidator.js';
import { StateVerifier } from './StateVerifier.js';
import { TimeBankEngine, type TimeBankEvent } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreActionEngine } from './PreActionEngine.js';
import { AtomicStackService } from './AtomicStackService.js';
import { StraddleEngine } from './StraddleEngine.js';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import { InsuranceEngine, type InsuranceSettlement } from './InsuranceEngine.js';
import { ShadowRecorder } from './eventlog/ShadowRecorder.js';
import type { BlindKind } from './eventlog/events.js';
import * as EngineMetrics from '../observability/engineInstruments.js';
import type { Span as EngineSpan } from '../observability/Tracing.js';
import { RakebackEngine } from './RakebackEngine.js';
import { ChipRaceEngine } from './ChipRaceEngine.js';
import { TableBalancer } from './TableBalancer.js';
import { TableBreakEngine } from './TableBreakEngine.js';
import { EngineTelemetry } from './EngineTelemetry.js';
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
  saveHandSnapshotExtras,
  getActiveHandSnapshotFull,
  supabase,
} from '../services/supabase.js';
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
import type { TableStateHub } from '../transport/TableStateHub.js';
import {
  createTableStateMachine,
  createTurnStateMachine,
  type TurnFSMState,
} from './StateMachine.js';
import type { StateMachine } from './StateMachine.js';
import type { TableStatus } from '../types.js';

export abstract class ServerTableEngineBase {
  protected tableId: string;
  protected running: boolean = false;
  /** Bible V8 §3.1: Formal Table State Machine with entry/exit/fail conditions */
  protected tableFSM: StateMachine<TableStatus> = createTableStateMachine('empty');
  /** Bible V8 §3.2: Formal Turn State Machine — unifies timer/timebank/preaction/disconnect */
  protected turnFSM: StateMachine<TurnFSMState> = createTurnStateMachine('waiting');
  protected handCount: number = 0;
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
  protected dealerSeatIndex: number = 0;
  // AUDIT FIX 2026-07-19: the button is tracked by SEAT NUMBER (not an array
  // index) so roster changes (bust/leave/join) can't move it backward, skip a
  // seat, or double-post a blind. 0 = no hand dealt yet.
  protected lastButtonSeat: number = 0;
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

  // Bible V8 §4.2: Track every userId we've ever seen seated at this table.
  // Used by the dealing loop to detect new joiners after the engine has started
  // dealing hands — new joiners must wait for the BB to reach their seat
  // (or opt to post the BB immediately via POST /post-bb).
  protected knownPlayerIds: Set<string> = new Set();

  // Guard for the dealing loop's first iteration. On the first pass — whether
  // this is a cold start or a crash-recovery resume — every currently-seated
  // player is treated as an initial/existing player and is NOT flagged as
  // waiting-for-BB. Flagging only begins on iteration two and onward.
  protected dealingLoopFirstIteration: boolean = true;

  // Bible V8 §6.17: Admin pause/maintenance lock — prevents new hands from starting
  protected adminPauseLock: boolean = false;
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
   * A2: does the durable `table_pending_addons` ledger need a sweep?
   *
   * Starts true so a freshly started engine always checks once for rows a dead
   * predecessor left behind. Set true again whenever a mid-hand add-on is
   * debited or a resolve fails; cleared only after a sweep that leaves zero
   * unresolved rows. This keeps the steady-state cost at zero extra queries per
   * hand while making it impossible for an open row to be forgotten.
   */
  protected pendingAddOnSweepNeeded = true;
  /** C15: minimum gap between persisted hand snapshots, per table. */
  protected static readonly SNAPSHOT_MIN_INTERVAL_MS = 1000;
  protected lastSnapshotAtMs = 0;
  protected snapshotDirty = false;
  protected snapshotTimer: ReturnType<typeof setTimeout> | null = null;

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
  // Round 38: track wall-clock start so logHandHistory can write started_at +
  // ended_at (was missing — every completed hand_history row had null
  // ended_at, breaking replay timestamps and audit reconciliation).
  protected currentHandStartedAt: number = 0;
  // Bible V8 §2.5: Action Record requires seat, userId, action, amount, timestamp, stage
  protected currentHandActions: {
    seat: number;
    userId: string;
    action: string;
    amount?: number;
    timestamp: number;
    stage: string;
  }[] = [];
  protected currentHandWinners: {
    userId: string;
    amount: number;
    potIndex?: number;
    hand?: { name: string; ranking: number };
  }[] = [];
  protected currentHandContributions: Map<string, number> = new Map(); // userId → totalInvested
  protected currentHandInsuranceSettlements: InsuranceSettlement[] = [];
  protected currentHandBBJHit: BBJDetectionResult | null = null;
  protected currentHandBBJPayoutConfig: ServerRakeConfigResult | null = null;
  /** Remaining deck cards at hand completion — used for Rabbit Hunt reveal */
  protected currentHandRabbitCards: import('../types.js').Card[] = [];
  protected currentHandShowdownResults: Array<{
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards: Array<{ rank: string; suit: string }>;
  }> = [];
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
  // Hand complete callback for tournament chip sync
  protected handCompleteCallback:
    | ((tableId: string, players: { user_id: string; stack: number }[]) => void)
    | null = null;
  // Hand-for-hand pause: set by tournament manager, checked between hands
  protected handForHandPaused: boolean = false;
  /** Wall-clock when the current by-design pause began; 0 when not paused. */
  protected pausedSinceMs: number = 0;
  /** Last time the paused-too-long alarm fired, so it reports once per window. */
  protected lastPauseAlarmAtMs: number = 0;
  protected handForHandResolve: (() => void) | null = null;

  // Bible V8 §1.1.4: Action serialization lock — prevents parallel action processing
  protected actionLock: boolean = false;

  // FIX 211: Bible V8 §1.9 — Track postHandTasks promise to prevent next hand
  // starting before DB stacks are synced (was fire-and-forget, risked stale stacks)
  protected postHandTasksPromise: Promise<void> | null = null;

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

  /** 15s clock + 15s time bank + 2s grace + slack. */
  protected static readonly WATCHDOG_STALL_MS = 45_000;

  /** No hand started while the table is dealable. */
  protected static readonly WATCHDOG_IDLE_MS = 90_000;
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
  protected showHandPlayers: Set<string> | null = null; // Bible V8 §4.21: players who voluntarily show hand

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
  protected disconnectEngine: DisconnectEngine;
  protected preActionEngine: PreActionEngine;
  protected atomicStackService: AtomicStackService;

  // ── Step 6: Ported Advanced Modules ──
  protected straddleEngine: StraddleEngine;
  protected runItTwiceEngine: RunItTwiceEngine;
  protected insuranceEngine: InsuranceEngine;
  protected rakebackEngine: RakebackEngine;

  // ── Step 7: Ported Tournament & Extras Modules ──
  protected chipRaceEngine: ChipRaceEngine;
  protected tableBalancer: TableBalancer;
  protected tableBreakEngine: TableBreakEngine;
  protected engineTelemetry: EngineTelemetry;

  constructor(tableId: string) {
    this.tableId = tableId;

    // Initialize ported core modules
    this.preciseTimer = new PreciseActionTimer((event) => {
      console.log(
        `[ServerTableEngine:${tableId}] Timer event: ${event.type} player=${event.playerId}`
      );
    });
    this.actionValidator = new ServerActionValidator((event) => {
      console.warn(
        `[ServerTableEngine:${tableId}] Action rejected: ${event.code} — ${event.reason}`
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
    });
    this.atomicStackService = new AtomicStackService((event) => {
      console.log(`[ServerTableEngine:${tableId}] Stack: ${event.type}`);
    });

    // Step 6: Initialize advanced modules
    this.straddleEngine = new StraddleEngine((event) => {
      console.log(`[ServerTableEngine:${tableId}] Straddle: ${event.type}`);
    });
    this.runItTwiceEngine = new RunItTwiceEngine((event) => {
      console.log(`[ServerTableEngine:${tableId}] RIT: ${event.type}`);
    });
    this.insuranceEngine = new InsuranceEngine((event) => {
      console.log(`[ServerTableEngine:${tableId}] Insurance: ${event.type}`);
    });
    this.rakebackEngine = new RakebackEngine(supabase, (event) => {
      console.log(`[ServerTableEngine:${tableId}] Rakeback: ${event.type}`);
    });

    // Step 7: Initialize tournament & extras modules
    this.chipRaceEngine = new ChipRaceEngine((event) => {
      console.log(`[ServerTableEngine:${tableId}] ChipRace: ${event.type}`);
    });
    this.tableBalancer = new TableBalancer((event) => {
      console.log(`[ServerTableEngine:${tableId}] TableBalancer: ${event.type}`);
    });
    this.tableBreakEngine = new TableBreakEngine((event) => {
      console.log(`[ServerTableEngine:${tableId}] TableBreak: ${event.type}`);
    });
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
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log(`[ServerTableEngine:${this.tableId}] Starting...`);

    try {
      const tableData = await loadTable(this.tableId);
      this.tableInfo = tableData as TableInfo;

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

      // ═══════════════════════════════════════════════════════════════════════
      // FIX 92: MUTUAL EXCLUSION — RIT and Insurance CANNOT coexist on the
      // same table. Per Dan: "RUN IT TWICE AND INSURANCE ARE NOT ALLOWED ON
      // THE SAME TABLE." If both are enabled in DB, insurance takes priority
      // (it's the more complex feature). RIT is disabled.
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
      // TOURNAMENT GATE 2026-08-18: RIT is a cash/club-game feature. Running
      // it twice in a tournament is both non-standard (no major app offers
      // it in MTTs) and numerically unsound here: per-board splits produce
      // fractional amounts while tournament_players.chips is INTEGER (the
      // sync floors, destroying chips - see POSTGRES_INTEGER_CAST_FLOOD).
      // A live 3-run tournament hand (41627f9a, 02:11 UTC) split 1760.88
      // into 586.96/1173.92 tournament chips before this gate went in.
      const ritIsTournament =
        !!this.tableInfo.tournament_id || this.tableInfo.game_type === 'tournament';
      const ritEnabled =
        !ritIsTournament &&
        (((this.tableInfo.run_it_twice ?? true) && (this.tableInfo.allow_run_it_twice ?? true)) ||
          (this.tableInfo.run_it_twice_enabled ?? false));
      const insuranceEnabled = this.tableInfo.insurance_enabled ?? false;
      const ritEffective = ritEnabled && !insuranceEnabled; // Insurance takes priority

      if (ritEnabled && insuranceEnabled) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] MUTUAL EXCLUSION: Both RIT and Insurance enabled — disabling RIT. These features cannot coexist.`
        );
      }

      // Bible V8 §4.20 + FIX 98: Configure Run It Twice engine
      // Chooser gets 5s, responders get 10s — per Dan's rules
      this.runItTwiceEngine.configure(this.tableId, {
        enabled: ritEffective,
        autoDeclineTimeout: 10,
        maxRuns: 3, // Support up to 3 boards (Dan's rules: player can choose 1/2/3)
        chooserTimeout: 5,
        responderTimeout: 10,
      });

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

      // FIX 104 → RAKE-AUDIT 2026-07-24: RakebackEngine is DISABLED. Its
      // in-memory accumulator was never flushed anywhere (settleRakeback has
      // zero callers), its tier table conflicts with the authoritative
      // RakebackSettlerService tiers, and with enabled:true it grew an
      // unbounded per-player Map on every raked hand — a slow memory leak that
      // paid out nothing. Durable rakeback runs exclusively through
      // rake_records → RakebackSettlerService (30-min daemon + weekly close).
      if (this.tableInfo.club_id) {
        this.rakebackEngine.configure(this.tableInfo.club_id, {
          enabled: false,
        });
      }

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

      // FIX 137: Bible V8 §7.17 — Check for interrupted hand from a server crash
      const recovered = await this.checkCrashRecovery();
      if (recovered) {
        console.log(
          `[ServerTableEngine:${this.tableId}] Crash recovery complete — resuming from hand #${this.handCount}`
        );
      }

      // Bible V8 §3.1: Table FSM — empty → waiting (engine started, waiting for players)
      this.tableFSM.transition('waiting');

      // Wait for minimum 2 players
      while (this.running) {
        this.seatedPlayers = await loadSeatedPlayers(this.tableId);
        if (this.seatedPlayers.length >= 2) break;
        console.log(
          `[ServerTableEngine:${this.tableId}] Waiting for players... (${this.seatedPlayers.length}/2)`
        );
        await this.sleep(5000);
      }

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
      this.dealingLoop().catch((err) => {
        reportError(err, 'ServerTableEngine.' + this.tableId + '.dealingLoop_died');
        this.killForRestart('dealing_loop_threw');
      });
    } catch (err) {
      reportError(err, 'ServerTableEnginethistableId.Failed_to_start');
      this.running = false;
    }
  }

  /**
   * Stop the engine
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Bible V8 §3.1: Table FSM — running/waiting → closing → closed
    this.tableFSM.transition('closing');

    this.clearTurnTimer();
    // C15: flush any coalesced snapshot BEFORE dropping the controller — after
    // handController is null saveSnapshot() early-returns, so a pending write
    // would be silently lost on every shutdown.
    await this.flushSnapshot();
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    this.handController = null;

    // FIX 147 + Phase 1.2 PR-G-real: tear down heartbeat scheduler entry.
    // Set the flag first so any callback already mid-flight bails before
    // re-arming, then cancel the pending entry.
    this.heartbeatActive = false;
    deadlineScheduler.cancel(this.tableId, ServerTableEngineBase.HEARTBEAT_EVENT_ID);

    // Step 4: Dispose ported core modules
    this.preciseTimer.dispose();
    this.actionValidator.dispose();
    this.stateVerifier.dispose();

    // Step 5: Dispose supporting modules
    this.timeBankEngine.disposeAll();
    this.disconnectEngine.disposeAll();
    this.preActionEngine.disposeAll();
    this.atomicStackService.dispose();

    // Step 6: Dispose advanced modules
    this.straddleEngine.disposeAll();
    this.runItTwiceEngine.disposeAll();
    this.insuranceEngine.disposeAll();
    this.rakebackEngine.disposeAll();

    // Step 7: Dispose tournament & extras modules
    this.engineTelemetry.dispose();
    // Note: chipRaceEngine, tableBalancer, tableBreakEngine are stateless per-call — no dispose needed

    // Phase 1.1 PR-5: no Supabase channel to clean up — engine WS is now the
    // only game-state transport. TableStateHub.dropTable is called by the
    // discovery / tournament-break paths elsewhere.
    // Bible V8 §3.1: Table FSM — closing → closed (cleanup complete)
    this.tableFSM.transition('closed');

    console.log(`[ServerTableEngine:${this.tableId}] Stopped. Dealt ${this.handCount} hands.`);
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
  }

  /** Ms since this table last did anything observable. */
  msSinceProgress(): number {
    return Date.now() - this.lastProgressAtMs;
  }

  /**
   * Overridden in ServerTableEngineTurns, which is the first subclass with
   * access to the turn timer and the hand controller. No-op here so Base can
   * drive it from the heartbeat without a circular dependency.
   */
  protected runTableWatchdog(): void {}

  /**
   * Mark the engine dead so GameServer's reaper deletes it and discovery
   * rebuilds a fresh one on the next 5s cycle (crash recovery rehydrates from
   * hand_state_snapshots). Leaving `running` true is what turned every
   * transient stall into a permanent one.
   */
  protected killForRestart(reason: string): void {
    reportError(
      new Error('Engine self-terminating for restart: ' + reason),
      'ServerTableEngine.' + this.tableId + '.watchdog_kill',
      { handCount: this.handCount }
    );
    this.recordRecoveryEvent('watchdog_kill_rebuild', reason);
    this.running = false;
    this.heartbeatActive = false;
    deadlineScheduler.cancel(this.tableId, ServerTableEngineBase.HEARTBEAT_EVENT_ID);
    this.preciseTimer.clearTable(this.tableId);
    // preciseTimer.clearTable only covers `turn:*`. insurance_offer:*, rit_offer
    // and table_break:* live on the same shared scheduler under this tableId and
    // would otherwise fire callbacks bound to this dead engine instance forever.
    deadlineScheduler.cancelAll(this.tableId);
    this.handController = null;
  }

  isRunning(): boolean {
    return this.running;
  }
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
    return this.seatedPlayers.filter(
      (p) =>
        p.stack > 0 &&
        !this.disconnectEngine.isSittingOut(this.tableId, p.user_id) &&
        !this.waitingForBB.has(p.user_id)
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

  /** Drill-only public wrapper over the protected killForRestart path. */
  killForRestartPublic(reason: string): void {
    this.killForRestart(reason);
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

  // Bible V8 §10.4 — Prometheus text exposition format
  getPrometheusMetrics(): string {
    return this.engineTelemetry.getPrometheusMetrics();
  }

  onHandComplete(
    callback: (tableId: string, players: { user_id: string; stack: number }[]) => void
  ): void {
    this.handCompleteCallback = callback;
  }

  /** Pause dealing after current hand finishes (for hand-for-hand) */
  pauseAfterHand(): void {
    this.handForHandPaused = true;
    if (this.pausedSinceMs === 0) this.pausedSinceMs = Date.now();
  }

  /** Resume dealing (all tables finished their hand-for-hand hand) */
  resumeDealing(): void {
    this.handForHandPaused = false;
    this.pausedSinceMs = 0;
    this.lastPauseAlarmAtMs = 0;
    // Bible V8 §3.1: Table FSM — paused → running
    if (this.tableFSM.state === 'paused') {
      this.tableFSM.transition('running');
    }
    if (this.handForHandResolve) {
      this.handForHandResolve();
      this.handForHandResolve = null;
    }
  }

  /** Check if engine is currently waiting for hand-for-hand resume */
  isWaitingForHandForHand(): boolean {
    return this.handForHandPaused && this.handForHandResolve !== null;
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
    return this.handForHandPaused || this.tableFSM.state === 'paused';
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
  protected recordRecoveryEvent(event: string, detail: string): void {
    try {
      void Promise.resolve(
        supabase.from('engine_recovery_events').insert({
          table_id: this.tableId,
          event,
          detail: detail.slice(0, 500),
          hand_count: this.handCount,
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
  /** Table max buy-in (DB value or 200×BB fallback). */
  protected getMaxBuyIn(): number {
    return this.tableInfo?.max_buy_in
      ? Number(this.tableInfo.max_buy_in)
      : (this.tableInfo?.big_blind || 2) * 200;
  }
  protected pineappleDiscardTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Pending horse think-time timer. Tracked so it can be cancelled — a stray
   * horse action scheduled for a hand that has since ended is a real hazard
   * (the callback's identity guards catch it, but an untracked timer cannot be
   * cleared on teardown), and freeze drills need to suppress the horse action
   * to reproduce a genuine stall rather than one the horse papers over.
   */
  protected horseActionTimer: ReturnType<typeof setTimeout> | null = null;

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
  protected getBBSeatIndex(): number {
    // Roster that CAN hold the button/blinds this hand: has chips and isn't
    // sitting out. Waiting-for-BB players are included so the moving BB can
    // reach their seat and trigger release.
    const roster = this.seatedPlayers.filter(
      (p) => p.stack > 0 && !this.disconnectEngine.isSittingOut(this.tableId, p.user_id)
    );
    if (roster.length < 2) return -1;
    const sortedSeats = roster.map((p) => p.seat_number).sort((a, b) => a - b);
    const nextButton =
      this.lastButtonSeat > 0 ? this.getNextSeat(this.lastButtonSeat, roster) : sortedSeats[0];
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
   * Re-read the table's and club's rake settings so an owner's change takes
   * effect without restarting the engine. Called at the top of each hand and
   * throttled — tableInfo is otherwise loaded once per engine lifetime, and at
   * 500+ live tables a per-hand read of two rows is real load for a value that
   * changes perhaps twice a year.
   *
   * Deliberately best-effort: on any error the previous values stand.
   */
  protected async refreshRakeConfig(force = false): Promise<void> {
    if (!this.tableInfo || this.isTournamentTable()) return;
    const now = Date.now();
    if (!force && now - this.lastRakeRefreshAtMs < RAKE_CONFIG_TTL_MS) return;
    this.lastRakeRefreshAtMs = now;
    try {
      const { data: tableRow } = await supabase
        .from('tables')
        .select('rake_percent, rake_cap_bb')
        .eq('id', this.tableId)
        .maybeSingle();
      if (tableRow && this.tableInfo) {
        this.tableInfo.rake_percent = tableRow.rake_percent ?? undefined;
        this.tableInfo.rake_cap_bb = tableRow.rake_cap_bb ?? undefined;
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
   * saveSnapshot() serializes the whole hand state and does one or two upserts.
   * It was fired after EVERY accepted action — 20 to 80 writes per hand per
   * table — which at 500+ tables is enough on its own to saturate the connection
   * pool. And it buys very little today: rehydrate() is never called and
   * checkCrashRecovery() abandons in-flight hands (see B10), so the snapshot's
   * only live consumers are forensics and getActiveHandSnapshot.
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

  /** Write now if anything changed since the last write. Safe to call spuriously. */
  protected async flushSnapshot(): Promise<void> {
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = null;
    }
    if (!this.snapshotDirty) return;
    this.snapshotDirty = false;
    this.lastSnapshotAtMs = Date.now();
    try {
      await this.saveSnapshot();
    } catch {
      /* snapshotting must never affect gameplay */
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
      gameVariant: this.tableInfo.game_variant as GameVariant,
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
    });

    // Phase 1.2 PR-D: pending deadlines.
    // Phase 1.2 PR-E: disconnect FSM states.
    // Both live on the same snapshot row. Skip the UPDATE if there's
    // nothing to write — saves an unnecessary round-trip for idle tables.
    const pendingDeadlines = deadlineScheduler.persistPending(this.tableId);
    const disconnectStates = this.disconnectEngine.getFsmStatesForTable(this.tableId);
    if (pendingDeadlines.length > 0 || Object.keys(disconnectStates).length > 0) {
      await saveHandSnapshotExtras({
        tableId: this.tableId,
        handNumber: this.handCount,
        pendingDeadlines,
        disconnectStates,
      });
    }
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
          `[ServerTableEngine:${this.tableId}] Could not seed hand counter (${error.message}) — ` +
            `continuing from #${this.handCount}. Hand numbers may repeat for this table.`
        );
        return;
      }

      const last = Number((data as { hand_number?: number } | null)?.hand_number ?? 0);
      // Never move the counter backwards.
      if (Number.isFinite(last) && last > this.handCount) {
        this.handCount = last;
        console.log(
          `[ServerTableEngine:${this.tableId}] Hand counter resumed at #${this.handCount} (next hand: #${this.handCount + 1})`
        );
      }
    } catch (err) {
      console.warn(
        `[ServerTableEngine:${this.tableId}] Hand counter seed threw (${(err as Error)?.message}) — ` +
          `continuing from #${this.handCount}.`
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

    console.warn(
      `[ServerTableEngine:${this.tableId}] CRASH RECOVERY: Found incomplete hand #${snapshot.handNumber} ` +
        `(stage: ${snapshot.stage}, last updated: ${snapshot.updatedAt}). ` +
        `${snapshot.pendingDeadlines.length} pending deadlines, ` +
        `${Object.keys(snapshot.disconnectStates).length} disconnect-FSM entries. ` +
        `Marking hand complete and starting fresh — players retain their last-known stacks.`
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

  // ── Implemented by ServerTableEngineTurns (layer 3/8) ──
  protected abstract clearTurnTimer(): void;
  protected abstract rearmTurnTimerIfCurrent(userId: string): void;

  // ── Implemented by ServerTableEngineDealing (layer 5/8) ──
  protected abstract dealingLoop(): Promise<void>;
  abstract rePushHoleCards(userId: string): Promise<void>;

  // ── Implemented by ServerTableEngineHandEvents (layer 7/8) ──
  protected abstract handleHandEvent(event: HandEvent, players: SeatedPlayer[]): Promise<void>;

  // ── Implemented by ServerTableEngine (layer 8/8) ──
  protected abstract broadcastCurrentState(): Promise<void>;
}
