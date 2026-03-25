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
import { AtomicStackService } from './AtomicStackService.js';
import { StraddleEngine } from './StraddleEngine.js';
import { MixedGameEngine } from './MixedGameEngine.js';
import { RunItTwiceEngine } from './RunItTwiceEngine.js';
import { InsuranceEngine } from './InsuranceEngine.js';
import { RakebackEngine } from './RakebackEngine.js';
import { ChipRaceEngine } from './ChipRaceEngine.js';
import { TableBalancer } from './TableBalancer.js';
import { TableBreakEngine } from './TableBreakEngine.js';
import { OFCDealingOrchestrator } from './OFCDealingOrchestrator.js';
import { EngineTelemetry } from './EngineTelemetry.js';
import type { ValidationContext } from './ServerActionValidator.js';
import {
  broadcastHandState,
  loadTable,
  loadSeatedPlayers,
  syncStacks,
  syncTournamentChips,
  updateTableStatus,
  autoRebuyHorse,
  markSeatAsLeft,
  processLeavePending,
  logRakeCollection,
  logHandHistory,
  cleanupChannel,
  supabase,
} from '../services/supabase.js';
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

// ═══════════════════════════════════════════════════════════════════════════════
// SERVER TABLE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export class ServerTableEngine {
  private tableId: string;
  private running: boolean = false;
  private handCount: number = 0;
  private handController: HandController | null = null;
  private tableInfo: TableInfo | null = null;
  private seatedPlayers: SeatedPlayer[] = [];
  private dealerSeatIndex: number = 0;
  private consecutiveErrors: number = 0;

  // Bankroll Management: Track how many times a horse has re-bought at this table.
  // Max is 2 rebuys (meaning 3 total buy-ins). If they bust a 3rd time, they leave.
  private horseRebuys: Map<string, number> = new Map();

  // Per-hand tracking
  private currentHandWentToFlop: boolean = false;
  private currentHandPotSize: number = 0;
  private currentHandDealerSeat: number = 0;
  private currentHandWinnerIds: string[] = [];
  private currentHandRake: number = 0;
  private currentHandCommunityCards: string[] = [];
  private currentHandActions: { seat: number; action: string; amount?: number; stage: string }[] =
    [];
  private currentHandWinners: { userId: string; amount: number }[] = [];
  // Hand complete callback for tournament chip sync
  private handCompleteCallback:
    | ((tableId: string, players: { user_id: string; stack: number }[]) => void)
    | null = null;
  // Hand-for-hand pause: set by tournament manager, checked between hands
  private handForHandPaused: boolean = false;
  private handForHandResolve: (() => void) | null = null;

  // Real Player Turn Management
  private playerTurnTimer: NodeJS.Timeout | null = null;
  private playerTurnStartTime: number = 0;
  private playerTurnDuration: number = 0;
  private timeBankActivatedThisTurn: boolean = false;

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
      console.log(`[ServerTableEngine:${tableId}] Timer event: ${event.type} player=${event.playerId}`);
    });
    this.actionValidator = new ServerActionValidator((event) => {
      console.warn(`[ServerTableEngine:${tableId}] Action rejected: ${event.code} — ${event.reason}`);
    });
    this.stateVerifier = new StateVerifier((event) => {
      console.error(`[ServerTableEngine:${tableId}] STATE INTEGRITY VIOLATION: ${event.violationCount} issue(s) in hand #${event.handNumber}`);
    });

    // Step 5: Initialize supporting modules
    this.timeBankEngine = new TimeBankEngine(this.preciseTimer, (event) => {
      console.log(`[ServerTableEngine:${tableId}] TimeBank: ${event.type} player=${event.playerId}`);
    });
    this.disconnectEngine = new DisconnectEngine(this.preciseTimer, (event) => {
      console.log(`[ServerTableEngine:${tableId}] Disconnect: ${event.type} player=${event.playerId}`);
    });
    this.preActionEngine = new PreActionEngine((event) => {
      console.log(`[ServerTableEngine:${tableId}] PreAction: ${event.type} player=${event.playerId}`);
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
      console.log(`[ServerTableEngine:${tableId}] Telemetry: activeTables=${(event as any).activeTables}`);
    });

    console.log(`[ServerTableEngine] Created for table ${tableId}`);
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

      // Wait for minimum 2 players
      while (this.running) {
        this.seatedPlayers = await loadSeatedPlayers(this.tableId);
        if (this.seatedPlayers.length >= 2) break;
        console.log(
          `[ServerTableEngine:${this.tableId}] Waiting for players... (${this.seatedPlayers.length}/2)`
        );
        await this.sleep(5000);
      }

      // Start dealing loop
      this.dealingLoop();
    } catch (err) {
      console.error(`[ServerTableEngine:${this.tableId}] Failed to start:`, err);
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

    cleanupChannel(this.tableId);
    console.log(`[ServerTableEngine:${this.tableId}] Stopped. Dealt ${this.handCount} hands.`);
  }

  isRunning(): boolean {
    return this.running;
  }
  getHandCount(): number {
    return this.handCount;
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
    if (this.playerTurnTimer) {
      clearTimeout(this.playerTurnTimer);
      this.playerTurnTimer = null;
    }
    // Also cancel precise timer for the current player (if any)
    // Note: preciseTimer.clearTable is used in HAND_COMPLETE; individual cancel here
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

    // Step 4: Register with PreciseActionTimer for deadline tracking (used by ServerActionValidator)
    this.preciseTimer.startTimer(this.tableId, userId, safeDurationSeconds * 1000);

    this.playerTurnTimer = setTimeout(() => {
      this.playerTurnTimer = null;
      if (!this.running || !this.handController) return;

      const state = this.handController.getState();
      if (state.currentPlayerSeat === seat) {
        const player = state.players.find((p) => p.seat === seat);
        const amountToCall = player ? Math.max(0, state.currentBet - (player.bet ?? 0)) : 0;
        const canCheck = amountToCall === 0;

        if (canCheck) {
          // No bet outstanding → auto-check (standard poker behavior)
          console.warn(
            `[ServerTableEngine:${this.tableId}] Player ${userId} timed out. Auto-checking (no bet to call).`
          );
          try {
            this.handController.performAction(seat, 'check');
          } catch (err) {
            console.error(`[ServerTableEngine:${this.tableId}] Auto-check failed:`, err);
            // Fallback to fold if check somehow fails
            try {
              this.handController.performAction(seat, 'fold');
            } catch (foldErr) {
              console.error(`[ServerTableEngine:${this.tableId}] Auto-fold fallback also failed:`, foldErr);
            }
          }
        } else {
          // Bet outstanding → auto-fold
          console.warn(
            `[ServerTableEngine:${this.tableId}] Player ${userId} timed out. Auto-folding (${amountToCall} to call).`
          );
          try {
            this.handController.performAction(seat, 'fold');
          } catch (err) {
            console.error(`[ServerTableEngine:${this.tableId}] Auto-fold failed:`, err);
          }
        }
      }
    }, safeDurationSeconds * 1000);
  }

  /**
   * Activate Time Bank triggered by the client HTTP POST to `/timebank`
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

    const seatedPlayer = this.seatedPlayers.find((p) => p.user_id === userId);
    if (!seatedPlayer) return { success: false, error: 'Player not seated' };

    if (this.timeBankActivatedThisTurn) {
      return { success: false, error: 'Time bank already activated this turn' };
    }

    // Check if they have uses remaining
    if ((seatedPlayer.time_bank_uses_remaining || 0) <= 0) {
      return { success: false, error: 'No time bank uses remaining' };
    }

    // Deduct a use on the server state
    seatedPlayer.time_bank_uses_remaining = (seatedPlayer.time_bank_uses_remaining || 0) - 1;
    this.timeBankActivatedThisTurn = true;

    // Extend timer based on table's time bank setting
    const bankDuration = this.tableInfo.time_bank_seconds || 60;

    // Calculate how much normal time was already used
    const elapsed = (Date.now() - this.playerTurnStartTime) / 1000;
    const remainingBeforeBank = Math.max(0, this.playerTurnDuration - elapsed);

    // New duration is remaining normal time PLUS full time bank
    const newDuration = remainingBeforeBank + bankDuration;
    console.log(
      `[ServerTableEngine:${this.tableId}] Player ${userId} activated time bank. Adding ${bankDuration}s. Total new countdown: ${Math.round(newDuration)}s`
    );

    this.startTurnTimer(userId, player.seat, newDuration);

    // Broadcast a master UI event via standard table channel so OTHER players see the timer reload
    try {
      supabase
        .channel(`table:${this.tableId}`)
        .send({
          type: 'broadcast',
          event: 'time_bank_activated',
          payload: {
            player_id: userId,
            table_id: this.tableId,
            additional_seconds: bankDuration,
            uses_remaining: seatedPlayer.time_bank_uses_remaining ?? 0,
            total_remaining:
              (seatedPlayer.time_bank_uses_remaining ?? 0) > 0
                ? (seatedPlayer.time_bank_uses_remaining ?? 0) * bankDuration
                : 0,
          },
        })
        .catch(() => {});
    } catch (e) {}

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
  ): { success: boolean; error?: string } {
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

    // Clamp amounts
    if (normalizedAction === 'call') amount = toCall;
    if (normalizedAction === 'bet' && amount !== undefined) {
      amount = Math.max(state.minRaise, amount);
      if (amount >= player.stack) {
        normalizedAction = 'all_in';
        amount = undefined;
      }
    } else if (normalizedAction === 'raise' && amount !== undefined) {
      const minRaiseTo = state.currentBet + state.minRaise;
      amount = Math.max(minRaiseTo, amount);
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
      return { success: false, error: validation.reason || 'Action validation failed' };
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
      this.handController.performAction(seat, normalizedAction as any, amount);
      console.log(
        `[ServerTableEngine:${this.tableId}] Player ${userId} → ${normalizedAction}${amount ? ` ${amount}` : ''}`
      );
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
    const maxRaiseTo = player.stack + player.bet;

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
        // Reload players + refresh blinds before each hand
        this.seatedPlayers = await loadSeatedPlayers(this.tableId);
        await this.refreshBlinds();

        const activePlayers = this.seatedPlayers.filter((p) => p.stack > 0);

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
        console.error(
          `[ServerTableEngine:${this.tableId}] Error (attempt ${this.consecutiveErrors}):`,
          err
        );
        if (this.consecutiveErrors >= 10) {
          console.error(`[ServerTableEngine:${this.tableId}] Too many errors — stopping`);
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
    this.currentHandWentToFlop = false;
    this.currentHandPotSize = 0;
    this.currentHandWinnerIds = [];
    this.currentHandRake = 0;
    this.currentHandCommunityCards = [];
    this.currentHandActions = [];
    this.currentHandWinners = [];

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
    }));

    // Rotate dealer
    this.dealerSeatIndex = this.dealerSeatIndex % players.length;
    const dealerSeat = players[this.dealerSeatIndex].seat_number;
    this.currentHandDealerSeat = dealerSeat;
    this.dealerSeatIndex++;

    const config: HandConfig = {
      tableId: this.tableId,
      handNumber,
      gameVariant: this.tableInfo.game_variant as GameVariant,
      smallBlind: this.tableInfo.small_blind,
      bigBlind: this.tableInfo.big_blind,
      ante: this.tableInfo.ante,
      rakeConfig: this.getRakeConfig(this.tableInfo.small_blind, this.tableInfo.big_blind),
    };

    this.handController = new HandController(config, hcPlayers, dealerSeat);

    // Step 4: Record initial chip totals for state verification
    this.stateVerifier.recordInitialChipTotal(this.tableId, hcPlayers);

    // Step 5: Initialize atomic stacks, time banks, and disconnect tracking for each player
    for (const p of hcPlayers) {
      this.atomicStackService.initializeStack(this.tableId, p.user_id, p.stack);
      this.timeBankEngine.initializePlayer(this.tableId, p.user_id);
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
        console.error(`[ServerTableEngine:${this.tableId}] Disconnect auto-action failed:`, err);
      }
    });

    // Wait for hand to complete
    return new Promise<void>((resolve) => {
      const handTimeout = setTimeout(() => {
        console.warn(`[ServerTableEngine:${this.tableId}] Hand ${handNumber} timed out after 60s`);
        this.handController = null;
        resolve();
      }, 60_000);

      const unsub = this.handController!.onEvent((event: HandEvent) => {
        this.handleHandEvent(event, players);

        if (event.type === 'HAND_COMPLETE') {
          clearTimeout(handTimeout);
          unsub();

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
              console.error(`[ServerTableEngine:${this.tableId}] handCompleteCallback error:`, e);
            }
          }

          this.handController = null;
          resolve();
        }
      });

      // Start the hand!
      try {
        this.handController!.start();
      } catch (err) {
        console.error(`[ServerTableEngine:${this.tableId}] Failed to start hand:`, err);
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

  private handleHandEvent(event: HandEvent, players: SeatedPlayer[]): void {
    switch (event.type) {
      case 'HAND_START':
        this.broadcastCurrentState();
        break;

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

      case 'TURN_CHANGE':
        this.handleTurnChange(event, players);
        this.broadcastCurrentState();
        break;

      case 'PLAYER_ACTION':
        // Track action for hand history
        if (event.seat !== undefined && event.action) {
          const stage = this.handController?.getState()?.stage || 'preflop';
          this.currentHandActions.push({
            seat: event.seat,
            action: event.action,
            amount: event.amount,
            stage,
          });
        }
        this.broadcastCurrentState();
        break;

      case 'COMMUNITY_CARDS':
        if (event.stage === 'flop') this.currentHandWentToFlop = true;
        if (event.cards) {
          this.currentHandCommunityCards = event.cards.map((c: any) =>
            typeof c === 'string' ? c : `${c.rank}${c.suit}`
          );
        }
        this.broadcastCurrentState();
        break;

      case 'WINNERS':
        this.currentHandWinnerIds = (event.winners || []).map(
          (w: any) => w.userId || w.user_id || ''
        );
        this.currentHandWinners = (event.winners || []).map((w: any) => ({
          userId: w.userId || w.user_id || '',
          amount: w.amount || 0,
        }));
        if (this.handController) {
          const state = this.handController.getState();
          this.currentHandPotSize = state.pot;
          this.currentHandRake = (state as any).rake || 0;
          for (const enginePlayer of state.players) {
            const localPlayer = players.find((p) => p.user_id === enginePlayer.user_id);
            if (localPlayer) localPlayer.stack = enginePlayer.stack;
          }
        }
        this.broadcastCurrentState();
        break;

      case 'HAND_COMPLETE':
        // Capture rake from hand completion event
        if ((event as any).rake !== undefined) {
          this.currentHandRake = (event as any).rake;
        }

        // Step 4: State verification — deduct rake and verify chip conservation
        if (this.currentHandRake > 0) {
          this.stateVerifier.deductRake(this.tableId, this.currentHandRake);
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
            console.error(
              `[ServerTableEngine:${this.tableId}] Hand #${this.handCount} FAILED integrity check:`,
              verifyResult.violations.map((v) => v.message).join('; ')
            );
          }
        }

        // Step 4: Clean up validator state between hands
        this.actionValidator.clearTable(this.tableId);
        this.preciseTimer.clearTable(this.tableId);

        // Step 5: Clean up supporting modules between hands
        this.preActionEngine.dispose(this.tableId);
        this.timeBankEngine.dispose(this.tableId);
        // Note: disconnectEngine persists across hands (tracks connection state)
        // Note: atomicStackService persists across hands (tracks stack versions)

        // Step 6: Clean up advanced modules between hands
        this.runItTwiceEngine.dispose(this.tableId);
        this.insuranceEngine.dispose(this.tableId);
        // Note: straddleEngine persists (auto-straddle enrollment persists)
        // Note: mixedGameEngine persists (variant rotation is multi-hand)
        // Note: rakebackEngine persists (accumulates across hands)

        // Step 6: Mixed game rotation — notify after each hand
        if (this.mixedGameEngine.isActive(this.tableId)) {
          const activePlayers = this.handController
            ? this.handController.getState().players.filter((p) => !p.is_folded).length
            : 0;
          this.mixedGameEngine.onHandComplete(this.tableId, activePlayers);
        }

        // Step 7: Record telemetry for this hand
        this.engineTelemetry.recordPlayerCount(this.tableId, players.length);

        // Async post-hand tasks (fire and forget)
        this.postHandTasks(players).catch((err) =>
          console.error(`[ServerTableEngine:${this.tableId}] Post-hand error:`, err)
        );
        this.currentHandWinnerIds = [];
        break;
    }
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

    // Only horses get auto-played — real players get an authoritative timer and wait for WebSocket/HTTP actions
    if (!player.is_horse) {
      const actionTime = this.tableInfo?.action_time_seconds || 15;
      this.timeBankActivatedThisTurn = false; // Reset anti-spam lock for this NEW turn

      // Step 5: Check for queued pre-action before starting timer
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
          console.warn(`[ServerTableEngine:${this.tableId}] Pre-action failed, falling through to timer:`, err);
        }
      }

      // Step 5: Check disconnect state before starting timer
      const playerCanAct = this.disconnectEngine.onPlayerTurn(this.tableId, player.user_id, canCheckForPreAction);
      if (!playerCanAct) {
        // Player is disconnected or sitting out — DisconnectEngine will handle auto-action via callback
        return;
      }

      this.startTurnTimer(player.user_id, seat, actionTime);
      return;
    }

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

    // Get decision — SYNCHRONOUS, instant
    const decision = HorseLogic.decide(enginePlayer, gameState as any, horseStyle);

    // Apply think time delay (50-300ms server-side — fast!)
    const thinkTime = Math.min(decision.thinkTime, 200);
    const handControllerRef = this.handController;

    setTimeout(() => {
      if (!handControllerRef || !this.running) return;

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
        try {
          handControllerRef.performAction(seat, 'fold');
        } catch {
          /* Hand done */
        }
      }
    }, thinkTime);
  }

  /**
   * Broadcast current hand state to all table viewers
   */
  private broadcastCurrentState(): void {
    if (!this.handController || !this.tableInfo) return;

    const state = this.handController.getState();
    const currentSeatPlayer = state.players.find((p) => p.seat === state.currentPlayerSeat);

    broadcastHandState(this.tableId, {
      table_id: this.tableId,
      hand_number: this.handCount,
      pot: state.pot ?? 0,
      community_cards: state.communityCards ?? [],
      current_bet: state.currentBet ?? 0,
      current_player: currentSeatPlayer?.user_id ?? null,
      dealer_seat: state.dealerSeat ?? this.currentHandDealerSeat,
      stage: state.stage ?? 'preflop',
      turn_start_time_ms: this.playerTurnStartTime,
      turn_duration_ms: this.playerTurnDuration * 1000, // Convert seconds → milliseconds
      // CARD SECURITY: Scrub hole cards from public broadcast.
      // Players receive their own cards via RLS-protected table_hole_cards channel.
      // Only reveal all cards at showdown (when remaining players show hands).
      players: (state.players ?? []).map((p) => ({
        seat: p.seat,
        user_id: p.user_id,
        username: p.username,
        stack: p.stack,
        bet: p.bet ?? 0,
        // Only reveal cards at showdown for players still in the hand (not folded)
        cards: (state.stage === 'showdown' && !p.is_folded) ? (p.cards ?? []) : [],
        is_folded: p.is_folded ?? false,
        is_all_in: p.is_all_in ?? false,
        is_sitting_out: p.is_sitting_out ?? false,
      })),
    });
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

    // 2b. Step 6: Track rake contributions for rakeback
    if (!this.isTournamentTable() && this.currentHandRake > 0 && this.tableInfo?.club_id) {
      // Build contribution map from player totalInvested
      const contributions = new Map<string, number>();
      let totalContributions = 0;
      for (const p of players) {
        // Use the player's final state from this hand
        const invested = p.stack >= 0 ? 1 : 0; // Fallback: equal weight if no totalInvested
        contributions.set(p.user_id, invested);
        totalContributions += invested;
      }
      if (totalContributions > 0) {
        this.rakebackEngine.recordHandRake(
          this.tableInfo.club_id,
          this.currentHandRake,
          contributions,
          totalContributions
        );
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

  // ═════════════════════════════════════════════════════════════════════════════
  // RAKE CONFIG
  // ═════════════════════════════════════════════════════════════════════════════

  private getRakeConfig(sb: number, bb: number): RakeConfig {
    const CAPS: [number, number, number][] = [
      [0.1, 0.2, 3],
      [0.2, 0.4, 3],
      [0.25, 0.5, 3],
      [0.3, 0.6, 5],
      [0.5, 1.0, 5],
      [1.0, 2.0, 5],
      [2.0, 4.0, 7.5],
      [2.0, 5.0, 7.5],
      [5.0, 5.0, 7.5],
      [3.0, 6.0, 8],
      [4.0, 8.0, 10],
      [5.0, 10.0, 12.5],
      [10.0, 20.0, 15],
      [10.0, 25.0, 15],
    ];

    const exact = CAPS.find(([s, b]) => s === sb && b === bb);
    if (exact) return { percent: 10, cap: exact[2], noFlop: true };

    let closest = CAPS[0];
    let minDiff = Math.abs(bb - closest[1]);
    for (const tier of CAPS) {
      const diff = Math.abs(bb - tier[1]);
      if (diff < minDiff) {
        minDiff = diff;
        closest = tier;
      }
    }
    return { percent: 10, cap: closest[2], noFlop: true };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // UTILITY
  // ═════════════════════════════════════════════════════════════════════════════

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
