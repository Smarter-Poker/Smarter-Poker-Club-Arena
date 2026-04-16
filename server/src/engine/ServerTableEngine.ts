/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SERVER TABLE ENGINE — Server-Side Dealer for a Single Table
 * ═══════════════════════════════════════════════════════════════════════════════
 * Runs the complete dealing pipeline for one table on the SERVER.
 * NO browser. NO React. NO window. Pure Node.js.
 *
 * - Loads table config, seated players, and horses from Supabase
 * - Manages HandController lifecycle
 * - Executes horse AI decisions with millisecond-level think times
 * - Auto-rebuys busted horses from Player Wallet
 * - Broadcasts hand state via Supabase Realtime
 * - Multiple instances run simultaneously (one per table)
 */

import { HandController } from './HandController.js';
import { HorseLogic } from './HorseLogic.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';
import { ServerActionValidator } from './ServerActionValidator.js';
import { StateVerifier } from './StateVerifier.js';
import { TimeBankEngine } from './TimeBankEngine.js';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreActionEngine } from './PreActionEngine.js';
import { AtomicStackService, type StackSettlement } from './AtomicStackService.js';
import { StraddleEngine } from './StraddleEngine.js';
import { MixedGameEngine } from './MixedGameEngine.js';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import { InsuranceEngine, type InsuranceSettlement } from './InsuranceEngine.js';
import { monteCarloEquity } from './MonteCarloEquity.js';
import { evaluateHand, evaluateOmahaHand, compareHands } from './PokerEngine.js';
import { RakebackEngine } from './RakebackEngine.js';
import { ChipRaceEngine } from './ChipRaceEngine.js';
import { TableBalancer } from './TableBalancer.js';
import { TableBreakEngine } from './TableBreakEngine.js';
import { OFCDealingOrchestrator } from './OFCDealingOrchestrator.js';
import { EngineTelemetry } from './EngineTelemetry.js';
import {
  getFullRakeConfig,
  calculateBBJFee,
  detectBBJHit,
  getPlayerCountCaps,
  type BBJDetectionResult,
  type ServerRakeConfigResult,
} from '../config/RakeConfig.js';
import type { ValidationContext } from './ServerActionValidator.js';
import {
  loadTable,
  loadSeatedPlayers,
  syncStacks,
  syncTournamentChips,
  updateTableStatus,
  autoRebuyHorse,
  markSeatAsLeft,
  atomicCashout,
  processLeavePending,
  logRakeCollection,
  logBBJCollection,
  logInsuranceSettlement,
  logHandHistory,
  processBBJPayout,
  saveHandStateSnapshot,
  completeHandSnapshot,
  getActiveHandSnapshot,
  // Phase 1.2 PR-D
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
  HorseStyle,
  HorseDecision,
  RakeConfig,
} from '../types.js';
import { reportError } from '../services/errorReporter.js';
import type { TableStateHub } from '../transport/TableStateHub.js';

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER TABLE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export class ServerTableEngine {
  private tableId: string;
  private running: boolean = false;
  private handCount: number = 0;
  private handController: HandController | null = null;
  /**
   * Phase 1.1 PR-2: Authoritative state hub for native-WS delivery to clients.
   * When set, every broadcastCurrentState() publishes to the hub in parallel
   * with the legacy Supabase Realtime broadcast. Injected by the GameServer
   * at engine construction. null in unit tests / until PR-2 wiring lands.
   */
  private hub: TableStateHub | null = null;
  private tableInfo: TableInfo | null = null;
  private seatedPlayers: SeatedPlayer[] = [];
  private dealerSeatIndex: number = 0;
  private consecutiveErrors: number = 0;

  // Bankroll Management: Track how many times a horse has re-bought at this table.
  // Max is 2 rebuys (meaning 3 total buy-ins). If they bust a 3rd time, they leave.
  private horseRebuys: Map<string, number> = new Map();

  // Bible V8 §4.2: Track players returning from sit-out who must post dead blind
  private returningFromSitout: Set<string> = new Set();

  // FIX 143: Bible V8 §7.12: Deferred sit-out — can't fold mid-hand
  // Players who request sit-out during an active hand are queued here.
  // The sit-out is applied AFTER the current hand completes in postHandTasks().
  private pendingSitOut: Set<string> = new Set();

  // Per-hand tracking
  private currentHandWentToFlop: boolean = false;
  private currentHandPotSize: number = 0;
  private currentHandDealerSeat: number = 0;
  private currentHandWinnerIds: string[] = [];
  private currentHandRake: number = 0;
  private currentHandBBJFee: number = 0;
  private currentHandCommunityCards: string[] = [];
  // Bible V8 §2.5: Action Record requires seat, userId, action, amount, timestamp, stage
  private currentHandActions: {
    seat: number;
    userId: string;
    action: string;
    amount?: number;
    timestamp: number;
    stage: string;
  }[] = [];
  private currentHandWinners: { userId: string; amount: number; potIndex?: number; hand?: { name: string; ranking: number } }[] = [];
  private currentHandContributions: Map<string, number> = new Map(); // userId → totalInvested
  private currentHandInsuranceSettlements: InsuranceSettlement[] = [];
  private currentHandBBJHit: BBJDetectionResult | null = null;
  private currentHandBBJPayoutConfig: ServerRakeConfigResult | null = null;
  /** Remaining deck cards at hand completion — used for Rabbit Hunt reveal */
  private currentHandRabbitCards: import('../types.js').Card[] = [];
  private currentHandShowdownResults: Array<{
    userId: string;
    handRanking: number;
    handName: string;
    kickers: number[];
    holeCards: Array<{ rank: string; suit: string }>;
  }> = [];
  // Hand complete callback for tournament chip sync
  private handCompleteCallback:
    | ((tableId: string, players: { user_id: string; stack: number }[]) => void)
    | null = null;
  // Hand-for-hand pause: set by tournament manager, checked between hands
  private handForHandPaused: boolean = false;
  private handForHandResolve: (() => void) | null = null;

  // Bible V8 §1.1.4: Action serialization lock — prevents parallel action processing
  private actionLock: boolean = false;

  // FIX 211: Bible V8 §1.9 — Track postHandTasks promise to prevent next hand
  // starting before DB stacks are synced (was fire-and-forget, risked stale stacks)
  private postHandTasksPromise: Promise<void> | null = null;

  // FIX 147: Bible V8 §6.3 — Periodic heartbeat check to detect disconnects mid-hand
  // Without this, disconnects are only detected between hands in dealingLoop().
  // Phase 1.2 PR-G-real: rescheduled every 10s through DeadlineScheduler instead
  // of setInterval. The eventId is a constant per table; the callback re-arms
  // itself for the next tick. `heartbeatActive` lets stop() short-circuit any
  // in-flight callback that fires after cancel().
  private static readonly HEARTBEAT_EVENT_ID = 'heartbeat_check';
  private static readonly HEARTBEAT_INTERVAL_MS = 10_000;
  private heartbeatActive: boolean = false;

  // Real Player Turn Management
  // Phase 1.2: playerTurnTimer deleted — DeadlineScheduler via PreciseActionTimer is sole timer authority.
  private playerTurnStartTime: number = 0;
  private playerTurnDuration: number = 0;
  private timeBankActivatedThisTurn: boolean = false;
  private showHandPlayers: Set<string> | null = null; // Bible V8 §4.21: players who voluntarily show hand

  // ── Step 4: Ported Core Modules ──
  private preciseTimer: PreciseActionTimer;
  private actionValidator: ServerActionValidator;
  private stateVerifier: StateVerifier;

  // ── Step 5: Ported Supporting Modules ──
  private timeBankEngine: TimeBankEngine;
  private disconnectEngine: DisconnectEngine;
  private preActionEngine: PreActionEngine;
  private atomicStackService: AtomicStackService;

  // ── Step 6: Ported Advanced Modules ──
  private straddleEngine: StraddleEngine;
  private mixedGameEngine: MixedGameEngine;
  private runItTwiceEngine: RunItTwiceEngine;
  private insuranceEngine: InsuranceEngine;
  private rakebackEngine: RakebackEngine;

  // ── Step 7: Ported Tournament & Extras Modules ──
  private chipRaceEngine: ChipRaceEngine;
  private tableBalancer: TableBalancer;
  private tableBreakEngine: TableBreakEngine;
  private ofcOrchestrator: OFCDealingOrchestrator;
  private engineTelemetry: EngineTelemetry;

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
      reportError(new Error(`[ServerTableEngine:${tableId}] STATE INTEGRITY VIOLATION: ${event.violationCount} issue(s) in hand #${event.handNumber}`), 'ServerTableEnginetableId.STATE_INTEGRITY_VIOLATION');
    });

    // Step 5: Initialize supporting modules
    this.timeBankEngine = new TimeBankEngine(this.preciseTimer, (event) => {
      console.log(
        `[ServerTableEngine:${tableId}] TimeBank: ${event.type} player=${event.playerId}`
      );
    });
    this.disconnectEngine = new DisconnectEngine(this.preciseTimer, (event) => {
      console.log(
        `[ServerTableEngine:${tableId}] Disconnect: ${event.type} player=${event.playerId}`
      );
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
    this.mixedGameEngine = new MixedGameEngine((event) => {
      console.log(`[ServerTableEngine:${tableId}] MixedGame: ${event.type}`);
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
    this.ofcOrchestrator = new OFCDealingOrchestrator((event) => {
      console.log(`[ServerTableEngine:${tableId}] OFC: ${event.type}`);
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
      // FIX 200: Bible V8 §6.2 — Each time bank adds exactly 15 seconds (was incorrectly 20).
      // TimeBankEngine DEFAULT_CONFIG already has secondsPerUse: 15 — this override must match.
      this.timeBankEngine.configure(this.tableId, {
        totalBankSeconds: (this.tableInfo.time_bank_max_uses ?? 120) * 15, // uses × 15s each (Bible V8 §6.2)
        maxUses: this.tableInfo.time_bank_max_uses ?? 120,
        secondsPerUse: 15, // Bible V8 §6.2: Each time bank adds exactly 15 seconds
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
      const ritEnabled = this.tableInfo.run_it_twice_enabled ?? false;
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
        });
      }

      // FIX 116: Mixed game mode removed from GameVariant — 'mixed' is dead.
      // MixedGameEngine configuration block removed.

      // FIX 104: Configure RakebackEngine for this table's club
      if (this.tableInfo.club_id) {
        this.rakebackEngine.configure(this.tableInfo.club_id, {
          enabled: true, // Rakeback is always tracked when club exists
        });
      }

      // FIX 137: Bible V8 §7.17 — Check for interrupted hand from a server crash
      const recovered = await this.checkCrashRecovery();
      if (recovered) {
        console.log(
          `[ServerTableEngine:${this.tableId}] Crash recovery complete — resuming from hand #${this.handCount}`
        );
      }

      // Wait for minimum 2 players
      while (this.running) {
        this.seatedPlayers = await loadSeatedPlayers(this.tableId);
        if (this.seatedPlayers.length >= 2) break;
        console.log(
          `[ServerTableEngine:${this.tableId}] Waiting for players... (${this.seatedPlayers.length}/2)`
        );
        await this.sleep(5000);
      }

      // FIX 147 + Phase 1.2 PR-G-real: heartbeat check via DeadlineScheduler.
      // Recurring schedule pattern — the callback re-arms itself so a single
      // process-global tick loop drives every table's heartbeat check.
      // FIX: Horses are server-side bots — send simulated heartbeats so they don't time out.
      this.heartbeatActive = true;
      this.scheduleHeartbeatCheck();

      // Start dealing loop
      this.dealingLoop();
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
    this.clearTurnTimer();
    this.handController = null;

    // FIX 147 + Phase 1.2 PR-G-real: tear down heartbeat scheduler entry.
    // Set the flag first so any callback already mid-flight bails before
    // re-arming, then cancel the pending entry.
    this.heartbeatActive = false;
    deadlineScheduler.cancel(this.tableId, ServerTableEngine.HEARTBEAT_EVENT_ID);

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
    this.mixedGameEngine.disposeAll();
    this.runItTwiceEngine.disposeAll();
    this.insuranceEngine.disposeAll();
    this.rakebackEngine.disposeAll();

    // Step 7: Dispose tournament & extras modules
    this.ofcOrchestrator.disposeAll();
    this.engineTelemetry.dispose();
    // Note: chipRaceEngine, tableBalancer, tableBreakEngine are stateless per-call — no dispose needed

    // Phase 1.1 PR-5: no Supabase channel to clean up — engine WS is now the
    // only game-state transport. TableStateHub.dropTable is called by the
    // discovery / tournament-break paths elsewhere.
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
  private scheduleHeartbeatCheck(): void {
    deadlineScheduler.schedule({
      tableId: this.tableId,
      eventId: ServerTableEngine.HEARTBEAT_EVENT_ID,
      deadlineMs: Date.now() + ServerTableEngine.HEARTBEAT_INTERVAL_MS,
      callback: () => {
        if (!this.running || !this.heartbeatActive) return;
        // Keep horses alive — server-side bots have no real client to heartbeat.
        for (const p of this.seatedPlayers) {
          if (p.is_horse) {
            this.disconnectEngine.heartbeat(this.tableId, p.user_id);
          }
        }
        this.disconnectEngine.checkStaleHeartbeats(this.tableId);
        // Re-arm for the next interval. cancel() in stop() will purge any
        // entry queued here if a stop happens between scheduling and tick.
        if (this.running && this.heartbeatActive) {
          this.scheduleHeartbeatCheck();
        }
      },
    });
  }

  isRunning(): boolean {
    return this.running;
  }
  getHandCount(): number {
    return this.handCount;
  }

  // FIX 153: Expose telemetry snapshot for health endpoint
  getTelemetrySnapshot() {
    return this.engineTelemetry.getSnapshot();
  }

  // FIX-224: Bible V8 §9.1.1/§9.1.2 — Record action processing performance
  recordActionPerformance(userId: string, action: string, processingMs: number): void {
    // broadcastMs tracked separately when available; pass null for now
    this.engineTelemetry.recordActionProcessingTime(
      this.tableId, userId, action, processingMs, null
    );
  }

  // FIX-224: Bible V8 §9.1 — Expose performance summary for health endpoint
  getPerformanceSummary() {
    return this.engineTelemetry.getPerformanceSummary();
  }

  onHandComplete(
    callback: (tableId: string, players: { user_id: string; stack: number }[]) => void
  ): void {
    this.handCompleteCallback = callback;
  }

  /** Pause dealing after current hand finishes (for hand-for-hand) */
  pauseAfterHand(): void {
    this.handForHandPaused = true;
  }

  /** Resume dealing (all tables finished their hand-for-hand hand) */
  resumeDealing(): void {
    this.handForHandPaused = false;
    if (this.handForHandResolve) {
      this.handForHandResolve();
      this.handForHandResolve = null;
    }
  }

  /** Check if engine is currently waiting for hand-for-hand resume */
  isWaitingForHandForHand(): boolean {
    return this.handForHandPaused && this.handForHandResolve !== null;
  }

  private isTournamentTable(): boolean {
    return !!(this.tableInfo?.tournament_id || this.tableInfo?.game_type === 'tournament');
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // TURN TIMER MANAGEMENT
  // ═════════════════════════════════════════════════════════════════════════════

  private clearTurnTimer(): void {
    // Phase 1.2: Cancel the PreciseActionTimer for the current player.
    // The old setTimeout-based playerTurnTimer has been deleted.
    // PreciseActionTimer.cancelTimer is called per-player in handleTurnChange,
    // and clearTable is used for full hand cleanup.
  }

  private startTurnTimer(userId: string, seat: number, durationSeconds: number): void {
    this.clearTurnTimer();
    // NOTE: Do NOT reset timeBankActivatedThisTurn here — this method is also called
    // from activateTimeBank() to extend the timer. The flag is reset in handleTurnChange()
    // when a genuinely new turn begins.
    this.playerTurnStartTime = Date.now();
    this.playerTurnDuration = Math.max(0, durationSeconds);

    // Safety fallback: if no duration, default to 15s to prevent infinite loops
    const safeDurationSeconds = this.playerTurnDuration > 0 ? this.playerTurnDuration : 15;

    // Phase 1.2: Register with PreciseActionTimer — this is now the SOLE timer.
    // The auto-fold/check logic runs as the onExpiry callback via DeadlineScheduler.
    // Bible V8 §6.1: 2-second grace period for network latency is baked into the
    // timer duration so the scheduler fires after the grace window.
    const GRACE_PERIOD_MS = 2000;
    const totalDurationMs = safeDurationSeconds * 1000 + GRACE_PERIOD_MS;

    this.preciseTimer.startTimer(this.tableId, userId, totalDurationMs, () => {
      // === onExpiry callback — fires when DeadlineScheduler tick reaches deadline ===
      if (!this.running || !this.handController) return;

      const state = this.handController.getState();
      if (state.currentPlayerSeat !== seat) return;

      // Bible V8 §6.2: Auto-activate time bank when primary timer expires
      if (!this.timeBankActivatedThisTurn) {
        const autoActivated = this.timeBankEngine.onPrimaryTimerExpired(
          this.tableId,
          userId,
          () => {
            // Time bank itself expired — auto-fold/check
            if (!this.running || !this.handController) return;
            const tbState = this.handController.getState();
            if (tbState.currentPlayerSeat !== seat) return;

            const tbPlayer = tbState.players.find((p) => p.seat === seat);
            const tbToCall = tbPlayer ? Math.max(0, tbState.currentBet - (tbPlayer.bet ?? 0)) : 0;
            const tbCanCheck = tbToCall === 0;

            if (tbCanCheck) {
              console.warn(`[ServerTableEngine:${this.tableId}] Player ${userId} time bank expired. Auto-checking.`);
              try { this.handController!.performAction(seat, 'check'); }
              catch { try { this.handController!.performAction(seat, 'fold'); } catch { /* done */ } }
            } else {
              console.warn(`[ServerTableEngine:${this.tableId}] Player ${userId} time bank expired. Auto-folding.`);
              try { this.handController!.performAction(seat, 'fold'); } catch { /* done */ }
            }

            this.engineTelemetry.recordTimerExpired(this.tableId);
            const tbUsesLeft = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
            try {
              this.hub?.emitEvent(this.tableId, {
                type: 'time_bank_timeout',
                table_id: this.tableId,
                player_id: userId,
                uses_remaining: tbUsesLeft,
                timed_out_action: tbCanCheck ? 'check' : 'fold',
                show_buy_more: tbUsesLeft <= 0,
              });
            } catch { /* broadcast failure is non-fatal */ }
          }
        );

        if (autoActivated) {
          this.timeBankActivatedThisTurn = true;
          const bankSeconds = this.timeBankEngine.getRemainingSeconds(this.tableId, userId);
          const usesAfterActivation = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
          console.log(
            `[ServerTableEngine:${this.tableId}] Auto-activated time bank for ${userId} (${bankSeconds}s remaining, ${usesAfterActivation} uses left)`
          );
          // Restart turn timer with time bank duration
          this.startTurnTimer(userId, seat, bankSeconds);

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
                  auto_activated: true,
                  uses_remaining: usesAfterActivation,
                },
              })
              .catch(() => {});
          } catch { /* broadcast failure is non-fatal */ }

          // FIX 125 + 2026-04-14 spam fix: warn ONLY at the last 1 remaining
          // and at 0 (the very last one was just used). Was firing at <=5
          // which on a 4-max-uses table means every single use triggered the
          // warning. Tester reported "after every card" spam.
          if (usesAfterActivation >= 0 && usesAfterActivation <= 1) {
            try {
              this.hub?.emitEvent(this.tableId, {
                type: 'time_bank_low',
                table_id: this.tableId,
                player_id: userId,
                uses_remaining: usesAfterActivation,
              });
            } catch { /* broadcast failure is non-fatal */ }
          }

          return; // Time bank activated — don't auto-fold/check yet
        }
      }

      // No time bank available — auto-fold or auto-check
      const player = state.players.find((p) => p.seat === seat);
      const amountToCall = player ? Math.max(0, state.currentBet - (player.bet ?? 0)) : 0;
      const canCheck = amountToCall === 0;

      if (canCheck) {
        console.warn(`[ServerTableEngine:${this.tableId}] Player ${userId} timed out. Auto-checking (no bet to call).`);
        try { this.handController.performAction(seat, 'check'); }
        catch (err) {
          reportError(err, 'ServerTableEnginethistableId.Autocheck_failed');
          try { this.handController.performAction(seat, 'fold'); }
          catch (foldErr) { reportError(foldErr, 'ServerTableEnginethistableId.Autofold_fallback_also_failed'); }
        }
      } else {
        console.warn(`[ServerTableEngine:${this.tableId}] Player ${userId} timed out. Auto-folding (${amountToCall} to call).`);
        try { this.handController.performAction(seat, 'fold'); }
        catch (err) { reportError(err, 'ServerTableEnginethistableId.Autofold_failed'); }
      }

      this.engineTelemetry.recordTimerExpired(this.tableId);
      const usesLeft = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
      try {
        this.hub?.emitEvent(this.tableId, {
          type: 'time_bank_timeout',
          table_id: this.tableId,
          player_id: userId,
          uses_remaining: usesLeft,
          timed_out_action: canCheck ? 'check' : 'fold',
          show_buy_more: usesLeft <= 0,
        });
      } catch { /* broadcast failure is non-fatal */ }
    });
  }

  /**
   * Activate Time Bank triggered by the client HTTP POST to `/timebank`
   * Bible V8 §6.2: Manual activate — delegates to TimeBankEngine (single source of truth)
   */
  public activateTimeBank(userId: string): { success: boolean; error?: string } {
    if (!this.handController || !this.tableInfo) {
      return { success: false, error: 'No active hand or table info missing' };
    }

    const state = this.handController.getState();
    const player = state.players.find((p) => p.user_id === userId);

    if (!player || state.currentPlayerSeat !== player.seat) {
      return { success: false, error: 'Not your turn' };
    }

    if (this.timeBankActivatedThisTurn) {
      return { success: false, error: 'Time bank already activated this turn' };
    }

    // Bible V8 §6.2: Check via TimeBankEngine (single source of truth for pool + per-hand limits)
    if (!this.timeBankEngine.hasTimeBank(this.tableId, userId)) {
      return { success: false, error: 'No time bank uses remaining' };
    }

    // Activate via TimeBankEngine — it handles pool depletion, per-hand limit, and event emission
    const activated = this.timeBankEngine.activate(this.tableId, userId, () => {
      // This callback fires when the manual time bank expires
      if (!this.running || !this.handController) return;
      const tbState = this.handController.getState();
      if (tbState.currentPlayerSeat !== player.seat) return;

      const tbPlayer = tbState.players.find((p) => p.seat === player.seat);
      const tbToCall = tbPlayer ? Math.max(0, tbState.currentBet - (tbPlayer.bet ?? 0)) : 0;
      const tbCanCheck = tbToCall === 0;

      if (tbCanCheck) {
        try {
          this.handController!.performAction(player.seat, 'check');
        } catch {
          try {
            this.handController!.performAction(player.seat, 'fold');
          } catch {
            /* done */
          }
        }
      } else {
        try {
          this.handController!.performAction(player.seat, 'fold');
        } catch {
          /* done */
        }
      }

      // FIX 149: Wire telemetry — manual time bank expiry
      this.engineTelemetry.recordTimerExpired(this.tableId);

      // FIX 124c: Manual time bank expired → broadcast timeout event (same as FIX 124b for auto path)
      const tbUsesLeft = this.timeBankEngine.getUsesRemaining(this.tableId, userId);
      try {
        this.hub?.emitEvent(this.tableId, {
          type: 'time_bank_timeout',
          table_id: this.tableId,
          player_id: userId,
          uses_remaining: tbUsesLeft,
          timed_out_action: tbCanCheck ? 'check' : 'fold',
          show_buy_more: tbUsesLeft <= 0,
        });
      } catch {
        /* broadcast failure is non-fatal */
      }
    });

    if (!activated) {
      return { success: false, error: 'Time bank activation failed (per-hand limit or depleted)' };
    }

    this.timeBankActivatedThisTurn = true;

    // Get bank info for the broadcast
    const bank = this.timeBankEngine.getPlayerBank(this.tableId, userId);
    const bankSeconds = bank ? bank.currentUseSeconds : 15;

    // Calculate remaining normal time and add bank time
    const elapsed = (Date.now() - this.playerTurnStartTime) / 1000;
    const remainingBeforeBank = Math.max(0, this.playerTurnDuration - elapsed);
    const newDuration = remainingBeforeBank + bankSeconds;

    console.log(
      `[ServerTableEngine:${this.tableId}] Player ${userId} manually activated time bank. Adding ${bankSeconds}s. Total: ${Math.round(newDuration)}s`
    );

    this.startTurnTimer(userId, player.seat, newDuration);

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
            auto_activated: false,
          },
        })
        .catch(() => {});
    } catch (e) {}

    // FIX 125 + 2026-04-14 spam fix: warn ONLY at the last 1 remaining (or 0
    // = just used last one). Previous <=5 condition spammed on 4-max tables.
    const manualUsesLeft = bank?.usesRemaining ?? 0;
    if (manualUsesLeft >= 0 && manualUsesLeft <= 1) {
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

    return { success: true };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // MISSING ENDPOINTS — Bible V8 Required (heartbeat, preaction, sitout, state)
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * POST /heartbeat — Bible V8 §6.3: Reset disconnect timer for a player
   */
  public heartbeat(userId: string): {
    success: boolean;
    connected: boolean;
    gracePeriodRemaining: number;
  } {
    this.disconnectEngine.heartbeat(this.tableId, userId);
    const connected = this.disconnectEngine.isConnected(this.tableId, userId);
    return { success: true, connected, gracePeriodRemaining: 0 };
  }

  /**
   * POST /preaction — Bible V8 §4.15: Set or clear a pre-action
   */
  public setPreAction(
    userId: string,
    action: string,
    maxCallAmount?: number
  ): { success: boolean; error?: string } {
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

    this.preActionEngine.setPreAction(this.tableId, userId, action as any, maxCallAmount);
    return { success: true };
  }

  /**
   * POST /addchips — Player bought chips (added to their stack directly).
   * Fixes race condition where postHandTasks overwrote table_seats db buy-ins.
   */
  public addChips(userId: string, amount: number): { success: boolean; error?: string } {
    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) return { success: false, error: 'Player not seated' };

    // Update Engine Memory
    player.stack += amount;
    if (this.handController) {
      const hcState = this.handController.getState();
      const hcPlayer = hcState.players.find((p) => p.user_id === userId);
      if (hcPlayer) hcPlayer.stack += amount;
    }

    // Update Database directly as well (for safety against server crash before hand completes).
    // The engine's single threaded nature makes it safe to read/write here without an RPC.
    const { supabase } = require('../services/supabase.js');
    supabase
      .from('table_seats')
      .select('stack')
      .eq('table_id', this.tableId)
      .eq('user_id', userId)
      .is('left_at', null)
      .maybeSingle()
      .then(({ data }: { data: any }) => {
        if (data && data.stack !== undefined) {
          supabase
            .from('table_seats')
            .update({ stack: data.stack + amount })
            .eq('table_id', this.tableId)
            .eq('user_id', userId)
            .is('left_at', null)
            .then(({ error }: { error: any }) => {
              if (error) console.error(`[ServerTableEngine] addChips db update failed:`, error);
            });
        }
      });

    // Broadcast update so the player sees the chip increase immediately
    this.broadcastCurrentState();
    return { success: true };
  }

  /**
   * POST /sitout — Bible V8 §7.12: Player sits out or back in
   */
  public sitOut(
    userId: string,
    sitOut: boolean
  ): { success: boolean; error?: string; willFoldNextHand: boolean } {
    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not found at this table', willFoldNextHand: false };
    }

    if (sitOut) {
      // FIX 143: Bible V8 §7.12 — Can't fold mid-hand.
      // If a hand is in progress, defer the sit-out until after the hand completes.
      // The player continues playing the current hand normally.
      if (this.handController !== null) {
        this.pendingSitOut.add(userId);
      } else {
        this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');
      }
    } else {
      // Cancel any pending sit-out
      this.pendingSitOut.delete(userId);
      this.disconnectEngine.sitBack(this.tableId, userId);
      // Bible V8 §4.2: Mark player as returning — must post dead blind on next hand
      this.returningFromSitout.add(userId);
    }

    // FIX 143: willFoldNextHand is informational — player finishes current hand normally
    const willFoldNextHand = sitOut && this.handController !== null;

    return { success: true, willFoldNextHand };
  }

  /**
   * POST /leave — Player leaves the table. If mid-hand, auto-fold then mark leave_pending.
   * If between hands, mark seat as left immediately.
   */
  public leaveTable(
    userId: string
  ): { success: boolean; error?: string; immediate: boolean } {
    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not found at this table', immediate: false };
    }

    if (this.handController !== null) {
      // Mid-hand: fold the player immediately if it's their turn or they're still in
      const state = this.handController.getState();
      const enginePlayer = state.players.find((p) => p.user_id === userId);

      if (enginePlayer && !enginePlayer.is_folded && !enginePlayer.is_all_in) {
        try {
          this.handController.performAction(enginePlayer.seat, 'fold');
          console.log(
            `[ServerTableEngine:${this.tableId}] Player ${userId} auto-folded on leave`
          );
        } catch (err) {
          // Player might not be the current actor — that's fine, they'll be skipped
          console.warn(
            `[ServerTableEngine:${this.tableId}] Auto-fold on leave failed (not their turn): ${err}`
          );
        }
      }

      // Mark as leave_pending — processLeavePending will handle cashout at end of hand
      supabase
        .from('table_seats')
        .update({ leave_pending: true, status: 'sitting_out' })
        .eq('table_id', this.tableId)
        .eq('user_id', userId)
        .is('left_at', null)
        .then(({ error }) => {
          if (error) console.warn(`[ServerTableEngine] leave_pending update failed:`, error.message);
        });

      // Also mark in disconnect engine so they don't get dealt next hand
      this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');

      return { success: true, immediate: false };
    } else {
      // Between hands: remove immediately via atomic cashout
      atomicCashout(userId, this.tableId, player.seat_number)
        .then(() => {
          console.log(
            `[ServerTableEngine:${this.tableId}] Player ${userId} left table immediately (between hands)`
          );
        })
        .catch((err) => {
          console.warn(
            `[ServerTableEngine:${this.tableId}] atomicCashout on leave failed:`,
            err
          );
          // Fallback: mark seat as left directly
          markSeatAsLeft(this.tableId, userId, player.seat_number);
        });

      return { success: true, immediate: true };
    }
  }

  /**
   * GET /state/:tableId — Bible V8 §2.4: Get current hand state (scrubbed for requesting player)
   */
  public getTableState(requestingUserId: string): Record<string, any> | null {
    if (!this.handController || !this.tableInfo) return null;

    const state = this.handController.getState();
    const currentSeatPlayer = state.players.find((p) => p.seat === state.currentPlayerSeat);

    return {
      table_id: this.tableId,
      hand_number: this.handCount,
      pot: state.pot ?? 0,
      community_cards: state.communityCards ?? [],
      current_bet: state.currentBet ?? 0,
      current_player: currentSeatPlayer?.user_id ?? null,
      dealer_seat: state.dealerSeat ?? this.currentHandDealerSeat,
      stage: state.stage ?? 'preflop',
      min_raise: state.minRaise ?? 0,
      last_raise: state.lastRaise ?? 0,
      // Bible V8 §2.4: Timer fields required for client-side countdown
      turn_start_time_ms: this.playerTurnStartTime,
      turn_duration_ms: this.playerTurnDuration * 1000, // Convert seconds → milliseconds
      pots: (state.pots ?? []).map((p) => ({
        amount: p.amount,
        eligible: p.eligiblePlayers ?? [],
      })),
      // Bible V8 §2.5: Action Record — seat, userId, action, amount, timestamp, stage
      action_history: (state.actionHistory ?? []).map((a) => ({
        seat: a.seat,
        userId: a.userId ?? '',
        action: a.action,
        amount: a.amount,
        timestamp: a.timestamp ?? 0,
        stage: a.stage,
      })),
      players: (() => {
        const positionLabels = this.getPositionLabels(
          state.dealerSeat ?? this.currentHandDealerSeat,
          state.players ?? []
        );
        return (state.players ?? []).map((p) => {
          let showCards = false;
          if (p.user_id === requestingUserId) {
            showCards = true;
          } else if (state.stage === 'showdown' && !p.is_folded) {
            const isWinner = this.currentHandWinnerIds.includes(p.user_id);
            const voluntarilyShowing = this.showHandPlayers?.has(p.user_id) ?? false;
            const autoMuckEnabled = this.tableInfo?.auto_muck_enabled ?? true;
            showCards = isWinner || voluntarilyShowing || !autoMuckEnabled;
          }
          return {
            seat: p.seat,
            user_id: p.user_id,
            username: p.username,
            stack: p.stack,
            bet: p.bet ?? 0,
            totalInvested: p.totalInvested ?? 0,
            cards: showCards ? (p.cards ?? []) : [],
            is_folded: p.is_folded ?? false,
            is_all_in: p.is_all_in ?? false,
            is_sitting_out: p.is_sitting_out ?? false,
            is_disconnected: !this.disconnectEngine.isConnected(this.tableId, p.user_id),
            time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id),
            time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id),
            position: positionLabels.get(p.seat) ?? '',
            avatar_url: p.avatar_url ?? '', // Bible V8 §2.3
            is_horse: p.is_horse ?? false, // Bible V8 §2.3
          };
        });
      })(),
    };
  }

  /**
   * POST /straddle — Bible V8 §4.4: Toggle auto-straddle enrollment
   */
  public toggleStraddle(userId: string, enabled: boolean): { success: boolean; error?: string } {
    if (!this.tableInfo?.straddle_enabled) {
      return { success: false, error: 'Straddles are not enabled at this table' };
    }
    this.straddleEngine.toggleAutoStraddle(this.tableId, userId, enabled);
    return { success: true };
  }

  /**
   * FIX 95: Bible V8 §4.20 + Dan's rules: Respond to a Run It Twice offer.
   *
   * Two-phase flow:
   * Phase 1 — CHOOSER (best hand) picks how many boards: 1 (decline), 2, or 3.
   *           Body: { tableId, runs: 1|2|3 }
   * Phase 2 — ALL OTHER players accept or decline the chosen number.
   *           Body: { tableId, response: 'accept'|'decline' }
   *
   * If chooser picks 1 → instant run-once, no further prompts.
   * If ANY other player declines → fall back to run-once.
   * If ALL accept → deal that many boards.
   */
  public respondToRIT(
    userId: string,
    response?: 'accept' | 'decline',
    runs?: 1 | 2 | 3
  ): { success: boolean; error?: string; status?: string } {
    if (!this.runItTwiceEngine.hasPendingOffer(this.tableId)) {
      return { success: false, error: 'No active Run It Twice offer' };
    }

    const state = this.runItTwiceEngine.getState(this.tableId);
    if (!state) {
      return { success: false, error: 'No RIT state found' };
    }

    // Phase 1: Chooser picks how many boards
    if (userId === state.chooserPlayerId && runs !== undefined) {
      this.runItTwiceEngine.chooserDecides(this.tableId, userId, runs);
      if (runs === 1) {
        return { success: true, status: 'declined_by_chooser' };
      }
      // Broadcast chooser's decision to all clients so others can accept/decline
      this.hub?.emitEvent(this.tableId, {
        type: 'rit_chooser_decided',
        table_id: this.tableId,
        chooserPlayerId: userId,
        chosenRuns: runs,
        waitingFor: state.allPlayerIds.filter((pid) => pid !== userId),
      });
      return { success: true, status: 'waiting_for_others' };
    }

    // Phase 2: Other players accept or decline
    if (response === 'accept') {
      const allAccepted = this.runItTwiceEngine.accept(this.tableId, userId);
      if (allAccepted) {
        return { success: true, status: 'accepted' };
      }
      return { success: true, status: 'waiting_for_others' };
    } else if (response === 'decline') {
      this.runItTwiceEngine.decline(this.tableId, userId);
      return { success: true, status: 'declined' };
    }

    return {
      success: false,
      error: 'Invalid RIT response: provide runs (1/2/3) or response (accept/decline)',
    };
  }

  /**
   * Bible V8 §4.19: Respond to an insurance offer.
   * @param coveragePercent — Optional partial coverage (1-100%). Default = 100% (full insurance).
   *   Player uses a slider UI to adjust. e.g., 75 = "75% insurance" = 75% of the payout/cost.
   * @param declineForHand — If declining, true = "Decline for Hand" (never re-offer),
   *   false = "Decline Now" (may re-offer on next street if equity shifts).
   */
  public respondToInsurance(
    userId: string,
    response: 'accept' | 'decline',
    coveragePercent: number = 100,
    declineForHand: boolean = false
  ): {
    success: boolean;
    error?: string;
    status?: string;
    premium?: number;
    insuredAmount?: number;
  } {
    if (!this.insuranceEngine.isEnabled(this.tableId)) {
      return { success: false, error: 'Insurance is not enabled at this table' };
    }

    if (response === 'accept') {
      const accepted = this.insuranceEngine.acceptPartial(this.tableId, userId, coveragePercent);
      if (!accepted) {
        return { success: false, error: 'No pending insurance offer for this player' };
      }
      // NOTE: Premium is NOT deducted from stack here — player is ALL-IN.
      // Insurance premium is deducted from the winner's pot at settlement (like rake/BBJ).
      // If the insured player LOSES, they get paid from union/club bank.
      // Settlement happens in HAND_COMPLETE handler.
      const offers = this.insuranceEngine.getOffers(this.tableId);
      const accepted_offer = offers.find((o) => o.playerId === userId && o.status === 'accepted');
      return {
        success: true,
        status: 'accepted',
        premium: accepted_offer?.premium,
        insuredAmount: accepted_offer?.insuredAmount,
      };
    } else {
      // Two decline modes: "Decline Now" (this street) or "Decline for Hand" (all streets)
      this.insuranceEngine.decline(this.tableId, userId, declineForHand);
      return { success: true, status: declineForHand ? 'declined_for_hand' : 'declined' };
    }
  }

  /**
   * Bible V8 §4.19: Preview insurance cost for a given coverage percentage.
   * Used by client slider to show real-time cost/payout as player adjusts.
   */
  public previewInsurance(
    userId: string,
    coveragePercent: number
  ): { premium: number; insuredAmount: number; coveragePercent: number } | null {
    return this.insuranceEngine.getPreview(this.tableId, userId, coveragePercent);
  }

  /**
   * Bible V8 §4.21: Player chooses to show hand at showdown (even if not required).
   * Auto-muck: losing hands are hidden unless player explicitly shows.
   */
  public showHand(userId: string): { success: boolean; error?: string } {
    if (!this.handController) {
      return { success: false, error: 'No active hand' };
    }

    const state = this.handController.getState();
    if (state.stage !== 'showdown') {
      return { success: false, error: 'Can only show hand during showdown' };
    }

    const player = state.players.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not found at this table' };
    }

    if (player.is_folded) {
      return { success: false, error: 'Cannot show a folded hand' };
    }

    // Mark this player as voluntarily showing their hand
    if (!this.showHandPlayers) {
      this.showHandPlayers = new Set<string>();
    }
    this.showHandPlayers.add(userId);

    // Broadcast updated state so this player's cards become visible
    this.broadcastCurrentState();

    return { success: true };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // REAL PLAYER ACTION — Accept actions from HTTP endpoint
  // ═════════════════════════════════════════════════════════════════════════════

  /**
   * Handle an action from a REAL player (not a horse).
   * Called from the HTTP /action endpoint when a player clicks fold/call/raise.
   */
  handlePlayerAction(
    userId: string,
    action: string,
    amount?: number
  ): { success: boolean; error?: string; code?: string; hint?: Record<string, unknown> } {
    // Bible V8 §1.1.4: Serialize all actions — no parallel processing
    if (this.actionLock) {
      return { success: false, error: 'Action already being processed — try again' };
    }
    this.actionLock = true;
    try {
      return this._handlePlayerActionInner(userId, action, amount);
    } finally {
      this.actionLock = false;
    }
  }

  private _handlePlayerActionInner(
    userId: string,
    action: string,
    amount?: number
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

    const seat = player.seat;
    const toCall = Math.max(0, state.currentBet - player.bet);

    // Normalize actions
    let normalizedAction = action.toLowerCase();
    if (normalizedAction === 'allin' || normalizedAction === 'all-in') normalizedAction = 'all_in';
    if (normalizedAction === 'check' && toCall > 0) normalizedAction = 'call';
    if (normalizedAction === 'call' && toCall === 0) normalizedAction = 'check';
    if (normalizedAction === 'fold' && toCall === 0) normalizedAction = 'check';
    if (normalizedAction === 'raise' && state.currentBet === 0) normalizedAction = 'bet';
    if (normalizedAction === 'bet' && state.currentBet > 0) normalizedAction = 'raise';

    // Bible V8 §4.14: Pot-limit max raise for PLO variants
    const isPotLimit = this.tableInfo?.game_variant?.startsWith('plo');
    let potLimitMaxBet = Infinity;
    if (isPotLimit) {
      // FIX 142: Pot-limit max raise SIZE = pot + toCall (the pot after you call).
      // Previous formula (pot + toCall + toCall) was one toCall too permissive.
      // For a BET (toCall=0): maxBet = pot. For a RAISE: maxRaiseSize = pot + toCall.
      // This matches PokerEngine.calculateBettingState (FIX 121).
      potLimitMaxBet = state.pot + toCall;
    }

    // Clamp amounts
    if (normalizedAction === 'call') amount = toCall;
    if (normalizedAction === 'bet' && amount !== undefined) {
      amount = Math.max(state.minRaise, amount);
      // Bible V8 §4.14: Cap at pot-limit max for PLO
      if (isPotLimit) {
        amount = Math.min(amount, potLimitMaxBet);
      }
      if (amount >= player.stack) {
        normalizedAction = 'all_in';
        amount = undefined;
      }
    } else if (normalizedAction === 'raise' && amount !== undefined) {
      const minRaiseTo = state.currentBet + state.minRaise;
      amount = Math.max(minRaiseTo, amount);
      // Bible V8 §4.14: Cap at pot-limit max for PLO (raise TO = currentBet + potLimitMaxBet)
      if (isPotLimit) {
        const potLimitRaiseTo = state.currentBet + potLimitMaxBet;
        amount = Math.min(amount, potLimitRaiseTo);
      }
      const maxRaiseTo = player.stack + player.bet;
      if (amount >= maxRaiseTo) {
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
      this.clearTurnTimer();
      this.preciseTimer.cancelTimer(this.tableId, userId); // Step 4: Cancel precise deadline
      // Bible V8 §6.2: If time bank was active, notify engine to deduct used time from pool
      if (this.timeBankActivatedThisTurn) {
        this.timeBankEngine.playerActed(this.tableId, userId);
      }
      this.handController.performAction(seat, normalizedAction as any, amount);
      console.log(
        `[ServerTableEngine:${this.tableId}] Player ${userId} → ${normalizedAction}${amount ? ` ${amount}` : ''}`
      );

      // FIX 149: Wire telemetry — record that player acted within timer
      this.engineTelemetry.recordTimerActed(this.tableId);

      // FIX 137: Bible V8 §7.17 — Snapshot hand state after every successful action (fire-and-forget)
      this.saveSnapshot().catch(() => {});

      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Action failed';
      console.warn(`[ServerTableEngine:${this.tableId}] Player action failed:`, errMsg);
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

    if (state.currentPlayerSeat !== player.seat) {
      return { ...defaultResult, pot: state.pot };
    }

    const toCall = Math.max(0, state.currentBet - player.bet);
    const actions: string[] = [];

    if (toCall > 0) {
      actions.push('fold', 'call');
      if (player.stack > toCall) actions.push('raise');
    } else {
      actions.push('check');
      if (player.stack > 0) actions.push('bet');
    }
    actions.push('all_in');

    const minRaiseTo = state.currentBet > 0 ? state.currentBet + state.minRaise : state.minRaise;
    let maxRaiseTo = player.stack + player.bet;

    // FIX 176: Bible V8 §4.14: Cap maxRaise for pot-limit games (PLO variants)
    // Pot-limit max raise SIZE = pot + toCall (the pot after you call).
    // Raise TO = currentBet + (pot + toCall). The old formula had an extra toCall
    // which allowed raises ~toCall higher than legal pot-limit max.
    const isPotLimit = this.tableInfo?.game_variant?.startsWith('plo');
    if (isPotLimit) {
      const potLimitMaxBet = state.pot + toCall;
      const potLimitRaiseTo = state.currentBet + potLimitMaxBet;
      maxRaiseTo = Math.min(maxRaiseTo, potLimitRaiseTo);
    }

    return {
      canAct: true,
      actions,
      toCall,
      minRaise: minRaiseTo,
      maxRaise: maxRaiseTo,
      pot: state.pot,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // DEALING LOOP — Millisecond-level performance
  // ═════════════════════════════════════════════════════════════════════════════

  private async dealingLoop(): Promise<void> {
    while (this.running) {
      try {
        // FIX 211: Await any pending postHandTasks before reloading players
        // This ensures DB stacks are synced before the next hand starts
        if (this.postHandTasksPromise) {
          await this.postHandTasksPromise;
          this.postHandTasksPromise = null;
        }

        // Reload players + refresh blinds before each hand
        this.seatedPlayers = await loadSeatedPlayers(this.tableId);
        await this.refreshBlinds();

        // Bible V8 §6.3: Check for stale heartbeats before each hand
        this.disconnectEngine.checkStaleHeartbeats(this.tableId);

        // FIX 143: Bible V8 §7.12 — Exclude sitting-out players from the deal.
        // Standard online poker: sitting-out players skip the hand entirely.
        // They miss their blind and owe a dead blind when they return (§4.2).
        const activePlayers = this.seatedPlayers.filter(
          (p) => p.stack > 0 && !this.disconnectEngine.isSittingOut(this.tableId, p.user_id)
        );

        // Clean up rebuy map (Garbage Collection for horses no longer sitting here)
        const currentHorseIds = new Set(
          this.seatedPlayers.filter((p) => p.is_horse).map((p) => p.user_id)
        );
        for (const [horseId] of this.horseRebuys.entries()) {
          if (!currentHorseIds.has(horseId)) {
            this.horseRebuys.delete(horseId);
          }
        }

        if (activePlayers.length < 2) {
          await this.sleep(3000);
          continue;
        }

        // Deal hand
        await this.dealHand(activePlayers);
        this.consecutiveErrors = 0;

        // Hand-for-hand: if paused, wait until tournament manager resumes all tables
        if (this.handForHandPaused && this.running) {
          console.log(
            `[ServerTableEngine:${this.tableId}] Hand-for-hand: waiting for all tables to complete...`
          );
          await new Promise<void>((resolve) => {
            this.handForHandResolve = resolve;
            // Safety timeout: resume after 2 minutes if something goes wrong
            setTimeout(() => {
              if (this.handForHandResolve === resolve) {
                this.handForHandResolve = null;
                resolve();
              }
            }, 120000);
          });
        }

        // Brief pause between hands (1-2 seconds for server — fast!)
        if (this.running) {
          await this.sleep(1000 + Math.floor(Math.random() * 1000));
        }
      } catch (err) {
        this.consecutiveErrors++;
        const backoffMs = Math.min(3000 * Math.pow(2, this.consecutiveErrors - 1), 30000);
        reportError(err, 'ServerTableEnginethistableId.Error_attempt_thisconsecutiveE');
        if (this.consecutiveErrors >= 10) {
          reportError(new Error(`[ServerTableEngine:${this.tableId}] Too many errors — stopping`), 'ServerTableEnginethistableId.Too_many_errors__stopping');
          this.running = false;
        } else {
          await this.sleep(backoffMs);
        }
      }
    }
  }

  private async refreshBlinds(): Promise<void> {
    if (!this.tableInfo || !this.isTournamentTable()) return;
    const data = await loadTable(this.tableId);
    if (data) {
      this.tableInfo.small_blind = data.small_blind;
      this.tableInfo.big_blind = data.big_blind;
      this.tableInfo.ante = data.ante;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // DEAL HAND — Complete hand lifecycle
  // ═════════════════════════════════════════════════════════════════════════════

  private async dealHand(players: SeatedPlayer[]): Promise<void> {
    if (!this.tableInfo) return;

    this.handCount++;
    const handNumber = this.handCount;
    const handStartMs = Date.now(); // FIX 149: Capture hand start time for telemetry
    this.currentHandWentToFlop = false;
    this.currentHandPotSize = 0;
    this.currentHandWinnerIds = [];
    this.currentHandRake = 0;
    this.currentHandBBJFee = 0;
    this.currentHandCommunityCards = [];
    this.currentHandActions = [];
    this.currentHandWinners = [];
    this.currentHandContributions.clear(); // Bible V8 §4.18: Reset equal-share rakeback tracking (FIX 144)
    this.currentHandInsuranceSettlements = []; // Bible V8 §4.19: Reset insurance settlements
    this.currentHandShowdownResults = []; // BBJ: Reset showdown results for new hand
    this.currentHandBBJHit = null; // BBJ: Reset hit detection for new hand
    this.currentHandBBJPayoutConfig = null;
    this.currentHandRabbitCards = []; // Rabbit Hunt: Reset remaining deck
    this.timeBankActivatedThisTurn = false; // Bible V8 §6.2: Reset time bank flag for new hand
    this.showHandPlayers = null; // Reset voluntary show-hand set for new hand

    console.log(
      `[ServerTableEngine:${this.tableId}] Hand #${handNumber} — ${players.length} players`
    );

    // Convert to SeatPlayer format
    const hcPlayers: SeatPlayer[] = players.map((p) => ({
      seat: p.seat_number,
      user_id: p.user_id,
      username: p.username,
      stack: p.stack,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
      // Bible V8 §2.3: Carry through identity fields for broadcast
      is_horse: p.is_horse ?? false,
      avatar_url: p.avatar_url ?? '',
    }));

    // Rotate dealer
    this.dealerSeatIndex = this.dealerSeatIndex % players.length;
    const dealerSeat = players[this.dealerSeatIndex].seat_number;
    this.currentHandDealerSeat = dealerSeat;
    this.dealerSeatIndex++;

    // Bible V8 §6: Detect orbit completion (dealer wrapped around table) → refill time banks
    if (this.dealerSeatIndex > 0 && this.dealerSeatIndex % players.length === 0) {
      this.timeBankEngine.onOrbitComplete(this.tableId);
    }

    // Bible V8 §4.4: Process straddles before hand starts
    let straddleResults: { seat: number; amount: number }[] = [];
    if (this.tableInfo.straddle_enabled) {
      // Build seat order starting from UTG (left of BB)
      const sbSeat = players.length === 2 ? dealerSeat : this.getNextSeat(dealerSeat, players);
      const bbSeat = this.getNextSeat(sbSeat, players);
      const utgSeat = this.getNextSeat(bbSeat, players);

      const seatOrder: Array<{ seat: number; playerId: string }> = [];
      let currentSeat = utgSeat;
      for (let i = 0; i < players.length - 2; i++) {
        // Exclude SB and BB
        const p = players.find((pl) => pl.seat_number === currentSeat);
        if (p) seatOrder.push({ seat: p.seat_number, playerId: p.user_id });
        currentSeat = this.getNextSeat(currentSeat, players);
      }

      const stackMap = new Map(players.map((p) => [p.user_id, p.stack]));
      // FIX 114: UTG straddle only — no Mississippi
      const straddleConfig = {
        enabled: true,
        maxStraddles: 1, // FIX 114: UTG only — always 1
        straddleMultiplier: 2,
      };
      this.straddleEngine.configure(this.tableId, straddleConfig);
      const result = this.straddleEngine.processStraddles(
        this.tableId,
        this.tableInfo.big_blind,
        seatOrder,
        stackMap
      );
      if (result.posted) {
        straddleResults = result.straddles.map((s) => ({ seat: s.seatNumber, amount: s.amount }));
      }
    }

    // Bible V8 §1.9 / Appendix A: Get full rake + BBJ config for this stakes/variant
    // Single lookup — used for both rakeConfig and bbjConfig
    const fullRakeConfig = this.getFullRakeAndBBJConfig();

    // FIX-218: Bible V8 §4.22 — Bomb pot detection based on table settings
    // Triggers every N hands when bomb_pot_enabled + bomb_pot_frequency are set
    let bombPotConfig: { anteMultiplier: number } | undefined;
    if (
      this.tableInfo.bomb_pot_enabled &&
      this.tableInfo.bomb_pot_frequency &&
      this.tableInfo.bomb_pot_frequency > 0 &&
      handNumber % this.tableInfo.bomb_pot_frequency === 0
    ) {
      bombPotConfig = {
        anteMultiplier: this.tableInfo.bomb_pot_ante_multiplier ?? 2,
      };
    }

    const config: HandConfig = {
      tableId: this.tableId,
      handNumber,
      gameVariant: this.tableInfo.game_variant as GameVariant,
      smallBlind: this.tableInfo.small_blind,
      bigBlind: this.tableInfo.big_blind,
      // FIX-219: Bible V8 §4.3 — Respect ante_enabled toggle; if disabled, zero out ante
      ante: (this.tableInfo.ante_enabled ?? true) ? this.tableInfo.ante : undefined,
      bigBlindAnte: this.tableInfo.big_blind_ante_enabled ?? false,
      bombPot: bombPotConfig,
      straddles: straddleResults.length > 0 ? straddleResults : undefined,
      // Bible V8 §4.2: Dead blinds for players returning from sit-out
      deadBlinds:
        this.returningFromSitout.size > 0
          ? players
              .filter((p) => this.returningFromSitout.has(p.user_id))
              .map((p) => ({ seat: p.seat_number }))
          : undefined,
      rakeConfig: {
        percent: fullRakeConfig.rakePercent,
        cap: fullRakeConfig.rakeCap,
        noFlopNoDrop: true,
        // FIX 166: Bible V8 §7.19 — player-count-based rake caps (heads-up = 50%, 3-handed = 67%)
        playerCountCaps: getPlayerCountCaps(fullRakeConfig.rakeCap),
      },
      bbjConfig: {
        enabled: fullRakeConfig.bbjEnabled,
        feeBB: fullRakeConfig.bbjFeeBB,
        minPotBB: fullRakeConfig.rules.minPotBB,
        minPlayersDealt: fullRakeConfig.rules.minPlayersDealt,
      },
    };

    this.handController = new HandController(config, hcPlayers, dealerSeat);

    // Bible V8 §4.2: Clear returning-from-sitout after dead blinds are passed to config
    if (this.returningFromSitout.size > 0) {
      this.returningFromSitout.clear();
    }

    // Step 4: Record initial chip totals for state verification
    this.stateVerifier.recordInitialChipTotal(this.tableId, hcPlayers);

    // Step 5: Initialize atomic stacks, time banks, and disconnect tracking for each player
    // Bible V8 §6.2: Reset per-hand time bank activation counters
    this.timeBankEngine.resetHandActivations(this.tableId);
    for (const p of hcPlayers) {
      this.atomicStackService.initializeStack(this.tableId, p.user_id, p.stack);
      // Only initialize time bank if player is NEW (don't reset existing pool per session)
      if (!this.timeBankEngine.getPlayerBank(this.tableId, p.user_id)) {
        this.timeBankEngine.initializePlayer(this.tableId, p.user_id);
      }
      this.disconnectEngine.registerPlayer(this.tableId, p.user_id);
    }

    // Step 5: Wire disconnect auto-action callback into HandController
    this.disconnectEngine.onAutoAction(this.tableId, (disconnectAction) => {
      if (!this.handController) return;
      const state = this.handController.getState();
      const dcPlayer = state.players.find((p) => p.user_id === disconnectAction.playerId);
      if (!dcPlayer) return;
      try {
        this.handController.performAction(dcPlayer.seat, disconnectAction.action as any);
        console.log(
          `[ServerTableEngine:${this.tableId}] Disconnect auto-${disconnectAction.action} for ${disconnectAction.playerId} (${disconnectAction.reason})`
        );
      } catch (err) {
        reportError(err, 'ServerTableEnginethistableId.Disconnect_autoaction_failed');
      }
    });

    // Wait for hand to complete
    return new Promise<void>((resolve) => {
      // FIX 178: Bible V8 §6.1 — Hand safety timeout must accommodate full multi-player hands.
      // A 9-player hand with 15s action timers × 4 betting rounds = 540s worst case.
      // With time banks + insurance/RIT pauses, 10 minutes is a safe ceiling.
      // The old 60s timeout was killing hands prematurely mid-action.
      const HAND_SAFETY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
      const handTimeout = setTimeout(() => {
        console.warn(`[ServerTableEngine:${this.tableId}] Hand ${handNumber} timed out after 10 minutes`);
        this.handController = null;
        resolve();
      }, HAND_SAFETY_TIMEOUT_MS);

      const unsub = this.handController!.onEvent((event: HandEvent) => {
        this.handleHandEvent(event, players);

        if (event.type === 'HAND_COMPLETE') {
          clearTimeout(handTimeout);
          unsub();

          // FIX 149: Wire telemetry — record hand timing
          const handElapsedMs = Date.now() - handStartMs;
          this.engineTelemetry.recordHandTiming(this.tableId, 0, 0, handElapsedMs);

          // Fire hand-complete callback for tournament chip sync
          this.clearTurnTimer();
          if (this.handCompleteCallback) {
            const finalStacks = players.map((p) => ({
              user_id: p.user_id,
              stack: p.stack,
            }));
            try {
              this.handCompleteCallback(this.tableId, finalStacks);
            } catch (e) {
              reportError(e, 'ServerTableEnginethistableId.handCompleteCallback_error');
            }
          }

          this.handController = null;
          resolve();
        }
      });

      // Start the hand!
      try {
        this.handController!.start();

        // FIX 137: Bible V8 §7.17 — Snapshot initial hand state for crash recovery
        this.saveSnapshot().catch(() => {});
      } catch (err) {
        reportError(err, 'ServerTableEnginethistableId.Failed_to_start_hand');
        clearTimeout(handTimeout);
        unsub();
        this.handController = null;
        resolve();
      }
    });
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // EVENT HANDLING
  // ═════════════════════════════════════════════════════════════════════════════

  private async handleHandEvent(event: HandEvent, players: SeatedPlayer[]): Promise<void> {
    switch (event.type) {
      case 'HAND_START':
        // Bible V8 §1.16 (Real-Time Law): emit a discrete hand_started event
        // so the client can immediately reset visual state (clear last action
        // badges, clear community cards, trigger the deal animation) without
        // waiting for the snapshot to arrive and diff-detect.
        this.hub?.emitEvent(this.tableId, {
          type: 'hand_started',
          table_id: this.tableId,
          hand_number: this.handCount,
          dealer_seat: this.handController?.getState().dealerSeat ?? 0,
          timestamp: Date.now(),
        });
        this.broadcastCurrentState();
        break;

      case 'BLINDS_POSTED' as any: {
        // Bible V8 §1.16: discrete blinds_posted event so the client animates
        // SB/BB chips flying from each blind seat into the pot, instead of
        // letting the chips just appear in the pot via snapshot.
        const postings = (event as any).postings as Array<{ seat: number; type: string; amount: number }> | undefined;
        if (postings && postings.length > 0) {
          this.hub?.emitEvent(this.tableId, {
            type: 'blinds_posted',
            table_id: this.tableId,
            hand_number: this.handCount,
            postings,
            timestamp: Date.now(),
          });
        }
        // No broadcast here — TURN_CHANGE will follow shortly with full snapshot.
        break;
      }

      case 'CARDS_DEALT':
        // Write hole cards to RLS-protected table for secure per-player delivery.
        // The client subscribes to table_hole_cards INSERTs (RLS filters to own cards only).
        // This prevents card data from leaking via the public Realtime broadcast.
        if (event.seat !== undefined && event.cards && this.handController) {
          const state = this.handController.getState();
          const player = state.players.find((p) => p.seat === event.seat);
          if (player) {
            supabase
              .rpc('insert_hole_cards', {
                p_table_id: this.tableId,
                p_hand_number: this.handCount,
                p_cards: JSON.stringify([
                  {
                    user_id: player.user_id,
                    seat_number: player.seat,
                    cards: event.cards,
                  },
                ]),
              })
              .then(({ error }: { error: any }) => {
                if (error) {
                  console.warn(
                    `[ServerTableEngine:${this.tableId}] Failed to insert hole cards for seat ${event.seat}:`,
                    error.message
                  );
                }
              });
          }
        }
        // Do NOT broadcast state here — cards are delivered securely via table_hole_cards
        break;

      case 'TURN_CHANGE': {
        // ROOT-CAUSE FIX 2026-04-14 (Dan: "I timed out and the engine moved
        // on without giving me a chance to act"). Prior flow broadcast the
        // snapshot and the discrete turn_change event while
        // playerTurnStartTime / playerTurnDuration still held the PREVIOUS
        // turn's values. Snapshots therefore carried a deadline_ms /
        // turn_deadline_ms in the past (or 0 on hand #1), so the client's
        // countdown was already at zero the moment the hero's panel
        // rendered — the hero looked timed out before their turn began.
        //
        // Fix respects Bible V8 §1.2.3 (broadcast confirms before next turn)
        // AND §6.1 (deadline-based, server-authoritative). We compute the
        // intended deadline up front, stamp it onto playerTurnStartTime /
        // playerTurnDuration so broadcasts have the right deadline, emit
        // the real-time event and snapshot, THEN arm the enforcement timer.
        // The timer call below skips re-stamping when the deadline already
        // matches, so there is no drift.
        const tcSeatedPlayer = players.find((p) => p.seat_number === event.seat);

        const baseActionTime = this.tableInfo?.action_time_seconds || 15;
        const inReconnectGrace = tcSeatedPlayer?.user_id
          ? this.disconnectEngine.isInReconnectGrace(this.tableId, tcSeatedPlayer.user_id)
          : false;
        const effectiveActionSec = inReconnectGrace ? baseActionTime + 5 : baseActionTime;

        // Stamp the intended deadline NOW so the broadcast carries the
        // current turn's real deadline (start + duration * 1000). The
        // actual DeadlineScheduler registration happens in startTurnTimer
        // below; it reads the same fields so the client + server agree.
        this.playerTurnStartTime = Date.now();
        this.playerTurnDuration = effectiveActionSec;
        this.timeBankActivatedThisTurn = false;

        // FIX-217 + Bible V8 §1.2.3/§1.2.4: Await broadcast delivery BEFORE
        // arming the enforcement timer. Broadcast confirms before next turn.
        await this.broadcastCurrentState();

        // Bible V8 §1.16 (Real-Time Law): discrete turn_change event. Now
        // carries the correct absolute deadline for the CURRENT player.
        this.hub?.emitEvent(this.tableId, {
          type: 'turn_change',
          table_id: this.tableId,
          hand_number: this.handCount,
          seat: event.seat,
          user_id: tcSeatedPlayer?.user_id ?? '',
          deadline_ms: this.playerTurnStartTime + this.playerTurnDuration * 1000,
          timestamp: Date.now(),
        });

        // Finally: arm the enforcement timer + run pre-action / horse logic.
        // handleTurnChange will call startTurnTimer which refreshes the
        // fields; because we set them moments ago the deadline drifts only
        // by the broadcast RTT (a few ms), well within §6.1 tolerances.
        this.handleTurnChange(event, players);
        break;
      }

      case 'PLAYER_ACTION':
        // Track action for hand history
        if (event.seat !== undefined && event.action) {
          const hcState = this.handController?.getState();
          const stage = hcState?.stage || 'preflop';
          const actingPlayer = hcState?.players.find((p) => p.seat === event.seat);
          this.currentHandActions.push({
            seat: event.seat,
            userId: actingPlayer?.user_id ?? '', // Bible V8 §2.5
            action: event.action,
            amount: event.amount,
            timestamp: Date.now(), // Bible V8 §2.5
            stage,
          });

          // Bible V8 §4.15: When a bet or raise occurs, invalidate all auto_check pre-actions
          // (they're no longer valid because there's now a bet to face)
          if (event.action === 'bet' || event.action === 'raise' || event.action === 'all_in') {
            const actingPlayer = this.seatedPlayers.find((p) => p.seat_number === event.seat);
            this.preActionEngine.onBetPlaced(this.tableId, actingPlayer?.user_id || '');
          }

          // 2026-04-14 USER FEEDBACK FIX: emit a discrete player_action event so
          // the client can fire Bible V8 §5.1/§5.2 visual sequence
          // (action label \u2192 chip-to-pot animation \u2192 sound \u2192 turn indicator).
          // Previously the only signal was the full state snapshot, which the
          // client used to update pot only \u2014 chip animations + action labels
          // never fired because their handler was on the deleted Supabase
          // Realtime channel. The full state broadcast still follows below.
          this.hub?.emitEvent(this.tableId, {
            type: 'player_action',
            table_id: this.tableId,
            hand_number: this.handCount,
            seat: event.seat,
            user_id: actingPlayer?.user_id ?? '',
            action: event.action,
            amount: event.amount ?? 0,
            stage,
            timestamp: Date.now(),
          });
        }
        this.broadcastCurrentState();
        break;

      case 'COMMUNITY_CARDS': {
        if (event.stage === 'flop') this.currentHandWentToFlop = true;
        if (event.cards) {
          this.currentHandCommunityCards = event.cards.map((c: any) =>
            typeof c === 'string' ? c : `${c.rank}${c.suit}`
          );
        }
        // Bible V8 §1.16 (Real-Time Law): emit discrete community_cards_dealt
        // so the client slides the flop/turn/river cards onto the board with
        // the spec animation (\u00a76 community cards dealing) the millisecond the
        // engine flips them \u2014 not whenever the next snapshot arrives.
        this.hub?.emitEvent(this.tableId, {
          type: 'community_cards_dealt',
          table_id: this.tableId,
          hand_number: this.handCount,
          stage: event.stage,
          // Send only the NEW cards for this stage so the client can animate
          // just the additions (3 for flop, 1 each for turn/river).
          new_cards: event.cards ?? [],
          // Full board too, for clients that want to render the complete
          // state without diffing.
          board: this.currentHandCommunityCards,
          timestamp: Date.now(),
        });
        this.broadcastCurrentState();
        break;
      }

      case 'PINEAPPLE_DISCARD_REQUIRED':
        // FIX 120: Crazy Pineapple — broadcast discard requirement to all players
        // Each player must discard 1 of their 3 hole cards within the action timer.
        // ServerTableEngine starts a discard timer; auto-discards (last card) on expiry.
        this.handlePineappleDiscard(event);
        this.broadcastCurrentState();
        break;

      case 'ALL_IN_RUNOUT':
        // Bible V8 §4.19: All players are all-in with cards to come.
        // Pause for insurance/RIT offers before dealing remaining community cards.
        this.handleAllInRunout(event, players);
        break;

      case 'SHOWDOWN':
        // Capture showdown hand evaluations for BBJ detection
        this.currentHandShowdownResults = ((event as any).results || []).map((r: any) => ({
          userId: r.userId,
          handRanking: r.hand?.ranking ?? 0,
          handName: r.hand?.name ?? '',
          kickers: r.hand?.kickers ?? [],
          holeCards: (r.cards || []).map((c: any) =>
            typeof c === 'string'
              ? { rank: c.slice(0, -1), suit: c.slice(-1) }
              : { rank: c.rank, suit: c.suit }
          ),
        }));
        this.broadcastCurrentState();
        // 2026-04-16 fix: Emit discrete showdown event so the client can
        // trigger showdown sound + card reveal animations (Bible V8 §4.6).
        // Previously only broadcastCurrentState was called, which sends a
        // state snapshot but NOT a discrete event the client handler matches.
        this.hub?.emitEvent(this.tableId, {
          type: 'showdown',
          table_id: this.tableId,
          hand_number: this.handCount,
          results: this.currentHandShowdownResults.map((r) => ({
            user_id: r.userId,
            hand_name: r.handName,
            hand_ranking: r.handRanking,
          })),
        });
        break;

      case 'WINNERS':
        this.currentHandWinnerIds = (event.winners || []).map(
          (w: any) => w.userId || w.user_id || ''
        );
        // Bible V8 §2.7: Winner Object — userId, amount, potIndex, hand (evaluated hand description)
        this.currentHandWinners = (event.winners || []).map((w: any) => ({
          userId: w.userId || w.user_id || '',
          amount: w.amount || 0,
          potIndex: w.potIndex ?? 0,
          hand: w.hand ? { name: w.hand.name || '', ranking: w.hand.ranking ?? 0 } : undefined,
        }));
        if (this.handController) {
          const state = this.handController.getState();
          this.currentHandPotSize = state.pot;
          // Note: rake + bbjFee are captured from HAND_COMPLETE event, not from state
          // Bible V8 §1.9: Capture totalInvested for equal-share rakeback tracking (FIX 144)
          this.currentHandContributions.clear();
          for (const enginePlayer of state.players) {
            const localPlayer = players.find((p) => p.user_id === enginePlayer.user_id);
            if (localPlayer) localPlayer.stack = enginePlayer.stack;
            // Track actual contributions for rakeback (totalInvested = blinds + bets + raises + calls)
            this.currentHandContributions.set(
              enginePlayer.user_id,
              enginePlayer.totalInvested ?? 0
            );
          }
        }
        this.broadcastCurrentState();
        // Phase 2 T1-05 (spec §6 Pot Shipping Animation): emit a discrete
        // pot_win event so the client can fire its curved-arc chip fan to
        // each winner. Fires for BOTH contested showdowns AND uncontested
        // fold-around wins (HandController emits WINNERS in both cases).
        // The TablePage POT_WIN handler resolves seats from winner_ids and
        // splits the pot across them via createPotToWinnerEvent.
        if (this.currentHandWinnerIds.length > 0) {
          this.hub?.emitEvent(this.tableId, {
            type: 'pot_win',
            table_id: this.tableId,
            hand_number: this.handCount,
            winner_ids: this.currentHandWinnerIds,
            pot: this.currentHandPotSize,
            // Per-winner amounts for accurate sub-pot ship animations on chops
            winners: this.currentHandWinners.map((w) => ({
              user_id: w.userId,
              amount: w.amount,
              hand_name: w.hand?.name,
            })),
          });
        }
        break;

      case 'HAND_COMPLETE':
        // Bible V8 §1.16: discrete hand_complete event so the client can
        // start its post-hand cleanup (winner highlight fade, board clear
        // countdown, prep for next deal animation) without waiting for the
        // snapshot to diff and infer "hand ended".
        this.hub?.emitEvent(this.tableId, {
          type: 'hand_complete',
          table_id: this.tableId,
          hand_number: this.handCount,
          winner_ids: this.currentHandWinnerIds,
          timestamp: Date.now(),
        });
        // Rabbit Hunt: Capture remaining deck cards BEFORE handController is nulled
        if (this.handController) {
          try {
            const remainingDeck = this.handController.getRemainingDeck();
            // Only take the next 5 cards max (enough for any board completion)
            this.currentHandRabbitCards = remainingDeck.slice(0, 5);
          } catch {
            this.currentHandRabbitCards = [];
          }
        }

        // FIX 137: Bible V8 §7.17 — Mark hand snapshot as complete (settlement done)
        completeHandSnapshot(this.tableId, this.handCount).catch(() => {});

        // Capture rake and BBJ fee from hand completion event
        if ((event as any).rake !== undefined) {
          this.currentHandRake = (event as any).rake;
        }
        if ((event as any).bbjFee !== undefined) {
          this.currentHandBBJFee = (event as any).bbjFee;
        }

        // Step 4: State verification — deduct rake + BBJ and verify chip conservation
        const totalDeductions = this.currentHandRake + this.currentHandBBJFee;
        if (totalDeductions > 0) {
          this.stateVerifier.deductRake(this.tableId, totalDeductions);
        }
        if (this.handController) {
          const finalState = this.handController.getState();
          const verifyResult = this.stateVerifier.verify({
            tableId: this.tableId,
            handNumber: this.handCount,
            players: finalState.players,
            communityCards: finalState.communityCards,
            pot: finalState.pot,
            stage: finalState.stage,
          });
          if (!verifyResult.valid) {
            reportError(verifyResult.violations.map((v) => v.message).join('; '), 'ServerTableEnginethistableId.Hand_thishandCount_FAILED_inte');
          }
        }

        // FIX 150: Wire AtomicStackService — settle final stacks through atomic layer
        // Computes delta (final stack - initial stack tracked by version service) for each player
        // so version tracking stays in sync and race conditions with concurrent rebuy/cashout are prevented.
        if (this.handController) {
          const finalState = this.handController.getState();
          const settlements: StackSettlement[] = [];
          for (const p of finalState.players) {
            const initial = this.atomicStackService.getStackWithVersion(this.tableId, p.user_id);
            const delta = p.stack - initial.stack;
            if (delta !== 0) {
              settlements.push({ userId: p.user_id, delta });
            }
          }
          if (settlements.length > 0) {
            const settleResult = this.atomicStackService.atomicSettle(this.tableId, settlements);
            if (!settleResult.success) {
              reportError(settleResult.errors.join('; '), 'ServerTableEnginethistableId.AtomicSettle_failed');
            }
          }
        }

        // Step 4: Clean up validator state between hands
        this.actionValidator.clearTable(this.tableId);
        this.preciseTimer.clearTable(this.tableId);

        // Step 5: Clean up supporting modules between hands
        this.preActionEngine.dispose(this.tableId);
        // Note: timeBankEngine persists across hands (pool model — depletes per session, not per hand)
        //       Per-hand activation counter is reset in dealHand() via resetHandActivations()
        // Note: disconnectEngine persists across hands (tracks connection state)
        // Note: atomicStackService persists across hands (tracks stack versions via FIX 150)

        // Bible V8 §4.19: Settle insurance BEFORE disposing (offers cleared on dispose)
        // FIX 118: Pass ALL winner IDs — chops (multiple winners) = PUSH (insurance voided)
        if (this.currentHandWinnerIds.length > 0) {
          this.currentHandInsuranceSettlements = this.insuranceEngine.settle(
            this.tableId,
            this.currentHandWinnerIds
          );

          // Bible V8 §4.19: Insurance settlement — applied like rake at the end.
          // - LOSER who bought insurance: Gets insuredAmount from union/club bank → credited to table stack
          // - WINNER who bought insurance: Premium deducted from winnings (taken at end like rake)
          // - Player can't lose more than their premium; can't gain more than insuredAmount
          for (const settlement of this.currentHandInsuranceSettlements) {
            const seatedPlayer = this.seatedPlayers.find((p) => p.user_id === settlement.playerId);
            const enginePlayer = this.handController
              ? this.handController
                  .getState()
                  .players.find((p) => p.user_id === settlement.playerId)
              : null;

            if (settlement.payout > 0) {
              // LOSER with insurance: credit payout from union/club bank to table stack
              if (seatedPlayer) {
                seatedPlayer.stack += settlement.payout;
                console.log(
                  `[ServerTableEngine:${this.tableId}] Insurance payout: ${settlement.playerId} lost hand → +$${settlement.payout} from bank`
                );
              }
              if (enginePlayer) enginePlayer.stack += settlement.payout;
            }

            // ALL insured players: premium deducted from their stack at end (like rake)
            // For losers: payout - premium = net gain. For winners: -premium = net cost.
            if (settlement.premium > 0) {
              if (seatedPlayer) {
                seatedPlayer.stack = Math.max(0, seatedPlayer.stack - settlement.premium);
                console.log(
                  `[ServerTableEngine:${this.tableId}] Insurance premium: ${settlement.playerId} → -$${settlement.premium} (stack: $${seatedPlayer.stack})`
                );
              }
              if (enginePlayer) {
                enginePlayer.stack = Math.max(0, enginePlayer.stack - settlement.premium);
              }
            }
          }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // BBJ HIT DETECTION — Check if showdown qualifies as a Bad Beat Jackpot
        // FIX: Respect table-level bbj_percent — if 0, BBJ is disabled for this table
        // ═══════════════════════════════════════════════════════════════════════
        const tableBbjPercent = (this.tableInfo as any)?.bbj_percent ?? 0;
        if (
          tableBbjPercent > 0 &&
          this.currentHandShowdownResults.length >= 2 &&
          this.currentHandWinnerIds.length > 0 &&
          this.tableInfo
        ) {
          const variant = this.tableInfo.game_variant || 'nlh';
          const dealtInPlayerIds = players.map((p) => p.user_id);
          const bbjResult = detectBBJHit(
            this.currentHandShowdownResults,
            this.currentHandWinnerIds[0],
            variant,
            this.currentHandPotSize,
            this.tableInfo.big_blind,
            dealtInPlayerIds.length,
            dealtInPlayerIds
          );

          if (bbjResult.hit) {
            console.log(
              `[ServerTableEngine:${this.tableId}] *** BBJ HIT! *** ` +
                `Loser: ${bbjResult.loserUserId} (${bbjResult.loserHand?.name}), ` +
                `Winner: ${bbjResult.winnerUserId} (${bbjResult.winnerHand?.name})`
            );

            // Get BBJ payout config for this stakes level
            const rakeConfig = getFullRakeConfig(
              this.tableInfo.small_blind,
              this.tableInfo.big_blind,
              variant
            );

            // BBJ payout: chips credited directly to players' table balances
            // The actual pool amounts are fetched from Supabase and paid from union/club bank
            // For now, broadcast the BBJ_HIT event with payout percentages.
            // The actual payout amounts will be calculated in postHandTasks() using the pool balance.
            this.hub?.emitEvent(this.tableId, {
              type: 'bbj_hit',
              table_id: this.tableId,
              hand_number: this.handCount,
              loser: {
                userId: bbjResult.loserUserId,
                hand: bbjResult.loserHand,
                payoutPercent: rakeConfig.bbjPayoutLoser, // % of BBJ pool
              },
              winner: {
                userId: bbjResult.winnerUserId,
                hand: bbjResult.winnerHand,
                payoutPercent: rakeConfig.bbjPayoutWinner,
              },
              tableShare: {
                playerIds: dealtInPlayerIds,
                payoutPercent: rakeConfig.bbjPayoutTable,
              },
              totalPayoutPercent: rakeConfig.bbjPayoutTotalPercent,
              variant,
              qualifyingHandLabel: bbjResult.qualifyingHandLabel,
            });

            // Store BBJ hit for postHandTasks to process the actual payouts
            this.currentHandBBJHit = bbjResult;
            this.currentHandBBJPayoutConfig = rakeConfig;
          }
        }

        // Step 6: Clean up advanced modules between hands
        this.runItTwiceEngine.dispose(this.tableId);
        this.insuranceEngine.dispose(this.tableId);
        // Note: straddleEngine persists (auto-straddle enrollment persists)
        // Note: mixedGameEngine persists (variant rotation is multi-hand)
        // Note: rakebackEngine persists (accumulates across hands)

        // Step 6: Mixed game rotation — notify after each hand
        // FIX 159: Bible V8 §7.20 — when variant rotates, UPDATE tableInfo.game_variant
        // so the NEXT hand uses the new variant for dealing, evaluation, and validation.
        if (this.mixedGameEngine.isActive(this.tableId)) {
          const activePlayers = this.handController
            ? this.handController.getState().players.filter((p) => !p.is_folded).length
            : 0;
          const newVariant = this.mixedGameEngine.onHandComplete(this.tableId, activePlayers);
          if (newVariant && this.tableInfo) {
            console.log(`[ServerTableEngine:${this.tableId}] Mixed game rotation: ${this.tableInfo.game_variant} → ${newVariant}`);
            this.tableInfo.game_variant = newVariant;
          }
        }

        // Step 7: Record telemetry for this hand
        this.engineTelemetry.recordPlayerCount(this.tableId, players.length);

        // FIX 211: Bible V8 §1.9 — Track postHandTasks promise so dealingLoop can await
        // it before starting the next hand, preventing stale DB stacks from race conditions.
        this.postHandTasksPromise = this.postHandTasks(players).catch((err) => reportError(err, 'ServerTableEnginethistableId.Posthand_error'));
        this.currentHandWinnerIds = [];

        // Rabbit Hunt: Broadcast captured remaining deck as a separate event
        // so clients can offer Rabbit Hunt reveal with real cards
        if (this.currentHandRabbitCards.length > 0) {
          this.hub?.emitEvent(this.tableId, {
            type: 'rabbit_hunt_available',
            table_id: this.tableId,
            hand_number: this.handCount,
            rabbit_cards: this.currentHandRabbitCards,
          });
        }
        break;
    }
  }

  /**
   * Bible V8 §4.19: Handle all-in runout pause for insurance/RIT offers.
   * When all active players are all-in with cards to come:
   * 1. Pause the action timer
   * 2. If insurance is enabled: create offers for all all-in players, wait for responses (or timeout)
   * 3. If RIT is enabled and exactly 2 players: offer RIT (handled separately via respondToRIT)
   * 4. After all offers resolved → resume with handController.continueRunout()
   */
  /**
   * FIX 120: Crazy Pineapple — start a discard timer for all active players.
   * Each player has action_time_seconds to pick which card to discard.
   * If they don't respond, auto-discard the last (3rd) card.
   */
  private pineappleDiscardTimer: ReturnType<typeof setTimeout> | null = null;
  private handlePineappleDiscard(event: HandEvent): void {
    if (event.type !== 'PINEAPPLE_DISCARD_REQUIRED' || !this.handController) return;

    const seats = (event as any).seats as number[];
    const timeoutMs = (this.tableInfo?.action_time_seconds || 15) * 1000;

    // Start a single discard timer — when it expires, auto-discard for anyone remaining
    this.pineappleDiscardTimer = setTimeout(() => {
      if (!this.handController) return;
      for (const seat of seats) {
        // Auto-discard last card for any player who hasn't responded
        this.handController.autoDiscard(seat);
      }
      // checkPineappleDiscardsComplete() inside autoDiscard will advance the game
    }, timeoutMs);
  }

  /**
   * FIX 120: Public method for players to submit their Pineapple discard.
   * @param userId - The user submitting the discard
   * @param cardIndex - Which card to discard (0, 1, or 2)
   * @returns success/error
   */
  submitDiscard(userId: string, cardIndex: number): { success: boolean; error?: string } {
    if (!this.handController) {
      return { success: false, error: 'No active hand' };
    }

    const hcState = this.handController.getState();
    if (hcState.stage !== 'pineapple_discard') {
      return { success: false, error: 'Not in discard phase' };
    }

    const player = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!player) {
      return { success: false, error: 'Player not seated' };
    }

    const result = this.handController.performDiscard(player.seat_number, cardIndex);
    if (!result) {
      return { success: false, error: 'Discard rejected' };
    }

    // If all discards are complete, the HandController will advance the game
    // and emit events that trigger broadcasting. Clear the discard timer.
    if (hcState.stage !== 'pineapple_discard') {
      // Stage already advanced — all discards are in
      if (this.pineappleDiscardTimer) {
        clearTimeout(this.pineappleDiscardTimer);
        this.pineappleDiscardTimer = null;
      }
    }

    this.broadcastCurrentState();
    return { success: true };
  }

  private handleAllInRunout(event: HandEvent, players: SeatedPlayer[]): void {
    if (event.type !== 'ALL_IN_RUNOUT' || !this.handController) return;

    const board = (event as any).board as import('../types.js').Card[];
    const pot = (event as any).pot as number;
    const allInPlayers = (event as any).players as import('../types.js').SeatPlayer[];

    // Pause all timers during insurance/RIT decision window
    this.clearTurnTimer();

    // Broadcast current state so clients see the all-in board
    this.broadcastCurrentState();

    // ═══════════════════════════════════════════════════════════════════════
    // EQUITY DISPLAY: Calculate and broadcast equity for ALL all-in players
    // This is shown on every table (insurance or not) for all players/observers.
    // ═══════════════════════════════════════════════════════════════════════
    if (allInPlayers.length >= 2) {
      this.broadcastAllInEquity(allInPlayers, board, pot);
    }

    const insuranceEnabled = this.insuranceEngine.isEnabled(this.tableId);

    if (insuranceEnabled && board.length < 5 && allInPlayers.length >= 2) {
      // ═══════════════════════════════════════════════════════════════════════
      // INSURANCE TABLE: Per-street pause flow
      // Deal one street at a time, pause for insurance offers, then deal next.
      // Each street recalculates equity and re-offers to eligible players.
      // ═══════════════════════════════════════════════════════════════════════
      const offerPlayers = allInPlayers.map((p) => ({
        playerId: p.user_id,
        holeCards: p.cards || [],
      }));

      this.runInsurancePerStreetFlow(offerPlayers, allInPlayers, pot);
    } else {
      // ═══════════════════════════════════════════════════════════════════════
      // FIX 94: RIT (Run It Twice) offer — N-player support.
      // Bible V8 §4.20 + Dan's rules:
      // - RIT is ONLY offered when ALL active players are all-in
      // - ANY number of players (2+), no limit — full table all-in is possible
      // - Player with BEST ACTUAL HAND (not percentages) chooses 1/2/3 boards
      // - ALL other all-in players must AGREE. Any decline → run once.
      // - RIT and Insurance are mutually exclusive (FIX 92).
      // - Multiple side pots are handled: each pot evaluated per board.
      // ═══════════════════════════════════════════════════════════════════════
      const ritEnabled = this.runItTwiceEngine.isEnabled(this.tableId);
      if (ritEnabled && allInPlayers.length >= 2 && board.length < 5) {
        // Determine the chooser: player with the BEST ACTUAL HAND right now
        const variant = this.tableInfo?.game_variant || 'nlh';
        const isOmaha = variant.startsWith('plo');
        const evaluator = isOmaha ? evaluateOmahaHand : evaluateHand;

        let chooserPlayerId = allInPlayers[0].user_id;
        let bestEval = evaluator(allInPlayers[0].cards || [], board);

        for (let i = 1; i < allInPlayers.length; i++) {
          const playerEval = evaluator(allInPlayers[i].cards || [], board);
          if (compareHands(playerEval, bestEval) > 0) {
            bestEval = playerEval;
            chooserPlayerId = allInPlayers[i].user_id;
          }
        }

        const allPlayerIds = allInPlayers.map((p) => p.user_id);

        this.runItTwiceEngine.offer(
          this.tableId,
          `${this.tableId}:${this.handCount}`,
          chooserPlayerId,
          allPlayerIds,
          pot
        );

        // Broadcast RIT offer to ALL clients
        this.hub?.emitEvent(this.tableId, {
          type: 'rit_offer',
          table_id: this.tableId,
          hand_number: this.handCount,
          chooserPlayerId,
          allPlayerIds,
          pot,
          maxRuns: this.runItTwiceEngine.getChosenRuns(this.tableId),
          timeoutSeconds: 10,
        });

        // Wait for all players to respond.
        // Chooser picks 1/2/3 → others accept/decline → engine resolves.
        this.waitForRITResponse(() => {
          if (this.runItTwiceEngine.isActive(this.tableId) && this.handController) {
            // ═══════════════════════════════════════════════════════════════
            // FIX 97: RIT ACCEPTED — Deal multiple boards, evaluate per pot.
            // Bible V8 §4.20: Rake applies ONCE (not per board).
            // Each pot is split across boards (half/half or third/third/third).
            // Each board is evaluated independently for each pot.
            // ═══════════════════════════════════════════════════════════════
            this.dealAndResolveRIT(allInPlayers);
          } else if (this.handController) {
            // Declined — normal single runout
            this.handController.continueRunout();
          }
        });
      } else {
        // NO INSURANCE, NO RIT: Instant full runout (standard behavior)
        this.handController.continueRunout();
      }
    }
  }

  /**
   * Wait for both players to respond to RIT offer.
   * Similar to waitForInsuranceResponses but checks RIT state.
   */
  private waitForRITResponse(onComplete: () => void): void {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearInterval(checkInterval);
      clearTimeout(safetyTimeout);
      onComplete();
    };

    const checkInterval = setInterval(() => {
      const state = this.runItTwiceEngine.getState(this.tableId);
      // Complete when status is no longer 'offered' (accepted, declined, or resolved)
      if (!state || state.status !== 'offered') {
        finish();
      }
    }, 250);

    // FIX 98: Safety timeout: 18 seconds (5s chooser + 10s responders + 3s buffer)
    const safetyTimeout = setTimeout(() => {
      finish();
    }, 18_000);
  }

  /**
   * FIX 97: Deal and resolve RIT (Run It Twice/Three Times).
   * N-player support with side pots.
   *
   * Flow:
   * 1. Get remaining deck cards from HandController
   * 2. Deal 2 or 3 independent boards from remaining deck
   * 3. For each board: evaluate each pot's eligible players → find winner
   * 4. Split each pot across boards (half/half or third/third/third)
   * 5. Sum up distributions and apply to stacks
   * 6. Broadcast results, then finalize the hand
   *
   * Bible V8 §4.20: Rake applies ONCE (not per board).
   */
  private dealAndResolveRIT(allInPlayers: import('../types.js').SeatPlayer[]): void {
    if (!this.handController) return;

    const runs = this.runItTwiceEngine.getChosenRuns(this.tableId);
    if (runs < 2) {
      this.handController.continueRunout();
      return;
    }

    const existingBoard = this.handController.getCommunityCards();
    const remainingDeck = this.handController.getRemainingDeck();
    const cardsNeeded = 5 - existingBoard.length;

    if (remainingDeck.length < cardsNeeded * runs) {
      reportError(new Error(`[ServerTableEngine:${this.tableId}] RIT: Not enough cards for ${runs} runouts (need ${cardsNeeded * runs}, have ${remainingDeck.length})`), 'ServerTableEnginethistableId.RIT');
      this.handController.continueRunout();
      return;
    }

    // Deal independent boards
    const boards: import('../types.js').Card[][] = [];
    for (let r = 0; r < runs; r++) {
      const runCards = remainingDeck.slice(r * cardsNeeded, (r + 1) * cardsNeeded);
      boards.push([...existingBoard, ...runCards]);
    }

    // Get pots from HandController for per-pot evaluation
    const pots = this.handController.getPots();
    const variant = this.tableInfo?.game_variant || 'nlh';
    const isOmaha = variant.startsWith('plo');
    const evaluator = isOmaha ? evaluateOmahaHand : evaluateHand;

    // Distribution: playerId → total chips won across all boards
    const totalDistribution = new Map<string, number>();

    // For each pot, split across boards and evaluate
    for (const pot of pots) {
      const potPerBoard = pot.amount / runs;

      for (let boardIdx = 0; boardIdx < runs; boardIdx++) {
        const board = boards[boardIdx];

        // Find the best hand among eligible players for this pot on this board
        let bestPlayerId = '';
        let bestHand: import('../types.js').EvaluatedHand | null = null;
        const tiedPlayers: string[] = [];

        for (const playerId of pot.eligiblePlayers) {
          const player = allInPlayers.find((p) => p.user_id === playerId);
          if (!player || !player.cards || player.cards.length === 0) continue;

          const hand = evaluator(player.cards, board);

          if (!bestHand) {
            bestHand = hand;
            bestPlayerId = playerId;
            tiedPlayers.length = 0;
            tiedPlayers.push(playerId);
          } else {
            const cmp = compareHands(hand, bestHand);
            if (cmp > 0) {
              bestHand = hand;
              bestPlayerId = playerId;
              tiedPlayers.length = 0;
              tiedPlayers.push(playerId);
            } else if (cmp === 0) {
              tiedPlayers.push(playerId);
            }
          }
        }

        // Distribute this board's share of this pot
        if (tiedPlayers.length > 1) {
          // Split pot among tied players on this board
          const splitAmount = potPerBoard / tiedPlayers.length;
          for (const pid of tiedPlayers) {
            totalDistribution.set(pid, (totalDistribution.get(pid) || 0) + splitAmount);
          }
        } else if (bestPlayerId) {
          totalDistribution.set(
            bestPlayerId,
            (totalDistribution.get(bestPlayerId) || 0) + potPerBoard
          );
        }
      }
    }

    // Round to cents and fix rounding errors
    const totalPot = pots.reduce((sum, p) => sum + p.amount, 0);
    let distributed = 0;
    const entries = [...totalDistribution.entries()];
    for (const [pid, amount] of entries) {
      const rounded = Math.trunc(amount * 100) / 100;
      totalDistribution.set(pid, rounded);
      distributed += rounded;
    }
    // Give rounding remainder to first winner
    if (entries.length > 0 && Math.abs(totalPot - distributed) > 0.001) {
      const [firstPid] = entries[0];
      totalDistribution.set(
        firstPid,
        (totalDistribution.get(firstPid) || 0) + (totalPot - distributed)
      );
    }

    // Apply distributions to player stacks
    const state = this.handController.getState();
    for (const [playerId, amount] of totalDistribution) {
      const enginePlayer = state.players.find((p) => p.user_id === playerId);
      const seatedPlayer = this.seatedPlayers.find((p) => p.user_id === playerId);
      if (enginePlayer) enginePlayer.stack += amount;
      if (seatedPlayer) seatedPlayer.stack += amount;
    }

    // Broadcast RIT results
    this.hub?.emitEvent(this.tableId, {
      type: 'rit_result',
      table_id: this.tableId,
      hand_number: this.handCount,
      runs,
      boards: boards.map((b) => b.map((c) => `${c.rank}${c.suit}`)),
      distribution: Object.fromEntries(totalDistribution),
      pots: pots.map((p) => ({ amount: p.amount, eligiblePlayers: p.eligiblePlayers })),
    });

    // Resolve in RIT engine (for event emission and cleanup)
    // Use first eligible winner per board for the engine's simpler tracking
    const boardWinners = boards.map((board) => {
      let best: import('../types.js').EvaluatedHand | null = null;
      let winnerId = '';
      for (const p of allInPlayers) {
        if (!p.cards || p.cards.length === 0) continue;
        const hand = evaluator(p.cards, board);
        if (!best || compareHands(hand, best) > 0) {
          best = hand;
          winnerId = p.user_id;
        }
      }
      return winnerId;
    });

    this.runItTwiceEngine.resolve(
      this.tableId,
      boardWinners[0] || '',
      boardWinners[1] || '',
      boardWinners[2]
    );

    // FIX 117: skipDistribution=true — RIT already distributed pots per-board above.
    // Without this, completeHand() re-distributes ALL pots → double money.
    this.handController.finalizeRunout(true);
  }

  /**
   * Calculate and broadcast equity percentages for all all-in players.
   * Shown to ALL players and observers at the table — not just insurance tables.
   * Updates each street as new board cards are dealt.
   */
  private broadcastAllInEquity(
    allInPlayers: import('../types.js').SeatPlayer[],
    board: import('../types.js').Card[],
    pot: number
  ): void {
    const numOpponents = allInPlayers.length - 1;
    const equities: Array<{ userId: string; username: string; equity: number; seat: number }> = [];

    for (const player of allInPlayers) {
      const holeCards = player.cards || [];
      if (holeCards.length < 2) continue;

      // FIX 139: Pass shortDeck flag for correct Short Deck hand rankings
      const isShortDeck = this.tableInfo?.game_variant === 'short_deck';
      const equity = monteCarloEquity(holeCards, board, numOpponents, 5000, isShortDeck);
      equities.push({
        userId: player.user_id,
        username: player.username || 'Unknown',
        equity: Math.round(equity * 10) / 10, // 1 decimal place
        seat: player.seat,
      });
    }

    // Broadcast to all clients — this is public information during all-in
    this.hub?.emitEvent(this.tableId, {
      type: 'all_in_equity',
      table_id: this.tableId,
      hand_number: this.handCount,
      board: board.map((c) => `${c.rank}${c.suit}`),
      pot,
      equities,
    });
  }

  /**
   * Per-street insurance flow:
   * 1. Deal one street (flop/turn/river)
   * 2. Re-broadcast equity percentages (updates on-screen equity display)
   * 3. Create or recalculate insurance offers
   * 4. Broadcast offers, wait for responses
   * 5. After responses: check if any eligible players remain
   *    - If ALL players declined for hand → instant runout for remaining streets
   *    - If board incomplete and eligible players exist → go back to step 1
   * 6. After all 5 cards dealt: finalize the hand
   *
   * Dan's rule: "THIS IS VOID IF THE PLAYER DECLINES INSURANCE FOR HAND OPTION.
   * IT WILL RUN OUT NORMAL, UNLESS THAT PLAYER IS NOT 'BEHIND' —
   * INSURANCE WILL BE OFFERED TO THE PLAYER THAT IS 'AHEAD' IF ANY STREETS
   * ARE STILL PENDING."
   */
  private runInsurancePerStreetFlow(
    offerPlayers: Array<{ playerId: string; holeCards: import('../types.js').Card[] }>,
    allInPlayers: import('../types.js').SeatPlayer[],
    pot: number
  ): void {
    if (!this.handController) return;

    // Deal the next street
    const result = this.handController.dealNextStreet();
    this.broadcastCurrentState();

    // ═══════════════════════════════════════════════════════════════════════
    // RE-BROADCAST EQUITY: Update on-screen equity percentages per street.
    // All players and observers see updated equity as each card is dealt.
    // Uses the original allInPlayers (SeatPlayer[]) for proper username/seat data.
    // ═══════════════════════════════════════════════════════════════════════
    this.broadcastAllInEquity(allInPlayers, result.board, pot);

    const offerTimeout = 15; // Matches InsuranceEngine DEFAULT_CONFIG.offerTimeoutSeconds

    // ═══════════════════════════════════════════════════════════════════════
    // FIX 103: Insurance is ONLY offered to the player with the BEST HAND.
    // Dan's rules:
    // - Evaluate all all-in players' hands against the current board
    // - Find the leader (best actual hand, not equity percentages)
    // - If players are TIED (same hand rank + kickers), NO insurance offered
    // - On later streets, re-evaluate — if a different player takes the lead,
    //   insurance is offered to THEM (if they haven't declined for hand)
    // ═══════════════════════════════════════════════════════════════════════
    const variant = this.tableInfo?.game_variant || 'nlh';
    const isOmaha = variant.startsWith('plo');
    const handEvaluator = isOmaha ? evaluateOmahaHand : evaluateHand;

    // Evaluate all hands on current board
    const playerEvals = offerPlayers.map((p) => ({
      ...p,
      hand: handEvaluator(p.holeCards, result.board),
    }));

    // Sort by hand rank descending (best first)
    playerEvals.sort((a, b) => compareHands(b.hand, a.hand));

    // Check for tie: if top two players have identical hands, no insurance
    const isTied =
      playerEvals.length >= 2 && compareHands(playerEvals[0].hand, playerEvals[1].hand) === 0;

    const bestHandPlayer = isTied ? null : playerEvals[0];

    // FIX 139: Pass shortDeck to insurance engine for correct equity calculations
    const isShortDeckInsurance = this.tableInfo?.game_variant === 'short_deck';

    // Check if this is the first street of offers or a recalculation
    const existingOffers = this.insuranceEngine.getOffers(this.tableId);

    if (existingOffers.length === 0) {
      // First time: create offer for ONLY the best hand player
      if (bestHandPlayer) {
        const offers = this.insuranceEngine.createOffers(
          this.tableId,
          `${this.tableId}:${this.handCount}`,
          [bestHandPlayer], // ONLY the leader gets insurance
          result.board,
          pot,
          isShortDeckInsurance
        );

        if (offers.length > 0) {
          this.broadcastInsuranceOffers(offers, pot, offerTimeout);
        }
      } else {
        console.log(
          `[ServerTableEngine:${this.tableId}] Insurance: Tied hands — no insurance offered`
        );
      }
    } else {
      // Subsequent streets: recalculate equity and re-evaluate leadership.
      // Clear old offers and create new one for the current leader.
      if (bestHandPlayer) {
        // Dispose old offers and create fresh for the new leader
        this.insuranceEngine.dispose(this.tableId);
        this.insuranceEngine.configure(this.tableId, { enabled: true });

        // Only re-offer if the leader hasn't declined for hand
        const prevOffers = existingOffers;
        const leaderPrevOffer = prevOffers.find((o) => o.playerId === bestHandPlayer.playerId);
        const leaderDeclinedForHand = leaderPrevOffer?.declinedForHand ?? false;

        if (!leaderDeclinedForHand) {
          const offers = this.insuranceEngine.createOffers(
            this.tableId,
            `${this.tableId}:${this.handCount}`,
            [bestHandPlayer],
            result.board,
            pot,
            isShortDeckInsurance
          );

          if (offers.length > 0) {
            this.broadcastInsuranceOffers(offers, pot, offerTimeout);
          }
        }
      } else {
        console.log(
          `[ServerTableEngine:${this.tableId}] Insurance: Tied hands on new street — no insurance offered`
        );
      }
    }

    // If all 5 cards are dealt, finalize after insurance responses
    if (result.complete) {
      // Wait for any pending offers then finalize
      this.waitForInsuranceResponses(() => {
        if (this.handController) {
          this.handController.finalizeRunout();
        }
      });
    } else {
      // More streets to come — wait for responses, then check eligibility
      this.waitForInsuranceResponses(() => {
        // ═══════════════════════════════════════════════════════════════════
        // FIX 88: Check if per-street pause should continue or revert to
        // instant runout. If ALL players have declined for the entire hand,
        // the per-street pause is VOID — run out remaining streets instantly.
        // If at least one player hasn't declined for hand, continue pausing.
        //
        // Dan's rule: "THIS IS VOID IF THE PLAYER DECLINES INSURANCE FOR
        // HAND OPTION. IT WILL RUN OUT NORMAL, UNLESS THAT PLAYER IS NOT
        // 'BEHIND' — INSURANCE WILL BE OFFERED TO THE PLAYER THAT IS
        // 'AHEAD' IF ANY STREETS ARE STILL PENDING."
        // ═══════════════════════════════════════════════════════════════════
        if (!this.insuranceEngine.anyEligibleForInsurance(this.tableId)) {
          // ALL players declined for hand — per-street pause is void.
          // Deal remaining streets instantly and finalize.
          console.log(
            `[ServerTableEngine:${this.tableId}] All players declined insurance for hand — switching to instant runout`
          );
          if (this.handController) {
            this.handController.continueRunout();
          }
        } else {
          // At least one player eligible — continue per-street pause
          this.runInsurancePerStreetFlow(offerPlayers, allInPlayers, pot);
        }
      });
    }
  }

  /**
   * Broadcast insurance offers to clients via Supabase Realtime.
   * Includes all fields needed for the InsurancePanel slider UI.
   */
  private broadcastInsuranceOffers(
    offers: import('./InsuranceEngine.js').InsuranceOffer[],
    pot: number,
    timeoutSeconds: number
  ): void {
    this.hub?.emitEvent(this.tableId, {
      type: 'insurance_offers',
      table_id: this.tableId,
      hand_number: this.handCount,
      pot,
      offers: offers.map((o) => ({
        playerId: o.playerId,
        equity: o.equity,
        fullPremium: o.fullPremium,
        premium: o.premium,
        fullInsuredAmount: o.fullInsuredAmount,
        insuredAmount: o.insuredAmount,
        coveragePercent: o.coveragePercent,
        timeoutSeconds,
      })),
    });
  }

  /**
   * Poll for all insurance responses to be resolved (accepted/declined/timed out).
   * Once all responded, invoke the callback to continue the hand.
   */
  private waitForInsuranceResponses(onComplete: () => void): void {
    let completed = false;
    const finish = () => {
      if (completed) return; // Guard: exactly-once invocation
      completed = true;
      clearInterval(checkInterval);
      clearTimeout(safetyTimeout);
      onComplete();
    };

    const checkInterval = setInterval(() => {
      if (this.insuranceEngine.allResponded(this.tableId)) {
        finish();
      }
    }, 250); // Check every 250ms

    // Safety timeout: if insurance engine's own timeouts somehow fail, force continue after 20s
    const safetyTimeout = setTimeout(() => {
      if (!this.insuranceEngine.allResponded(this.tableId)) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Insurance safety timeout — forcing continue`
        );
        // Decline any remaining offers
        for (const offer of this.insuranceEngine.getOffers(this.tableId)) {
          if (offer.status === 'offered') {
            this.insuranceEngine.decline(this.tableId, offer.playerId);
          }
        }
      }
      finish();
    }, 20_000);
  }

  /**
   * Handle horse AI turn — INSTANT decisions, no browser timers needed
   */
  private handleTurnChange(event: HandEvent, players: SeatedPlayer[]): void {
    if (event.type !== 'TURN_CHANGE' || !this.handController) return;

    const seat = event.seat;
    const player = players.find((p) => p.seat_number === seat);
    if (!player) return;

    const state = this.handController.getState();
    const enginePlayer = state.players.find((p) => p.seat === seat);
    if (!enginePlayer) return;

    // ═══════════════════════════════════════════════════════════════════════════
    // UNIFIED TURN HANDLING — Horses and real players follow the EXACT same flow.
    // Bible V8: Horses MUST be indistinguishable from real players.
    // Same timer, same broadcast, same action path. NO EXCEPTIONS.
    // ═══════════════════════════════════════════════════════════════════════════

    const actionTime = this.tableInfo?.action_time_seconds || 15;
    this.timeBankActivatedThisTurn = false; // Reset anti-spam lock for this NEW turn

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
      try {
        this.handController!.performAction(seat, preResult.action as any, preResult.amount);
        console.log(
          `[ServerTableEngine:${this.tableId}] Pre-action executed: ${player.user_id} → ${preResult.action}${preResult.amount ? ` ${preResult.amount}` : ''}`
        );
        return; // Pre-action handled the turn — no timer needed
      } catch (err) {
        console.warn(
          `[ServerTableEngine:${this.tableId}] Pre-action failed, falling through to timer:`,
          err
        );
      }
    }

    // Step 2: Check disconnect state before starting timer (applies to ALL players)
    const playerCanAct = this.disconnectEngine.onPlayerTurn(
      this.tableId,
      player.user_id,
      canCheckForPreAction
    );
    if (!playerCanAct) {
      // Player is disconnected or sitting out — DisconnectEngine will handle auto-action via callback
      return;
    }

    // Step 3: Reconnect grace (applies to ALL players)
    const reconnectGrace = this.disconnectEngine.isInReconnectGrace(this.tableId, player.user_id);
    const effectiveActionTime = reconnectGrace ? actionTime + 5 : actionTime;
    if (reconnectGrace) {
      console.log(
        `[ServerTableEngine:${this.tableId}] Player ${player.user_id} in reconnect grace — extending timer by 5s (${effectiveActionTime}s total)`
      );
    }

    // Step 4: Start the authoritative turn timer — SAME for horses and real players
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
  private scheduleHorseAction(
    player: SeatedPlayer,
    seat: number,
    enginePlayer: any,
    state: { currentBet: number; minRaise: number; pot: number; communityCards: any[]; players: any[]; stage: string }
  ): void {
    const toCall = Math.max(0, state.currentBet - enginePlayer.bet);

    const styleMap: Record<string, HorseStyle> = {
      tag: 'tag',
      lag: 'lag',
      balanced: 'balanced',
      tricky: 'tricky',
      grinder: 'grinder',
      reg: 'tag',
      fish: 'balanced',
      nit: 'grinder',
      maniac: 'lag',
    };
    const horseStyle: HorseStyle = styleMap[player.horse_profile || 'balanced'] || 'balanced';

    const gameState = {
      players: state.players,
      communityCards: state.communityCards,
      pot: state.pot,
      currentBet: state.currentBet,
      minRaise: state.minRaise,
      stage: state.stage,
      gameVariant: (this.tableInfo?.game_variant || 'nlh') as string,
      bigBlind: this.tableInfo?.big_blind || 2,
    };

    // Get decision — SYNCHRONOUS
    const decision = HorseLogic.decide(enginePlayer as any, gameState as any, horseStyle);

    // Realistic think time: 2-8 seconds (simulates human decision-making)
    // Simple decisions (check, fold) = 2-3s; complex (raise, all-in) = 4-8s
    const baseThinkMs = decision.action === 'check' || decision.action === 'fold'
      ? 2000 + Math.random() * 1500   // 2.0 - 3.5s for simple actions
      : 3000 + Math.random() * 5000;  // 3.0 - 8.0s for complex actions
    const thinkTimeMs = Math.round(baseThinkMs);

    const handControllerRef = this.handController;

    setTimeout(() => {
      if (!handControllerRef || !this.running) return;

      // Verify it's still this player's turn (timer might have expired)
      const currentState = handControllerRef.getState();
      if (currentState.currentPlayerSeat !== seat) return;

      let action = decision.action as string;
      let amount = decision.amount;

      // Normalize actions
      if (action === 'allin') action = 'all_in';
      if (action === 'check' && toCall > 0) action = 'call';
      if (action === 'call' && toCall === 0) action = 'check';
      if (action === 'call') amount = toCall;
      if (action === 'fold' && toCall === 0) action = 'check';
      if (action === 'raise' && state.currentBet === 0) action = 'bet';
      if (action === 'bet' && state.currentBet > 0) action = 'raise';

      // Clamp amounts
      if (action === 'bet' && amount !== undefined) {
        amount = Math.max(state.minRaise, amount);
        if (amount >= enginePlayer.stack) {
          action = 'all_in';
          amount = undefined;
        }
      } else if (action === 'raise' && amount !== undefined) {
        const minRaiseTo = state.currentBet + state.minRaise;
        amount = Math.max(minRaiseTo, amount);
        const maxRaiseTo = enginePlayer.stack + enginePlayer.bet;
        if (amount >= maxRaiseTo) {
          action = 'all_in';
          amount = undefined;
        }
      }

      try {
        handControllerRef.performAction(seat, action as any, amount);
      } catch {
        // FIX 210: Bible V8 §1.7.4 — preferCheckOverFold: try check before fold
        try {
          handControllerRef.performAction(seat, 'check');
        } catch {
          try {
            handControllerRef.performAction(seat, 'fold');
          } catch {
            /* Hand done */
          }
        }
      }
    }, thinkTimeMs);
  }

  /**
   * Broadcast current hand state to all table viewers.
   * FIX-217: Now returns Promise so critical paths can await delivery.
   * Bible V8 §1.2.3: "Broadcast must confirm before next turn begins"
   */
  private broadcastCurrentState(): Promise<void> {
    if (!this.handController || !this.tableInfo) return Promise.resolve();

    const state = this.handController.getState();
    const currentSeatPlayer = state.players.find((p) => p.seat === state.currentPlayerSeat);

    // Phase 1.1 PR-2: Build the payload once, publish to both the authoritative
    // WebSocket hub (direct to browser) AND the legacy Supabase Realtime
    // channel. PR-5 removes the Supabase leg once WS is verified in prod.
    const payload = {
      table_id: this.tableId,
      hand_number: this.handCount,
      pot: state.pot ?? 0,
      community_cards: state.communityCards ?? [],
      current_bet: state.currentBet ?? 0,
      current_player: currentSeatPlayer?.user_id ?? null,
      dealer_seat: state.dealerSeat ?? this.currentHandDealerSeat,
      stage: state.stage ?? 'preflop',
      // Bible V8 §5.1: Winner IDs for client-side winner highlighting + sound
      winner_ids: this.currentHandWinnerIds.length > 0 ? this.currentHandWinnerIds : [],
      // Bible V8 §2.7: Winner amounts for pot distribution display
      winners: this.currentHandWinners.length > 0 ? this.currentHandWinners : [],
      // Bible V8 §2.4: Required betting state fields
      min_raise: state.minRaise ?? 0,
      last_raise: state.lastRaise ?? 0,
      turn_start_time_ms: this.playerTurnStartTime,
      turn_duration_ms: this.playerTurnDuration * 1000, // Convert seconds → milliseconds
      // Phase 1.2 PR-F: absolute wall-clock deadline. Client reads this
      // directly rather than computing start+duration locally, eliminating
      // client/server clock skew for the countdown.
      turn_deadline_ms:
        this.playerTurnStartTime > 0
          ? this.playerTurnStartTime + this.playerTurnDuration * 1000
          : 0,
      // Phase 1.2 PR-F: per-user disconnect FSM map for client UI toasts
      // (MISSING / DISCONNECTED). Same shape the DB stores.
      disconnect_states: this.disconnectEngine.getFsmStatesForTable(this.tableId),
      // Bible V8 §2.4: Side pot information for multi-way all-ins
      pots: (state.pots ?? []).map((p) => ({
        amount: p.amount,
        eligible: p.eligiblePlayers ?? [],
      })),
      // Bible V8 §2.4: Action history for the current hand
      // Bible V8 §2.5: Action Record — seat, userId, action, amount, timestamp, stage
      action_history: (state.actionHistory ?? []).map((a) => ({
        seat: a.seat,
        userId: a.userId ?? '',
        action: a.action,
        amount: a.amount,
        timestamp: a.timestamp ?? 0,
        stage: a.stage,
      })),
      // Bible V8 §2.3: Complete player objects with all required fields
      // CARD SECURITY: Scrub hole cards from public broadcast.
      // Players receive their own cards via RLS-protected table_hole_cards channel.
      // Bible V8 §4.21: Auto-muck — at showdown, only show:
      //   - Winners (must always show)
      //   - Players who voluntarily chose to show (showHandPlayers set)
      //   - All non-folded players if auto_muck is DISABLED
      players: (() => {
        const positionLabels = this.getPositionLabels(
          state.dealerSeat ?? this.currentHandDealerSeat,
          state.players ?? []
        );
        return (state.players ?? []).map((p) => {
          let showCards = false;
          if (state.stage === 'showdown' && !p.is_folded) {
            const isWinner = this.currentHandWinnerIds.includes(p.user_id);
            const voluntarilyShowing = this.showHandPlayers?.has(p.user_id) ?? false;
            const autoMuckEnabled = this.tableInfo?.auto_muck_enabled ?? true;
            showCards = isWinner || voluntarilyShowing || !autoMuckEnabled;
          }
          return {
            seat: p.seat,
            user_id: p.user_id,
            username: p.username,
            stack: p.stack,
            bet: p.bet ?? 0,
            totalInvested: p.totalInvested ?? 0, // Bible V8 §2.3
            cards: showCards ? (p.cards ?? []) : [],
            is_folded: p.is_folded ?? false,
            is_all_in: p.is_all_in ?? false,
            is_sitting_out: p.is_sitting_out ?? false,
            is_disconnected: !this.disconnectEngine.isConnected(this.tableId, p.user_id), // Bible V8 §2.3
            time_bank_remaining: this.timeBankEngine.getRemainingSeconds(this.tableId, p.user_id), // Bible V8 §2.3
            time_bank_uses_remaining: this.timeBankEngine.getUsesRemaining(this.tableId, p.user_id), // Bible V8 §2.3
            position: positionLabels.get(p.seat) ?? '', // Bible V8 §2.3, Appendix B
            avatar_url: p.avatar_url ?? '', // Bible V8 §2.3
            is_horse: p.is_horse ?? false, // Bible V8 §2.3
            // Bible V8 §5.1 + §2.7: Hand name at showdown for winner label display
            hand_name: showCards
              ? (this.currentHandShowdownResults.find((r) => r.userId === p.user_id)?.handName ?? '')
              : '',
          };
        });
      })(),
    };

    // Phase 1.1 PR-5: Publish ONLY to the authoritative WebSocket hub.
    // The legacy Supabase Realtime broadcast path has been deleted.
    // All game-state delivery now flows through the native WS hub.
    if (this.hub) {
      this.hub.publish(this.tableId, payload);
    } else {
      console.warn(`[ServerTableEngine:${this.tableId}] No hub attached — state not delivered to clients`);
    }
    return Promise.resolve();
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // POST-HAND TASKS
  // ═════════════════════════════════════════════════════════════════════════════

  private async postHandTasks(players: SeatedPlayer[]): Promise<void> {
    // 1. Sync stacks to database
    await syncStacks(
      this.tableId,
      players.map((p) => ({
        user_id: p.user_id,
        stack: p.stack,
        time_bank_uses_remaining: p.time_bank_uses_remaining,
      }))
    );

    // 2. Log rake collection — every penny documented
    if (!this.isTournamentTable() && this.currentHandRake > 0 && this.tableInfo?.club_id) {
      await logRakeCollection(
        this.tableId,
        this.tableInfo.club_id,
        this.handCount,
        this.currentHandRake,
        this.currentHandPotSize
      );
    }

    // 2a. Log BBJ contribution — simultaneous with rake, per authoritative schedule
    if (!this.isTournamentTable() && this.currentHandBBJFee > 0 && this.tableInfo?.club_id) {
      await logBBJCollection(
        this.tableId,
        this.tableInfo.club_id,
        this.handCount,
        this.currentHandBBJFee,
        this.tableInfo.big_blind
      );
    }

    // 2b. Step 6: FIX 144: Track rake for EQUAL-SHARE rakeback (NOT weighted)
    // Each dealt-in player gets credited with an EQUAL share of the total rake.
    // This is the key metric for weekly player/agent earnings.
    if (!this.isTournamentTable() && this.currentHandRake > 0 && this.tableInfo?.club_id) {
      // Pass contributions map (used to identify dealt-in players, NOT for weighting)
      const dealtInCount = this.currentHandContributions.size;
      if (dealtInCount > 0) {
        this.rakebackEngine.recordHandRake(
          this.tableInfo.club_id,
          this.currentHandRake,
          this.currentHandContributions,
          0 // totalPotContributions no longer used for weighting (FIX 144)
        );

        // 2b-DURABILITY: Also persist per-hand contributions to rake_records so
        // RakebackSettlerService can derive equal-share credit even after engine
        // restart. (BUG 008 — settleRakeback in-memory accumulator never flushes;
        // rake_records is the durable per-hand audit trail the settler reads from.)
        try {
          const contribsObj: Record<string, number> = {};
          for (const [uid, amt] of this.currentHandContributions.entries()) {
            contribsObj[uid] = amt;
          }
          await supabase.from('rake_records').insert({
            table_id: this.tableId,
            club_id: this.tableInfo.club_id,
            rake_amount: this.currentHandRake,
            bbj_contribution: this.currentHandBBJFee,
            pot_size: this.currentHandPotSize,
            num_players: dealtInCount,
            player_contributions: contribsObj,
            is_tournament: false,
            tournament_id: this.tableInfo.tournament_id || null,
            source: 'ServerTableEngine.handEnd',
            metadata: { handCount: this.handCount },
          });
        } catch (rrErr) {
          console.warn('[Engine] rake_records durable write failed (non-fatal):', rrErr);
        }
      }
    }

    // 3. Log hand history — complete audit trail
    if (this.tableInfo) {
      await logHandHistory({
        tableId: this.tableId,
        tournamentId: this.tableInfo.tournament_id || undefined,
        handNumber: this.handCount,
        gameVariant: this.tableInfo.game_variant || 'nlh',
        smallBlind: this.tableInfo.small_blind,
        bigBlind: this.tableInfo.big_blind,
        potSize: this.currentHandPotSize,
        rakeAmount: this.currentHandRake,
        bbjAmount: this.currentHandBBJFee,
        communityCards: this.currentHandCommunityCards,
        winners: this.currentHandWinners,
        players: players.map((p) => ({
          userId: p.user_id,
          username: p.username,
          seat: p.seat_number,
          stack: p.stack,
          cards: [],
        })),
        actions: this.currentHandActions,
      });
    }

    // 3b. Bible V8 §4.19: Log insurance settlements (settled in HAND_COMPLETE handler)
    // Insurance premiums → union bank (or club bank for standalone)
    // Insurance payouts → from union bank (or club bank) to player
    if (
      !this.isTournamentTable() &&
      this.tableInfo?.club_id &&
      this.currentHandInsuranceSettlements.length > 0
    ) {
      for (const settlement of this.currentHandInsuranceSettlements) {
        await logInsuranceSettlement({
          tableId: this.tableId,
          clubId: this.tableInfo.club_id,
          handNumber: this.handCount,
          playerId: settlement.playerId,
          equityPercent: 0, // Equity was in the offer, not settlement — will enhance later
          premium: settlement.premium,
          insuredAmount: settlement.insuredAmount,
          payout: settlement.payout,
          playerWon: !settlement.won, // settlement.won = insurance paid out = player lost the hand
        });
      }
    }

    // 3c. BBJ Payout — if a BBJ hit was detected in HAND_COMPLETE, process the actual payout
    // Chips credited directly to players' table balances from union/club BBJ pool
    if (
      !this.isTournamentTable() &&
      this.tableInfo?.club_id &&
      this.currentHandBBJHit?.hit &&
      this.currentHandBBJPayoutConfig
    ) {
      const bbjHit = this.currentHandBBJHit;
      const payoutConfig = this.currentHandBBJPayoutConfig;
      const result = await processBBJPayout({
        tableId: this.tableId,
        clubId: this.tableInfo.club_id,
        handNumber: this.handCount,
        loserUserId: bbjHit.loserUserId!,
        winnerUserId: bbjHit.winnerUserId!,
        loserHandName: bbjHit.loserHand?.name || 'Unknown',
        winnerHandName: bbjHit.winnerHand?.name || 'Unknown',
        dealtInPlayerIds: bbjHit.dealtInPlayerIds || [],
        payoutTotalPercent: payoutConfig.bbjPayoutTotalPercent,
      });

      if (result) {
        // Credit chips directly to players' table stacks
        // LOSER (bad beat holder) gets 50% of total payout
        const loserSeat = players.find((p) => p.user_id === bbjHit.loserUserId);
        if (loserSeat) {
          loserSeat.stack += result.loserShare;
          console.log(
            `[ServerTableEngine:${this.tableId}] BBJ → Loser ${bbjHit.loserUserId} +$${result.loserShare}`
          );
        }

        // WINNER (hand winner) gets 25% of total payout
        const winnerSeat = players.find((p) => p.user_id === bbjHit.winnerUserId);
        if (winnerSeat) {
          winnerSeat.stack += result.winnerShare;
          console.log(
            `[ServerTableEngine:${this.tableId}] BBJ → Winner ${bbjHit.winnerUserId} +$${result.winnerShare}`
          );
        }

        // TABLE SHARE: remaining 25% split equally among dealt-in players (excluding loser/winner)
        const tableOnlyPlayers = (bbjHit.dealtInPlayerIds || []).filter(
          (id) => id !== bbjHit.loserUserId && id !== bbjHit.winnerUserId
        );
        for (const playerId of tableOnlyPlayers) {
          const seat = players.find((p) => p.user_id === playerId);
          if (seat) {
            seat.stack += result.perPlayerShare;
            console.log(
              `[ServerTableEngine:${this.tableId}] BBJ → Table player ${playerId} +$${result.perPlayerShare}`
            );
          }
        }

        // Re-sync stacks to database with BBJ payouts included
        await syncStacks(
          this.tableId,
          players.map((p) => ({
            user_id: p.user_id,
            stack: p.stack,
            time_bank_uses_remaining: p.time_bank_uses_remaining,
          }))
        );

        // Broadcast updated stacks + BBJ payout details so clients show the celebration
        this.hub?.emitEvent(this.tableId, {
          type: 'bbj_payout_complete',
          table_id: this.tableId,
          hand_number: this.handCount,
          totalPayout: result.totalPayout,
          loser: { userId: bbjHit.loserUserId, share: result.loserShare },
          winner: { userId: bbjHit.winnerUserId, share: result.winnerShare },
          tableShare: result.tableShare,
          perPlayerShare: result.perPlayerShare,
          tablePlayerIds: tableOnlyPlayers,
          // Include updated stacks for all players
          updatedStacks: players.map((p) => ({ userId: p.user_id, stack: p.stack })),
        });

        console.log(
          `[ServerTableEngine:${this.tableId}] BBJ payout complete: $${result.totalPayout} distributed to ${players.length} players`
        );
      }
    }

    // 4. Tournament chip sync
    if (this.isTournamentTable() && this.tableInfo?.tournament_id) {
      await syncTournamentChips(this.tableId, this.tableInfo.tournament_id);
    }

    // 5. Auto-rebuy busted horses (cash games only)
    if (!this.isTournamentTable()) {
      const bustHorses = players.filter((p) => p.is_horse && p.stack === 0);
      for (const horse of bustHorses) {
        const currentRebuys = this.horseRebuys.get(horse.user_id) || 0;

        // Stop-Loss Bankroll logic: if they have rebought twice already (lost 3 buy-ins total), they leave
        if (currentRebuys >= 2) {
          await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
          this.horseRebuys.delete(horse.user_id);
          console.log(
            `[ServerTableEngine:${this.tableId}] Stop-Loss: Horse ${horse.username} lost 3 buy-ins and has been removed.`
          );
          continue;
        }

        const rebuyAmount = this.tableInfo?.big_blind ? this.tableInfo.big_blind * 100 : 200;
        const success = await autoRebuyHorse(
          this.tableId,
          horse.user_id,
          rebuyAmount,
          this.tableInfo?.club_id || ''
        );
        if (success) {
          horse.stack = rebuyAmount;
          this.horseRebuys.set(horse.user_id, currentRebuys + 1);
          console.log(
            `[ServerTableEngine:${this.tableId}] Auto-rebuy: ${horse.username} -> ${rebuyAmount} chips (Rebuy #${currentRebuys + 1})`
          );
        } else {
          await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
          this.horseRebuys.delete(horse.user_id);
          console.log(
            `[ServerTableEngine:${this.tableId}] Horse ${horse.username} left — insufficient funds`
          );
        }
      }
    }

    // 5.5 Auto-Cashout successful horses (Hit-and-Run Bankroll Management)
    // Always wait until right before they are the Big Blind to leave.
    if (!this.isTournamentTable() && players.length >= 2) {
      const maxBuyIn = (this.tableInfo?.big_blind || 2) * 200;

      // Calculate who will be the next Big Blind
      // If 2 players: BB is the non-dealer. dealerSeatIndex currently points to the NEXT dealer.
      // So next dealer is at this.dealerSeatIndex % players.length. BB is at (this.dealerSeatIndex + 1) % players.length.
      // If >2 players: BB is at (this.dealerSeatIndex + 2) % players.length.
      const bbOffset = players.length === 2 ? 1 : 2;
      const nextBbSeatIndex = (this.dealerSeatIndex + bbOffset) % players.length;
      const nextBbPlayer = players[nextBbSeatIndex];

      const cashedOutHorses = players.filter((p) => {
        if (!p.is_horse) return false;

        // Target is dynamically between 2.5x and 3.5x max buy-in
        // We use their user_id to deterministically seed their target, so they don't randomly flip-flop
        const idInt = parseInt(p.user_id.replace(/-/g, '').substring(0, 8), 16) || 0;
        const targetMultiplier = 2.5 + idInt / 0xffffffff;
        const cashOutTarget = maxBuyIn * targetMultiplier;

        // Only depart if they hit the target AND their NEXT hand is the Big Blind
        const isNextBb = p.user_id === nextBbPlayer?.user_id;

        return p.stack >= cashOutTarget && isNextBb;
      });

      for (const horse of cashedOutHorses) {
        await markSeatAsLeft(this.tableId, horse.user_id, horse.seat_number);
        this.horseRebuys.delete(horse.user_id);
        console.log(
          `[ServerTableEngine:${this.tableId}] Bankroll Management: Horse ${horse.username} hit profit target (${Math.floor(horse.stack)} chips) and cashed out before posting the Big Blind.`
        );
      }
    }

    // 5.9 FIX 143: Bible V8 §7.12 — Apply deferred sit-outs now that the hand is over
    if (this.pendingSitOut.size > 0) {
      for (const userId of this.pendingSitOut) {
        this.disconnectEngine.sitOut(this.tableId, userId, 'voluntary');
        console.log(
          `[ServerTableEngine:${this.tableId}] Deferred sit-out applied: ${userId}`
        );
      }
      this.pendingSitOut.clear();
    }

    // 6. Process leave-pending players (cash games only)
    if (!this.isTournamentTable()) {
      await processLeavePending(this.tableId, this.tableInfo?.club_id || '');
    }

    // 7. Authoritative recount of table players from DB (not stale in-memory array)
    const { count: dbPlayerCount } = await supabase
      .from('table_seats')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', this.tableId)
      .is('left_at', null);
    const finalCount = dbPlayerCount ?? 0;
    await updateTableStatus(this.tableId, finalCount, finalCount >= 2 ? 'running' : 'waiting');
  }

  /**
   * Bible V8 §2.3 — Calculate position labels for each seat (BTN, SB, BB, UTG, MP, CO, etc.)
   * Uses Appendix B position naming convention.
   */
  private getPositionLabels(dealerSeat: number, players: SeatPlayer[]): Map<number, string> {
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
      // FIX 177: Bible V8 Appendix B: 3 players → BTN/SB, BB, UTG
      // BTN IS the SB in 3-player (no separate SB position). Third player is UTG.
      labels.set(seats[dealerIdx], 'BTN');
      labels.set(seats[(dealerIdx + 1) % n], 'BB');
      labels.set(seats[(dealerIdx + 2) % n], 'UTG');
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

  private getNextSeat(fromSeat: number, players: SeatedPlayer[]): number {
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
  private getRakeConfig(sb: number, bb: number): RakeConfig {
    const variant = this.tableInfo?.game_variant || 'nlh';
    const fullConfig = getFullRakeConfig(sb, bb, variant);
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
  private getFullRakeAndBBJConfig() {
    const sb = this.tableInfo?.small_blind ?? 1;
    const bb = this.tableInfo?.big_blind ?? 2;
    const variant = this.tableInfo?.game_variant || 'nlh';
    return getFullRakeConfig(sb, bb, variant);
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // UTILITY
  // ═════════════════════════════════════════════════════════════════════════════

  private sleep(ms: number): Promise<void> {
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
  private async saveSnapshot(): Promise<void> {
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
      rakeConfig: {
        percent: fullRakeConfig.rakePercent,
        cap: fullRakeConfig.rakeCap,
        noFlopNoDrop: true,
        // FIX 166: Bible V8 §7.19 — player-count-based rake caps (heads-up = 50%, 3-handed = 67%)
        playerCountCaps: getPlayerCountCaps(fullRakeConfig.rakeCap),
      },
      bbjConfig: {
        enabled: fullRakeConfig.bbjEnabled,
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
    if (
      pendingDeadlines.length > 0 ||
      Object.keys(disconnectStates).length > 0
    ) {
      await saveHandSnapshotExtras({
        tableId: this.tableId,
        handNumber: this.handCount,
        pendingDeadlines,
        disconnectStates,
      });
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
}
