/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * HEADLESS TABLE ENGINE — Pure TypeScript Dealer for Simultaneous Multi-Table Dealing
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs the complete dealing pipeline for a single table WITHOUT React or UI:
 * - Loads table config, seated players, and horses
 * - Manages HandController lifecycle
 * - Wires persistence service for each hand
 * - Executes horse decisions with proper think-time delays
 * - Auto-rebuys busted horses
 * - Tracks hand count for monitoring
 *
 * NO global window locks — each engine instance manages its own table independently.
 * Multiple tables can deal simultaneously.
 */

import { supabase, broadcastHandState, cleanupBroadcastChannel } from '../lib/supabase';
import { HandController, type HandConfig, type HandEvent } from './HandController';
import { evaluateHand, evaluateOmahaHand, cardToString, determineWinners } from './PokerEngine';
import { straddleEngine } from './StraddleEngine';
import { runItTwiceEngine } from './RunItTwiceEngine';
import { insuranceEngine } from './InsuranceEngine';
import { timeBankEngine } from './TimeBankEngine';
import { disconnectEngine } from './DisconnectEngine';
import { engineTelemetry } from './EngineTelemetry';
import { HandPersistence } from '../services/HandPersistenceService';
import { HorseLogic, type HorseStyle, type HorseDecision } from './HorseLogic';
import { HorseBrainAdapter } from './HorseBrainAdapter';
import { GTOQueryService } from '../services/GTOQueryService';
import { HydraService } from '../services/HydraService';
import { RakeService, type DealtInPlayer } from '../services/RakeService';
import { BBJService, type GameVariant as BBJGameVariant } from '../services/BBJService';
import { workerTimeout, cancelWorkerTimeout } from '../hooks/useTabKeepAlive';
import type { SeatPlayer, GameVariant } from '../types/database.types';
import { WalletService } from '../services/WalletService';
import { masterBus } from '../core/MasterBus';
import { stateVerifier } from './StateVerifier';
import { useUserStore } from '../stores/useUserStore';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface TableInfo {
  id: string;
  club_id: string;
  small_blind: number;
  big_blind: number;
  game_variant: GameVariant;
  max_players: number;
  ante?: number;
  game_type?: string; // 'cash' | 'tournament'
  tournament_id?: string; // Set if this table belongs to a tournament
  action_time_seconds?: number;
  time_bank_seconds?: number;
}

interface SeatedPlayer {
  user_id: string;
  username: string;
  stack: number;
  seat_number: number;
  is_horse: boolean;
  horse_profile?: string;
  agent_id?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HEADLESS TABLE ENGINE
// ═══════════════════════════════════════════════════════════════════════════════

export class HeadlessTableEngine {
  private tableId: string;
  private supabaseClient: typeof supabase;
  private running: boolean = false;
  private handCount: number = 0;
  private handController: HandController | null = null;
  private dealingLoopTimer: number | null = null;
  private tableInfo: TableInfo | null = null;
  private seatedPlayers: SeatedPlayer[] = [];
  private horseAIHandlers: Map<string, () => void> = new Map();
  private unsubscribeHands: (() => void)[] = [];
  private pendingTimerIds: number[] = []; // Track workerTimeout IDs for cleanup
  private handInvalidated = false; // Flag to prevent timers from executing after hand timeout
  private persistence: HandPersistence;
  private dealerSeatIndex: number = 0; // Tracks dealer position (rotates each hand)
  private consecutiveErrors: number = 0; // For exponential backoff on dealing errors
  // Per-hand rake tracking
  private currentHandWentToFlop: boolean = false;
  private currentHandPotSize: number = 0;
  private currentHandRake: number = 0; // Authoritative rake from HandController
  private currentHandPlayers: SeatedPlayer[] = [];
  // Current hand's dealer seat number (frozen at deal time, not advanced mid-hand)
  private currentHandDealerSeat: number = 0;
  // Winner IDs captured from WINNERS event for Horse Brain processing
  private currentHandWinnerIds: string[] = [];
  // Initial stacks captured BEFORE hand starts — used for accurate chip delta calculation
  private currentHandInitialStacks: Map<string, number> = new Map();
  // Showdown results captured for BBJ trigger checking

  private currentHandShowdownResults: any[] = [];
  // Stack sync promise — awaited before loading seats for next hand
  private stackSyncPromise: Promise<void> | null = null;
  // Callback fired after each hand completes — used by TournamentEngine for real-time chip sync
  private handCompleteCallback:
    | ((tableId: string, players: { user_id: string; stack: number }[]) => void)
    | null = null;
  // Hand-for-hand mode (bubble) — when active, pause after each hand until released
  private handForHandMode = false;
  private handForHandResolve: (() => void) | null = null;
  private timeBankUnsubs: (() => void)[] = [];
  // Cached unionId for this table's club (resolved once, stored per engine instance)
  private _cachedUnionId: string | undefined;

  constructor(tableId: string, supabaseClient: typeof supabase) {
    this.tableId = tableId;
    this.supabaseClient = supabaseClient;
    this.persistence = new HandPersistence(tableId);

    // Persist Time Bank state changes to Supabase
    const handleTimeBankChange = async (event: any) => {
      const payload = event?.payload || event;
      if (payload.tableId !== this.tableId) return;
      try {
        await this.supabaseClient
          .from('table_seats')
          .update({
            time_bank_remaining: payload.remainingSeconds,
            time_bank_uses_remaining: payload.usesRemaining,
          })
          .eq('table_id', this.tableId)
          .eq('user_id', payload.playerId);
      } catch (err) {
        console.debug(`[HeadlessTableEngine:${this.tableId}] DB sync failed for Time Bank:`, err);
      }
    };

    this.timeBankUnsubs.push(
      masterBus.subscribe('TIME_BANK_STOPPED', handleTimeBankChange),
      masterBus.subscribe('TIME_BANK_DEPLETED', handleTimeBankChange),
      masterBus.subscribe('TIME_BANK_EXPIRED', handleTimeBankChange),
      masterBus.subscribe('TIME_BANK_EXTENDED', handleTimeBankChange),
      masterBus.subscribe('TIME_BANK_REFILLED', handleTimeBankChange)
    );
  }

  /**
   * Start the dealing pipeline: load config, wait for players, begin dealing loop
   */
  async start(): Promise<void> {
    if (this.running) {
      console.debug(`[HeadlessTableEngine:${this.tableId}] Already running`);
      return;
    }

    this.running = true;
    try {
      // Initialize Horse Brain (loads HorsePokerBrain.js if available, else uses HorseLogic)
      await HorseBrainAdapter.initialize();

      // Load table configuration from database
      await this.loadTableInfo();
      if (!this.tableInfo) {
        throw new Error('Failed to load table info');
      }

      // Wait for minimum players (2+), checking every 10 seconds
      while (this.running) {
        await this.loadSeatedPlayers();
        if (this.seatedPlayers.length >= 2) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      // Clean up any orphaned hands from previous sessions before dealing
      this.persistence
        .cleanupOrphanedHands()
        .catch((e) => console.warn('[HeadlessTableEngine] Failed to cleanup orphaned hands:', e));

      // Start dealing loop
      this.startDealingLoop();
    } catch (err: unknown) {
      console.debug(`[HeadlessTableEngine:${this.tableId}] Failed to start:`, err);
      this.running = false;
    }
  }

  /**
   * Stop the engine and clean up
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    // Cancel dealing loop
    if (this.dealingLoopTimer !== null) {
      clearTimeout(this.dealingLoopTimer as any);
      this.dealingLoopTimer = null;
    }

    // Await any in-flight stack sync before cleanup (prevents stale DB writes)
    if (this.stackSyncPromise) {
      try {
        await this.stackSyncPromise;
      } catch {
        // Sync may fail — we still need to clean up
      }
      this.stackSyncPromise = null;
    }

    // Clean up hand controller
    if (this.handController) {
      this.handController = null;
    }

    // Clean up pending horse timers (prevents memory leak)
    for (const timerId of this.pendingTimerIds) {
      cancelWorkerTimeout(timerId);
    }
    this.pendingTimerIds = [];

    // Clean up event handlers
    this.unsubscribeHands.forEach((unsub) => unsub());
    this.unsubscribeHands = [];
    this.timeBankUnsubs.forEach((unsub) => unsub());
    this.timeBankUnsubs = [];
    this.horseAIHandlers.clear();

    // Clear brain session data for this table
    HorseBrainAdapter.clearTableSessions(this.tableId);
    // Clean up per-table persistence

    // Clean up broadcast channel to prevent resource leak
    cleanupBroadcastChannel(this.tableId);
    this.persistence.dispose();

    // Clean up straddle and RIT engine state for this table (prevents stale enrollments/offers)
    straddleEngine.dispose(this.tableId);
    runItTwiceEngine.dispose(this.tableId);
    insuranceEngine.dispose(this.tableId);
    timeBankEngine.dispose(this.tableId);
    disconnectEngine.dispose(this.tableId);
    engineTelemetry.removeTable(this.tableId);
  }

  /**
   * Check if engine is currently running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get total hands dealt by this engine
   */
  getHandCount(): number {
    return this.handCount;
  }

  /**
   * Get the last hand's winner IDs (used for bounty knockout tracking)
   */
  getLastHandWinnerIds(): string[] {
    return this.currentHandWinnerIds;
  }

  /**
   * Register a callback that fires after each hand completes with final player stacks.
   * Used by TournamentEngine for real-time chip sync to tournament_players.
   */
  onHandComplete(
    callback: (tableId: string, players: { user_id: string; stack: number }[]) => void
  ): void {
    this.handCompleteCallback = callback;
  }

  /**
   * Enable/disable hand-for-hand mode (money bubble).
   * When active, the dealing loop pauses after each hand completes until
   * `releaseHandForHand()` is called (or mode is disabled).
   */
  setHandForHand(active: boolean): void {
    this.handForHandMode = active;
    if (!active && this.handForHandResolve) {
      // Release any waiting hand
      this.handForHandResolve();
      this.handForHandResolve = null;
    }
  }

  /**
   * Release a paused hand-for-hand wait, allowing the next hand to deal.
   */
  releaseHandForHand(): void {
    if (this.handForHandResolve) {
      this.handForHandResolve();
      this.handForHandResolve = null;
    }
  }

  /**
   * Dynamically update blind levels (used by SpinIt/Tournament blind escalation).
   * Takes effect on the next hand dealt.
   */
  updateBlinds(smallBlind: number, bigBlind: number, ante?: number): void {
    if (this.tableInfo) {
      this.tableInfo.small_blind = smallBlind;
      this.tableInfo.big_blind = bigBlind;
      if (ante !== undefined) this.tableInfo.ante = ante;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: SETUP
  // ═════════════════════════════════════════════════════════════════════════════

  private async loadTableInfo(): Promise<void> {
    const { data, error } = await this.supabaseClient
      .from('tables')
      .select(
        'id, club_id, small_blind, big_blind, game_variant, max_players, ante, game_type, tournament_id, action_time_seconds, time_bank_seconds'
      )
      .eq('id', this.tableId)
      .maybeSingle();

    if (error || !data) {
      throw new Error(`Failed to load table info: ${error?.message}`);
    }

    this.tableInfo = data as TableInfo;
    const mode = data.tournament_id ? 'TOURNAMENT' : 'CASH';
  }

  /**
   * Returns true if this table belongs to a tournament (no auto-rebuy, no rake)
   */
  private isTournamentTable(): boolean {
    return !!(this.tableInfo?.tournament_id || this.tableInfo?.game_type === 'tournament');
  }

  /**
   * Refresh blinds from DB (for tournament blind level changes)
   */
  private async refreshBlinds(): Promise<void> {
    if (!this.tableInfo || !this.isTournamentTable()) return;

    const { data } = await this.supabaseClient
      .from('tables')
      .select('small_blind, big_blind, ante')
      .eq('id', this.tableId)
      .maybeSingle();

    if (data) {
      this.tableInfo.small_blind = data.small_blind;
      this.tableInfo.big_blind = data.big_blind;
      this.tableInfo.ante = data.ante;
    }
  }

  private async loadSeatedPlayers(): Promise<void> {
    const { data, error } = await this.supabaseClient
      .from('table_seats')
      .select('user_id, stack, seat_number, time_bank_remaining, time_bank_uses_remaining')
      .eq('table_id', this.tableId)
      .is('left_at', null)
      .order('seat_number', { ascending: true });

    if (error) {
      console.debug(`[HeadlessTableEngine:${this.tableId}] Failed to load seats:`, error);
      this.seatedPlayers = [];
      return;
    }

    if (!data || data.length === 0) {
      this.seatedPlayers = [];
      return;
    }

    const userIds = data.map((d) => d.user_id);
    const { data: profiles, error: profileError } = await this.supabaseClient
      .from('profiles')
      .select('id, display_name, username, is_horse, horse_profile')
      .in('id', userIds);

    if (profileError) {
      console.debug(`[HeadlessTableEngine:${this.tableId}] Failed to load profiles:`, profileError);
      this.seatedPlayers = [];
      return;
    }

    const profileMap = new Map(profiles?.map((p) => [p.id, p]) || []);

    // Fetch agent_id from club_members for commission tracking
    const agentMap = new Map<string, string>();
    if (this.tableInfo?.club_id) {
      const { data: members } = await this.supabaseClient
        .from('club_members')
        .select('user_id, agent_id')
        .eq('club_id', this.tableInfo.club_id)
        .in('user_id', userIds)
        .not('agent_id', 'is', null);

      if (members) {
        for (const m of members) {
          if (m.agent_id) agentMap.set(m.user_id, m.agent_id);
        }
      }
    }

    // Identify busted seats (stack <= 0) — only for cash game tables
    // (Tournament table stack=0 is handled by elimination logic in TournamentEngine)
    if (!this.isTournamentTable()) {
      const bustedSeats = data.filter((seat) => seat.stack <= 0);
      if (bustedSeats.length > 0) {
        for (const seat of bustedSeats) {
          // Check if this is a horse — if so, use HydraService.removeHorse
          // which properly resets horse_status to "available" and cleans up the seat
          const profile = profileMap.get(seat.user_id);
          if (profile?.is_horse) {
            await HydraService.removeHorse(this.tableId, seat.user_id);
            console.debug(
              `[HeadlessTableEngine:${this.tableId}] Removed busted horse ${seat.user_id} via HydraService`
            );
          } else {
            // Non-horse player: soft-delete as before
            await this.supabaseClient
              .from('table_seats')
              .update({ left_at: new Date().toISOString() })
              .eq('table_id', this.tableId)
              .eq('user_id', seat.user_id)
              .is('left_at', null);
            console.debug(
              `[HeadlessTableEngine:${this.tableId}] Cleared busted seat for player ${seat.user_id}`
            );
          }
        }
      }
    }

    this.seatedPlayers = data
      .filter((seat) => seat.stack > 0 && profileMap.has(seat.user_id))
      .map((seat) => {
        const profile = profileMap.get(seat.user_id)!;
        return {
          user_id: seat.user_id,
          username: profile.display_name || profile.username || 'Player',
          stack: seat.stack,
          seat_number: seat.seat_number || 1, // Use actual DB seat number
          is_horse: profile.is_horse || false,
          horse_profile: profile.horse_profile || 'balanced',
          agent_id: agentMap.get(seat.user_id), // Agent for commission tracking
          time_bank_remaining: seat.time_bank_remaining,
          time_bank_uses_remaining: seat.time_bank_uses_remaining,
        };
      });

    // Sync current_players count to tables row so lobby displays correctly
    await this.supabaseClient
      .from('tables')
      .update({ current_players: this.seatedPlayers.length, status: 'RUNNING' })
      .eq('id', this.tableId);
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: DEALING LOOP
  // ═════════════════════════════════════════════════════════════════════════════

  private startDealingLoop(): void {
    const dealNextHand = async () => {
      if (!this.running) return;

      try {
        // Wait for previous hand's stack sync to complete before loading new data
        if (this.stackSyncPromise) {
          await this.stackSyncPromise;
          this.stackSyncPromise = null;
        }

        // Reload seated players + refresh blinds before each hand
        await this.loadSeatedPlayers();
        await this.refreshBlinds();

        const activePlayers = this.seatedPlayers.filter((p) => p.stack > 0);
        if (activePlayers.length < 2) {
          this.dealingLoopTimer = setTimeout(dealNextHand, 5000) as any;
          return;
        }

        // Deal hand
        await this.dealHand(activePlayers);
        this.consecutiveErrors = 0; // Reset on success

        // Hand-for-hand mode: pause after hand until released by TournamentEngine
        if (this.handForHandMode && this.running) {
          await new Promise<void>((resolve) => {
            this.handForHandResolve = resolve;
            // Safety timeout: auto-release after 60s to prevent deadlock
            setTimeout(() => {
              if (this.handForHandResolve === resolve) {
                this.handForHandResolve = null;
                resolve();
              }
            }, 60_000);
          });
        }

        // Wait 3-5 seconds before next hand (jitter prevents Supabase request spikes)
        if (this.running) {
          const jitter = 3000 + Math.floor(Math.random() * 2000);
          this.dealingLoopTimer = setTimeout(dealNextHand, jitter) as any;
        }
      } catch (err: unknown) {
        this.consecutiveErrors++;
        const backoffMs = Math.min(5000 * Math.pow(2, this.consecutiveErrors - 1), 60000);
        console.debug(
          `[HeadlessTableEngine:${this.tableId}] Dealing loop error (attempt ${this.consecutiveErrors}, retry in ${backoffMs}ms):`,
          err
        );
        if (this.running && this.consecutiveErrors < 10) {
          this.dealingLoopTimer = setTimeout(dealNextHand, backoffMs) as any;
        } else if (this.consecutiveErrors >= 10) {
          console.debug(
            `[HeadlessTableEngine:${this.tableId}] Too many consecutive errors (${this.consecutiveErrors}) — stopping engine`
          );
          this.running = false;
        }
      }
    };

    dealNextHand();
  }

  private async dealHand(players: SeatedPlayer[]): Promise<void> {
    if (!this.tableInfo) return;

    this.handCount++;
    const handNumber = this.handCount;
    const handStartTime = Date.now();
    (this as any)._handStartTime = handStartTime;
    engineTelemetry.recordPlayerCount(this.tableId, players.length);

    // Reset per-hand rake tracking
    this.currentHandWentToFlop = false;
    this.currentHandPotSize = 0;
    this.currentHandRake = 0;
    this.currentHandPlayers = players;

    // Capture initial stacks BEFORE hand begins — critical for accurate chip delta
    this.currentHandInitialStacks = new Map(players.map((p) => [p.user_id, p.stack]));
    // Convert to SeatPlayer format — use actual seat numbers from DB
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

    // Rotate dealer button properly: cycle through actual seat numbers
    this.dealerSeatIndex = this.dealerSeatIndex % players.length;
    const dealerSeat = players[this.dealerSeatIndex].seat_number;
    this.currentHandDealerSeat = dealerSeat; // Freeze for broadcast during this hand
    this.dealerSeatIndex++; // Advance for next hand

    // Orbit detection: when dealer wraps around, refill time bank uses
    if (this.dealerSeatIndex % players.length === 0) {
      timeBankEngine.onOrbitComplete(this.tableId);
    }

    // --- STRADDLE INJECTION ---
    const sortedPlayers = [...players]
      .sort((a, b) => a.seat_number - b.seat_number)
      .filter((p) => p.stack > 0);
    const firstActIdx = sortedPlayers.findIndex((p) => p.seat_number > dealerSeat);
    const orderedPlayers =
      firstActIdx !== -1
        ? [...sortedPlayers.slice(firstActIdx), ...sortedPlayers.slice(0, firstActIdx)]
        : sortedPlayers;

    const seatOrder = orderedPlayers.map((p) => ({ seat: p.seat_number, playerId: p.user_id }));
    const playerStacks = new Map(players.map((p) => [p.user_id, p.stack]));
    // utgIdx is after SB and BB. `orderedPlayers` returns SB, BB, UTG...
    const utgIdx = players.length > 2 ? 2 : 0;
    const straddleOrder = seatOrder.slice(utgIdx).concat(seatOrder.slice(0, utgIdx));

    // Cash games only
    let straddles: { seat: number; amount: number }[] | undefined = undefined;
    if (!this.isTournamentTable()) {
      const straddleResult = straddleEngine.processStraddles(
        this.tableId,
        this.tableInfo.big_blind,
        straddleOrder,
        playerStacks
      );
      if (straddleResult.posted) {
        straddles = straddleResult.straddles.map((s) => ({
          seat: s.seatNumber,
          amount: s.amount,
        }));
      }
    }

    // Create HandController
    const config: HandConfig = {
      tableId: this.tableId,
      handNumber,
      gameVariant: this.tableInfo.game_variant as GameVariant,
      smallBlind: this.tableInfo.small_blind,
      bigBlind: this.tableInfo.big_blind,
      ante: this.tableInfo.ante,
      rakeConfig: this.getRakeConfig(this.tableInfo.small_blind, this.tableInfo.big_blind),
      straddles,
      ritEnabled: !this.isTournamentTable(), // Auto-enable RIT for cash games
    };

    this.handController = new HandController(config, hcPlayers, dealerSeat);

    // Configure time bank engine for this table using DB config (with sensible defaults)
    const tbSeconds = this.tableInfo.time_bank_seconds || (this.isTournamentTable() ? 15 : 30);
    const perUseSeconds = this.tableInfo.action_time_seconds || 15;
    timeBankEngine.configure(this.tableId, {
      totalBankSeconds: tbSeconds,
      maxUses: this.isTournamentTable() ? 2 : Math.max(1, Math.ceil(tbSeconds / perUseSeconds)),
      secondsPerUse: perUseSeconds,
      refillPerOrbit: !this.isTournamentTable(),
      refillSeconds: perUseSeconds,
      autoActivate: true,
    });

    // Initialize time bank for each player
    for (const p of players) {
      timeBankEngine.initializePlayer(this.tableId, p.user_id, {
        remainingSeconds: (p as any).time_bank_remaining ?? undefined,
        usesRemaining: (p as any).time_bank_uses_remaining ?? undefined,
      });
    }

    // Configure insurance engine (cash games only)
    if (!this.isTournamentTable()) {
      insuranceEngine.configure(this.tableId, {
        enabled: true,
        houseMargin: 1.05,
        maxInsurablePercent: 100,
        offerTimeoutSeconds: 15,
        minPotForInsurance: this.tableInfo.big_blind * 10,
        equityIterations: 5000,
      });
    }

    // Wire per-table persistence service (NOT the singleton — each table gets its own)
    this.persistence.wireToHandController(this.handController, {
      tableId: this.tableId,
      clubId: this.tableInfo.club_id,
      stakes: `${this.tableInfo.small_blind}/${this.tableInfo.big_blind}`,
      gameVariant: this.tableInfo.game_variant as 'nlh' | 'plo4' | 'plo5' | 'plo6',
      smallBlind: this.tableInfo.small_blind,
      bigBlind: this.tableInfo.big_blind,
      ante: this.tableInfo.ante || 0,
      dealerSeat: dealerSeat,
    });

    // Wait for hand to complete before returning
    let persistenceUnsub: (() => void) | null = null;
    this.handInvalidated = false; // Mark hand as valid at start

    // Record initial chip total for state verification (chip conservation check)
    stateVerifier.recordInitialChipTotal(
      this.tableId,
      players.map((p) => ({
        user_id: p.user_id,
        username: p.username,
        stack: p.stack,
        seat: p.seat_number,
        bet: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        totalInvested: 0,
      })) as any
    );
    return new Promise<void>((resolve) => {
      const handCompleteTimeout = setTimeout(() => {
        console.debug(
          `[HeadlessTableEngine:${this.tableId}] Hand ${handNumber} timed out after 120s`
        );
        this.handInvalidated = true; // Mark hand as invalidated
        // Clean up pending horse timers on timeout
        for (const timerId of this.pendingTimerIds) {
          cancelWorkerTimeout(timerId);
        }
        this.pendingTimerIds = [];
        this.handController = null;
        // Clean up event listener on timeout (prevent memory leak)
        if (persistenceUnsub) persistenceUnsub();
        resolve();
      }, 120_000); // 2 minute safety timeout

      // Wire event handler
      persistenceUnsub = this.handController!.onEvent((event: HandEvent) => {
        this.handleHandEvent(event, players);

        // Resolve the promise when hand completes
        if (event.type === 'HAND_COMPLETE') {
          clearTimeout(handCompleteTimeout);
          this.handInvalidated = true; // Mark hand complete, invalidate pending timers
          this.handController = null;
          // Clean up pending horse timers for this hand
          for (const timerId of this.pendingTimerIds) {
            cancelWorkerTimeout(timerId);
          }
          this.pendingTimerIds = [];
          // Clean up unsubscribe from this hand (prevent unbounded growth)
          if (persistenceUnsub) persistenceUnsub();

          // Fire hand-complete callback with final player stacks (tournament chip sync)
          if (this.handCompleteCallback) {
            const finalStacks = players.map((p) => ({
              user_id: p.user_id,
              stack: p.stack,
            }));
            try {
              this.handCompleteCallback(this.tableId, finalStacks);
            } catch (e: unknown) {
              console.debug(`[HeadlessTableEngine:${this.tableId}] handCompleteCallback error:`, e);
            }
          }

          // State verification between hands (StateVerifier emits bus events internally)
          try {
            // Deduct rake from the expected chip total before verifying
            // Without this, every raked hand would false-positive as a chip conservation violation
            // because post-hand stacks = pre-hand stacks - rake
            const handRake = (event as any).rake ?? 0;
            if (handRake > 0) {
              stateVerifier.deductRake(this.tableId, handRake);
            }

            const verifyResult = stateVerifier.verify({
              tableId: this.tableId,
              handNumber: this.handCount,
              players: players as any,
              communityCards: [],
              pot: 0,
              stage: 'showdown',
            });
            if (!verifyResult.valid && verifyResult.violations.length > 0) {
              console.debug(
                `[HeadlessTableEngine:${this.tableId}] STATE INTEGRITY VIOLATION hand #${this.handCount}:`,
                verifyResult.violations
              );
              // Note: StateVerifier.verify() already emits STATE_INTEGRITY_VIOLATION to masterBus
            }
          } catch (verifyErr: unknown) {
            console.debug(`[HeadlessTableEngine:${this.tableId}] StateVerifier error:`, verifyErr);
          }

          resolve();
        }
      });

      // Don't accumulate — old hands' unsubs are cleaned in HAND_COMPLETE above
      this.unsubscribeHands.push(persistenceUnsub);

      // Start hand
      try {
        this.handController!.start();

        // 🛡️ SECURE HOLE CARD PROVISIONING (ANTI-GOD-MODE) 🛡️
        // Prevent God Mode WebSocket leak by pushing private hole cards to an
        // RLS-protected table instead of the public `hand_state` broadcast channel.
        const state = this.handController!.getState();
        const humans = state.players.filter(
          (p) => !p.is_sitting_out && !players.find((sp) => sp.user_id === p.user_id)?.is_horse
        );

        if (humans.length > 0) {
          const cardInserts = humans.map((p) => ({
            table_id: this.tableId,
            hand_number: handNumber,
            user_id: p.user_id,
            seat_number: p.seat,
            cards: JSON.parse(JSON.stringify(p.cards || [])), // Ensure clean JSON
          }));

          // Secure hole card insertion via SECURITY DEFINER RPC — MUST succeed or hero has no cards.
          // Direct INSERT is blocked by RLS WITH CHECK(false) since the engine runs client-side
          // with the anon key. The RPC bypasses RLS as it runs as the DB owner.
          (async () => {
            const { error } = await this.supabaseClient.rpc('insert_hole_cards', {
              p_table_id: this.tableId,
              p_hand_number: handNumber,
              p_cards: cardInserts.map((c) => ({
                user_id: c.user_id,
                seat_number: c.seat_number,
                cards: c.cards,
              })),
            });
            if (error) {
              console.debug(
                `[HeadlessTableEngine:${this.tableId}] Secure hole card RPC failed, retrying:`,
                error.message
              );
              // Retry once after brief delay
              await new Promise((r) => setTimeout(r, 300));
              const { error: retryError } = await this.supabaseClient.rpc('insert_hole_cards', {
                p_table_id: this.tableId,
                p_hand_number: handNumber,
                p_cards: cardInserts.map((c) => ({
                  user_id: c.user_id,
                  seat_number: c.seat_number,
                  cards: c.cards,
                })),
              });
              if (retryError) {
                console.debug(
                  `[HeadlessTableEngine:${this.tableId}] Secure hole card retry ALSO failed:`,
                  retryError.message
                );
                // Emit critical alert — hole cards not persisted means players won't see their cards
                masterBus.emit('FINANCIAL_ALERT', {
                  severity: 'critical',
                  source: 'HeadlessTableEngine',
                  message: `Hole card RPC failed after retry: ${retryError.message}`,
                  context: { tableId: this.tableId, handNumber } as Record<string, unknown>,
                  timestamp: new Date().toISOString(),
                });
              }
            }
          })();
        }
      } catch (err: unknown) {
        console.debug(`[HeadlessTableEngine:${this.tableId}] Failed to start hand:`, err);
        clearTimeout(handCompleteTimeout);
        this.handController = null;
        resolve();
      }
    });
  }

  /**
   * Broadcast the current hand state to all TablePage subscribers via Realtime.
   * Called after every hand event so the UI stays in sync.
   */
  private broadcastCurrentState(): void {
    if (!this.handController || !this.tableInfo) return;

    const state = this.handController.getState();

    // Resolve current player seat number to user_id
    const currentSeatPlayer = state.players.find(
      (p: { seat: number }) => p.seat === state.currentPlayerSeat
    );

    broadcastHandState(this.tableId, {
      table_id: this.tableId,
      hand_number: this.handCount,
      pot: state.pot ?? 0,
      community_cards: state.communityCards ?? [],
      current_bet: state.currentBet ?? 0,
      current_player: currentSeatPlayer?.user_id ?? null,
      dealer_seat: state.dealerSeat ?? this.currentHandDealerSeat,
      stage: state.stage ?? 'preflop',
      players: (state.players ?? []).map((p) => ({
        seat: p.seat,
        user_id: p.user_id,
        username: p.username,
        stack: p.stack,
        bet: p.bet ?? 0,
        // 🔒 SECURE HOLE CARD SCRUBBER 🔒
        // Never transmit private cards during active betting rounds.
        // At showdown, only reveal non-folded players' cards.
        cards: state.stage === 'showdown' && !p.is_folded ? (p.cards ?? null) : null,
        is_folded: p.is_folded ?? false,
        is_all_in: p.is_all_in ?? false,
        is_sitting_out: p.is_sitting_out ?? false,
      })),
    });
  }

  private handleHandEvent(event: HandEvent, players: SeatedPlayer[]): void {
    switch (event.type) {
      case 'HAND_START':
        // Broadcast initial hand state
        this.broadcastCurrentState();
        break;

      case 'TURN_CHANGE':
        // Horse AI: when it's a player's turn, make their decision
        this.handleTurnChange(event, players);
        // Broadcast updated state (shows whose turn it is)
        this.broadcastCurrentState();
        break;

      case 'PLAYER_ACTION': {
        // Notify time bank engine that player acted (cancels active time bank)
        // PLAYER_ACTION event has `seat`, not `playerId` — resolve via players array
        const actingPlayer = players.find((p) => p.seat_number === event.seat);
        if (actingPlayer) {
          timeBankEngine.playerActed(this.tableId, actingPlayer.user_id);
        }
        // Broadcast after each player action so UI updates bets/stacks
        this.broadcastCurrentState();
        break;
      }

      case 'ALL_IN_RUNOUT_PENDING': {
        // Broadcast the pending state so UI can show the offer
        this.broadcastCurrentState();

        const activeIds = event.activePlayers.map((p: { user_id: string }) => p.user_id);
        const offeredBy = activeIds[0];
        const offeredTo = activeIds[1];
        const handId = `${this.tableId}-${this.handCount}`;

        // Insurance offering + RIT flow (both async, combined in single IIFE)
        (async () => {
          // Insurance offering (cash games only, before RIT flow)
          if (insuranceEngine.isEnabled(this.tableId) && activeIds.length >= 2) {
            const allInPlayers = event.activePlayers.map((p: SeatPlayer) => ({
              playerId: p.user_id,
              holeCards: p.cards || [],
            }));
            const board = this.handController?.getState()?.communityCards || [];
            insuranceEngine.createOffers(this.tableId, handId, allInPlayers, board, event.pot);

            // Wait for insurance responses (max 15s, then auto-decline remaining)
            await new Promise<void>((resolve) => {
              const checkInterval = setInterval(() => {
                if (insuranceEngine.allResponded(this.tableId)) {
                  clearInterval(checkInterval);
                  resolve();
                }
              }, 500);
              setTimeout(() => {
                clearInterval(checkInterval);
                resolve();
              }, 16000);
            });
          }

          // Guard: only enter the RIT flow if the engine is configured for this table
          if (!runItTwiceEngine.isEnabled(this.tableId) || activeIds.length < 2) {
            if (this.handController) this.handController.resumeRunout();
            return;
          }

          // RIT flow
          return new Promise<void>((resolve) => {
            let handled = false;
            let unsubAccept: (() => void) | null = null;
            let unsubDecline: (() => void) | null = null;

            const onAccept = (eventData: any) => {
              const data = eventData.payload;
              if (data && data.handId === handId) {
                cleanup();
                handleAccept();
              }
            };

            const onDecline = (eventData: any) => {
              const data = eventData.payload;
              if (data && data.handId === handId) {
                cleanup();
                handleDecline();
              }
            };

            const cleanup = () => {
              if (handled) return;
              handled = true;
              if (unsubAccept) unsubAccept();
              if (unsubDecline) unsubDecline();
              resolve();
            };

            unsubAccept = masterBus.subscribe('RIT_ACCEPTED', onAccept);
            unsubDecline = masterBus.subscribe('RIT_DECLINED', onDecline);

            // Offer RIT — timeout is handled internally by RunItTwiceEngine emitting RIT_DECLINED
            runItTwiceEngine.offer(this.tableId, handId, offeredBy, offeredTo, event.pot);

            // Safety timeout fallback if engine fails to fire decline
            // cleanup() MUST be called to prevent leaked event listeners
            setTimeout(() => {
              if (!handled) {
                console.warn(
                  '[HeadlessTableEngine] RIT safety timeout — cleaning up stale listeners'
                );
                cleanup();
                handleDecline();
              }
            }, 12000);

            const handleDecline = () => {
              if (this.handInvalidated || !this.handController) return;
              this.handController.resumeRunout();
            };

            const handleAccept = () => {
              if (this.handInvalidated || !this.handController) return;

              const duelResult = runItTwiceEngine.dealDualBoards(
                this.tableId,
                event.remainingDeck.map(cardToString),
                event.existingBoard.map(cardToString)
              );

              if (!duelResult) {
                this.handController.resumeRunout();
                return;
              }

              // Convert deck arrays for deals (for internal evaluation)
              const cardsNeeded = 5 - event.existingBoard.length;
              const run1Cards = event.remainingDeck.slice(0, cardsNeeded);
              const run2Cards = event.remainingDeck.slice(cardsNeeded, cardsNeeded * 2);
              const board1 = [...event.existingBoard, ...run1Cards];
              const board2 = [...event.existingBoard, ...run2Cards];

              // Evaluate winners
              const pots = [{ amount: event.pot / 2, eligiblePlayers: activeIds }];
              const variant = this.tableInfo?.game_variant || 'nlh';

              const w1 = determineWinners(event.activePlayers, board1, pots, variant);
              const w2 = determineWinners(event.activePlayers, board2, pots, variant);

              // Guard: if either board has no winners, fall back to normal runout
              if (w1.length === 0 || w2.length === 0) {
                console.debug(
                  `[HeadlessTableEngine:${this.tableId}] RIT board evaluation produced no winners — falling back`
                );
                this.handController.resumeRunout();
                return;
              }

              // Give RunItTwiceEngine the primary winner strings for bus emission
              runItTwiceEngine.resolve(this.tableId, w1[0].userId, w2[0].userId);

              // Combine distributions for HandController overriding
              const distMap = new Map<string, number>();
              for (const w of [...w1, ...w2]) {
                distMap.set(w.userId, (distMap.get(w.userId) || 0) + w.amount);
              }
              const customDistributions = Array.from(distMap.entries()).map(([userId, amount]) => ({
                userId,
                amount,
              }));

              this.handController.resolveRunItTwice(board1, board2, customDistributions);
            };
          });
        })().catch((err) => {
          console.debug(`[HeadlessTableEngine:${this.tableId}] RIT failed:`, err);
          if (this.handController) this.handController.resumeRunout();
        });
        break;
      }

      case 'COMMUNITY_CARDS':
        // Track if we reached the flop for No Flop No Drop
        if (event.stage === 'flop') {
          this.currentHandWentToFlop = true;
          // Emit FLOP_SEEN for Daily Challenges if current user is at this table
          this.emitIfUserAtTable(players, () => {
            masterBus.emit('FLOP_SEEN', {
              handId: `${this.tableId}-${this.handCount}`,
              tableId: this.tableId,
            });
          });
        }
        // Broadcast new community cards
        this.broadcastCurrentState();
        break;

      case 'SHOWDOWN':
        // Capture showdown results for BBJ trigger checking
        this.currentHandShowdownResults = event.results || [];
        // Check for Bad Beat Jackpot trigger (non-blocking)
        if (!this.isTournamentTable()) {
          this.checkAndExecuteBBJTrigger(players).catch((err) =>
            console.debug(`[HeadlessTableEngine:${this.tableId}] BBJ trigger check error:`, err)
          );
        }
        // Broadcast showdown
        this.broadcastCurrentState();
        break;

      case 'WINNERS':
        // Capture winner IDs from the event for Horse Brain processing
        this.currentHandWinnerIds = (event.winners || []).map(
          (w: { userId?: string; user_id?: string }) => w.userId || w.user_id || ''
        );
        // Capture final pot size for rake calculation
        if (this.handController) {
          const state = this.handController.getState();
          this.currentHandPotSize = state.pot;
          // Update player stacks in local array
          for (const enginePlayer of state.players) {
            const localPlayer = players.find((p) => p.user_id === enginePlayer.user_id);
            if (localPlayer) {
              localPlayer.stack = enginePlayer.stack;
            }
          }
        }
        // Emit Daily Challenge events if current user won this hand
        this.emitWinnerEvents(event, players);
        // Broadcast winners
        this.broadcastCurrentState();
        break;

      case 'HAND_COMPLETE': {
        // Capture the AUTHORITATIVE pot and rake from HandController
        // These are the final values calculated at hand end — use these for all downstream
        if (typeof event.pot === 'number' && event.pot > 0) {
          this.currentHandPotSize = event.pot;
        }
        if (typeof event.rake === 'number' && event.rake >= 0) {
          this.currentHandRake = event.rake;
        }

        // Record hand timing for telemetry
        const handDuration = Date.now() - (this as any)._handStartTime;
        engineTelemetry.recordHandTiming(this.tableId, 0, 0, handDuration);

        // Emit HAND_COMPLETED for Daily Challenges if current user participated
        this.emitIfUserAtTable(players, () => {
          masterBus.emit('HAND_COMPLETED', {
            handId: `${this.tableId}-${this.handCount}`,
            tableId: this.tableId,
          });
        });
        // Stack sync + post-hand tasks run as fire-and-forget async block
        // The dealHand() promise resolves when this event fires, so sync completes
        // before next hand via the stackSyncPromise mechanism
        this.stackSyncPromise = (async () => {
          // Sync stacks back to database — MUST complete before next hand loads from DB
          try {
            await this.syncStacksToDatabase(players);
          } catch (err: unknown) {
            console.debug(`[HeadlessTableEngine:${this.tableId}] Failed to sync stacks:`, err);
            // Retry once after brief delay
            try {
              await new Promise((r) => setTimeout(r, 500));
              await this.syncStacksToDatabase(players);
            } catch (retryErr) {
              console.debug(
                `[HeadlessTableEngine:${this.tableId}] Stack sync retry ALSO failed:`,
                retryErr
              );
            }
          }

          // Sync tournament player chips AFTER table_seats are written (tournament tables only)
          // This reads from table_seats (DB source of truth) and writes to tournament_players
          if (this.isTournamentTable() && this.tableInfo?.tournament_id) {
            try {
              await this.syncTournamentPlayerChips(players);
            } catch (err: unknown) {
              console.debug(
                `[HeadlessTableEngine:${this.tableId}] Tournament chip sync error:`,
                err
              );
            }
          }
        })();

        // Execute rake waterfall (cash games only — no rake in tournaments)
        if (!this.isTournamentTable()) {
          this.executeRakeWaterfall(players).catch((err) =>
            console.debug(`[HeadlessTableEngine:${this.tableId}] Rake waterfall error:`, err)
          );
        }

        // Auto-rebuy horses with 0 stack (cash games only — tournaments eliminate)
        if (!this.isTournamentTable()) {
          this.autorebuyHorses(players).catch((err) =>
            console.debug(`[HeadlessTableEngine:${this.tableId}] Failed to auto-rebuy horses:`, err)
          );
        }

        // Process players who requested to leave mid-hand (leave_pending flag)
        if (!this.isTournamentTable()) {
          this.processLeavePendingPlayers().catch((err) =>
            console.debug(
              `[HeadlessTableEngine:${this.tableId}] Leave-pending processing error:`,
              err
            )
          );
        }

        // Feed hand result to Horse Brain's 32 anti-exploit modules
        // Capture state BEFORE handController is nullified (may already be null after invalidation)
        const brainState = this.handController?.getState() ?? null;
        if (HorseBrainAdapter.isBrainAvailable() && brainState) {
          const stage = brainState.stage || 'river';

          HorseBrainAdapter.processHandResult(
            this.tableId,
            this.tableInfo?.big_blind || 2,
            stage,
            this.currentHandPotSize,
            players.map((p) => {
              // Calculate actual chip delta from pre-hand stacks vs final stacks
              const enginePlayer = brainState?.players.find(
                (ep: { user_id: string }) => ep.user_id === p.user_id
              );
              // Use captured pre-hand stacks (p.stack was mutated by WINNERS event)
              const initialStack = this.currentHandInitialStacks.get(p.user_id) ?? p.stack;
              const finalStack = enginePlayer?.stack ?? p.stack;
              const chipDelta = finalStack - initialStack;

              return {
                user_id: p.user_id,
                chipDelta,
                showedCards: (enginePlayer?.cards && enginePlayer.cards.length > 0) || false,
                folded: enginePlayer?.is_folded || false,
                invested: enginePlayer?.totalInvested || 0,
              };
            }),
            this.currentHandWinnerIds
          ).catch((err) => {
            console.debug(
              `[HeadlessTableEngine:${this.tableId}] Brain result processing failed:`,
              err.message
            );
          }); // Non-blocking
        }
        // Reset per-hand tracking
        this.currentHandWinnerIds = [];
        break;
      }
    }
  }

  private handleTurnChange(event: HandEvent, players: SeatedPlayer[]): void {
    if (event.type !== 'TURN_CHANGE') return;
    if (!this.handController) return;

    const seat = event.seat;
    const player = players.find((p) => p.seat_number === seat);
    if (!player) return;

    // Build hand context from current state
    const state = this.handController.getState();
    const enginePlayer = state.players.find((p) => p.seat === seat);
    if (!enginePlayer) return;

    const toCall = Math.max(0, state.currentBet - enginePlayer.bet);

    // ── HUMAN ACTION TIMER (Auto-Fold/Check if Timeout) ──
    if (!player.is_horse) {
      const actionTimeMs = (this.tableInfo?.action_time_seconds || 15) * 1000;

      const timerId = workerTimeout(() => {
        if (!this.handController || !this.running || this.handInvalidated) return;

        // Try to activate time bank before auto-acting
        const timeBankActivated = timeBankEngine.onPrimaryTimerExpired(
          this.tableId,
          player.user_id,
          () => {
            // This callback fires when the time bank ALSO expires — now auto-act
            if (!this.handController || !this.running || this.handInvalidated) return;
            const freshState = this.handController.getState();
            const freshPlayer = freshState.players.find((p) => p.seat === seat);
            const freshToCall = freshPlayer
              ? Math.max(0, freshState.currentBet - freshPlayer.bet)
              : toCall;
            const action = freshToCall === 0 ? 'check' : 'fold';
            try {
              this.handController!.performAction(player.seat_number, action as any);
            } catch (err: unknown) {
              console.debug(
                `[HeadlessTableEngine:${this.tableId}] Auto-action (post-timebank) failed for ${player.username}:`,
                err
              );
            }
          }
        );

        if (timeBankActivated) {
          // Time bank is now running — the onExpire callback above handles auto-action
          return;
        }

        // No time bank available — auto-fold/check immediately
        const freshState = this.handController.getState();
        const freshPlayer = freshState.players.find((p) => p.seat === seat);
        const freshToCall = freshPlayer
          ? Math.max(0, freshState.currentBet - freshPlayer.bet)
          : toCall;
        const action = freshToCall === 0 ? 'check' : 'fold';
        try {
          this.handController.performAction(player.seat_number, action as any);
        } catch (err: unknown) {
          console.debug(
            `[HeadlessTableEngine:${this.tableId}] Auto-action failed for ${player.username}:`,
            err
          );
        }
      }, actionTimeMs);

      this.pendingTimerIds.push(timerId);
      return; // Stop here! Don't let the HorseBrainAdapter play for humans!
    }

    // ── Map horse_profile to winning style ──
    // All horses are fundamentally winning players with different styles
    const styleMap: Record<string, HorseStyle> = {
      tag: 'tag',
      lag: 'lag',
      balanced: 'balanced',
      tricky: 'tricky',
      grinder: 'grinder',
      // Legacy profile mapping (all become winning styles)
      reg: 'tag',
      fish: 'balanced',
      nit: 'grinder',
      maniac: 'lag',
    };
    const horseStyle: HorseStyle = styleMap[player.horse_profile || 'balanced'] || 'balanced';

    // ── Build GameState ──
    const gameState = {
      players: state.players,
      communityCards: (state.communityCards || []) as any[],
      pot: state.pot,
      currentBet: state.currentBet,
      minRaise: state.minRaise,
      stage: state.stage as string,
      gameVariant: (this.tableInfo?.game_variant || 'nlh') as string,
      bigBlind: this.tableInfo?.big_blind || 2,
    };

    // ── Get decision from Horse Brain (falls back to HorseLogic if brain not loaded) ──
    const gameType = this.isTournamentTable() ? 'tournament' : 'cash';
    const handControllerRef = this.handController;

    // Async decision flow — brain may be async, but we handle it within the timer
    (async () => {
      let decision: HorseDecision;
      try {
        decision = await HorseBrainAdapter.getDecision(
          player.user_id,
          enginePlayer,
          gameState,
          this.tableId,
          horseStyle,
          gameType as 'cash' | 'tournament'
        );
      } catch {
        decision = HorseLogic.decide(enginePlayer, gameState as any, horseStyle);
      }

      // GTO overlay only when using HorseLogic fallback (brain has its own GTO integration)
      if (!HorseBrainAdapter.isBrainAvailable()) {
        this.enhanceWithGTO(enginePlayer, state, decision, horseStyle).catch((e) =>
          console.warn('[HeadlessTableEngine] Failed to enhance decision with GTO:', e)
        );
      }

      // Execute after think time (shortened for headless — 200-600ms)
      const thinkTime = Math.min(decision.thinkTime, 200 + Math.random() * 400);

      const timerId = workerTimeout(() => {
        if (!handControllerRef || !this.running) return;

        // Recalculate from FRESH state (stale captures may cause wrong action)
        const freshState = handControllerRef.getState();
        const freshEnginePlayer = freshState.players.find((p) => p.seat === seat);
        const freshToCall = freshEnginePlayer
          ? Math.max(0, freshState.currentBet - freshEnginePlayer.bet)
          : toCall;

        let action = decision.action as string;
        let amount = decision.amount;

        // Validate and normalize action using FRESH state
        if (action === 'allin') action = 'all_in';
        if (action === 'check' && freshToCall > 0) action = 'call';
        if (action === 'call' && freshToCall === 0) action = 'check';
        if (action === 'call') amount = freshToCall;
        if (action === 'fold' && freshToCall === 0) action = 'check';

        // Validate bet/raise — convert to correct action type
        if (action === 'raise' && freshState.currentBet === 0) action = 'bet';
        if (action === 'bet' && freshState.currentBet > 0) action = 'raise';

        // Clamp bet/raise amounts to valid range
        const playerStack = freshEnginePlayer?.stack ?? enginePlayer.stack;
        const playerBet = freshEnginePlayer?.bet ?? enginePlayer.bet;
        if (action === 'bet' && amount !== undefined) {
          amount = Math.max(freshState.minRaise, amount);
          if (amount >= playerStack) {
            action = 'all_in';
            amount = undefined;
          }
        } else if (action === 'raise' && amount !== undefined) {
          const minRaiseTo = freshState.currentBet + freshState.minRaise;
          amount = Math.max(minRaiseTo, amount);
          const maxRaiseTo = playerStack + playerBet;
          if (amount >= maxRaiseTo) {
            action = 'all_in';
            amount = undefined;
          }
        }

        // Check if hand was invalidated before executing action
        if (this.handInvalidated || !handControllerRef) {
          return; // Don't execute action if hand timed out
        }

        try {
          handControllerRef.performAction(seat, action as any, amount);
        } catch {
          // If action fails, try folding as fallback
          try {
            handControllerRef.performAction(seat, 'fold');
          } catch {
            // Hand may have already completed
          }
        }
      }, thinkTime);
      this.pendingTimerIds.push(timerId);
    })().catch((err) => {
      console.debug(`[HeadlessTableEngine:${this.tableId}] Horse decision error:`, err);
      // Emergency fallback: fold (only if hand is still valid)
      if (this.handInvalidated || !handControllerRef) return;
      try {
        handControllerRef.performAction(seat, 'fold');
      } catch {
        /* Hand may have completed */
      }
    });
  }

  /**
   * GTO Enhancement Layer — overlay PioSolver data on top of HorseLogic decisions
   * This is non-blocking and only modifies the decision if GTO data is available.
   * Gracefully falls back to HorseLogic's built-in evaluation if no data exists.
   */
  private async enhanceWithGTO(
    player: SeatPlayer,
    state: any,
    decision: HorseDecision,
    style: HorseStyle
  ): Promise<void> {
    try {
      // Map seat number to position name
      const totalPlayers = state.players.filter((p: { is_folded: boolean }) => !p.is_folded).length;
      const positionMap: Record<number, string> = {
        1: 'SB',
        2: 'BB',
        3: totalPlayers <= 6 ? 'UTG' : 'UTG',
        4: totalPlayers <= 6 ? 'CO' : 'MP',
        5: 'CO',
        6: 'BTN',
      };
      const position = positionMap[player.seat] || 'BTN';

      // Determine pot type
      const maxBet = state.currentBet || 0;
      const bb = this.tableInfo?.big_blind || 2;
      const potType = maxBet > bb * 6 ? '3bet' : maxBet > bb ? 'srp' : 'limp';

      // Build board string
      const board = (state.communityCards || []).map(
        (c: { rank: string; suit: string }) => `${c.rank}${c.suit}`
      );

      const actionFacing =
        state.currentBet > 0 && state.pot > 0
          ? `bet_${Math.round((state.currentBet / state.pot) * 100)}`
          : state.currentBet > 0
            ? 'bet_100'
            : 'check';

      // Query GTO solution (cached in-memory)
      const gtoSolution = await GTOQueryService.getGTOAction(
        position,
        potType,
        state.stage,
        board,
        actionFacing
      );

      if (!gtoSolution) return; // No GTO data — keep HorseLogic decision

      // Use GTO frequencies to influence the decision
      const freqs = gtoSolution.gto_frequencies;
      if (!freqs) return;

      // Sample from GTO frequencies with style-based weighting
      // TAG/Grinder follow GTO more closely; LAG/Tricky deviate more
      const gtoAdherence: Record<HorseStyle, number> = {
        tag: 0.85,
        grinder: 0.8,
        balanced: 0.75,
        lag: 0.6,
        tricky: 0.55,
      };
      const adherence = gtoAdherence[style] || 0.7;

      // Only override if GTO strongly disagrees with HorseLogic (> adherence threshold)
      const currentAction = decision.action;
      const gtoFreqForAction = freqs[currentAction] || 0;

      // If GTO says our chosen action has < 10% frequency, switch to GTO recommendation
      if (gtoFreqForAction < 0.1 && Math.random() < adherence) {
        const gtoAction = gtoSolution.gto_action;
        if (gtoAction && gtoAction !== currentAction) {
          decision.action = gtoAction as any;
          // Adjust amount from GTO raise sizes if available
          if ((gtoAction === 'raise' || gtoAction === 'bet') && gtoSolution.raise_sizes) {
            const sizes = Object.entries(gtoSolution.raise_sizes);
            if (sizes.length > 0) {
              // Pick most frequent sizing
              sizes.sort((a, b) => (b[1] as number) - (a[1] as number));
              const sizeKey = sizes[0][0]; // e.g. 'size_75'
              const pctMatch = sizeKey.match(/(\d+)/);
              if (pctMatch) {
                const pct = parseInt(pctMatch[1]) / 100;
                decision.amount = Math.trunc(state.pot * pct);
              }
            }
          }
        }
      }
    } catch {
      // GTO enhancement is best-effort — never block decisions
    }
  }

  private async syncStacksToDatabase(players: SeatedPlayer[]): Promise<void> {
    // Batch all stack updates — each is independent so failures are isolated
    const updates = players.map((player) =>
      this.supabaseClient
        .from('table_seats')
        .update({ stack: player.stack })
        .eq('table_id', this.tableId)
        .eq('user_id', player.user_id)
        .is('left_at', null)
    );
    const results = await Promise.allSettled(updates);
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      console.debug(
        `[HeadlessTableEngine:${this.tableId}] ${failures.length}/${players.length} stack syncs failed`
      );
    }
  }

  /**
   * Sync stacks to tournament_players.stack so tournament engine can track eliminations
   */
  private async syncTournamentPlayerChips(_players: SeatedPlayer[]): Promise<void> {
    if (!this.tableInfo?.tournament_id) {
      console.debug(
        `[HeadlessTableEngine:${this.tableId}] syncTournamentPlayerChips skipped — no tournament_id`
      );
      return;
    }

    // Read authoritative stacks directly from table_seats (DB source of truth)
    // because in-memory player stacks may not reflect final post-hand values
    const { data: seats, error: seatErr } = await this.supabaseClient
      .from('table_seats')
      .select('user_id, stack')
      .eq('table_id', this.tableId)
      .is('left_at', null);

    if (seatErr || !seats || seats.length === 0) {
      console.debug(
        `[HeadlessTableEngine:${this.tableId}] syncTournamentPlayerChips — no seats found or error: ${seatErr?.message}`
      );
      return;
    }

    await Promise.allSettled(
      seats.map(async (seat) => {
        // tournament_players.chips is INTEGER — truncate to whole number (never round up)
        const rounded = Math.trunc(seat.stack);
        const { error } = await this.supabaseClient
          .from('tournament_players')
          .update({ chips: rounded })
          .eq('tournament_id', this.tableInfo!.tournament_id!)
          .eq('user_id', seat.user_id);
        if (error) {
          console.debug(
            `[HeadlessTableEngine:${this.tableId}] Tournament chip sync error for ${seat.user_id.slice(0, 8)}: ${error.message}`
          );
        }
      })
    );
  }

  private async autorebuyHorses(players: SeatedPlayer[]): Promise<void> {
    // Only horses (liquidity fleet) get auto-rebuyed — real players must rebuy manually
    const bustHorses = players.filter((p) => p.is_horse && p.stack === 0);
    if (bustHorses.length === 0) return;

    const clubId = this.tableInfo?.club_id;
    if (!clubId) return;

    for (const horse of bustHorses) {
      const rebuyAmount = this.tableInfo?.big_blind ? this.tableInfo.big_blind * 100 : 200;

      try {
        // 1. Check horse's Player Wallet balance
        const balance = await WalletService.getWallet(horse.user_id, 'PLAYER');
        if (!balance) {
          console.debug(
            `[HeadlessTableEngine:${this.tableId}] Horse ${horse.username} has no Player Wallet — cannot rebuy`
          );
          await this.markHorseAsLeft(horse.user_id, 'no_wallet');
          continue;
        }
        const walletData = balance;

        const walletBalance = walletData.balance || 0;
        if (walletBalance < rebuyAmount) {
          console.debug(
            `[HeadlessTableEngine:${this.tableId}] Horse ${horse.username} insufficient funds: ` +
              `wallet ${walletBalance} < rebuy ${rebuyAmount} — stays busted`
          );
          await this.markHorseAsLeft(horse.user_id, 'insufficient_funds');
          continue;
        }

        // 2 & 3. Deduct from Player Wallet and update seat atomically via SECURITY DEFINER RPC
        const { error: rebuyError } = await this.supabaseClient.rpc('atomic_table_rebuy', {
          p_user_id: horse.user_id,
          p_table_id: this.tableId,
          p_amount: rebuyAmount,
        });

        if (rebuyError) {
          console.debug(
            `[HeadlessTableEngine:${this.tableId}] Atomic auto-rebuy failed for ${horse.username}:`,
            rebuyError.message
          );
          continue;
        }

        // Update local stack so the engine knows right away
        horse.stack = rebuyAmount;

        // Transaction logging is handled inside atomic_table_rebuy RPC via log_wallet_transaction

        // 5. Also log in chip_transactions for club-level accounting
        this.supabaseClient
          .from('chip_transactions')
          .insert({
            club_id: clubId,
            to_user_id: horse.user_id,
            amount: rebuyAmount,
            transaction_type: 'buy_in',
            notes: `Auto-rebuy at table ${this.tableId}`,
          })
          .then(() => {}); // Silent — RLS may block anon writes

        // Track rebuy in Horse Brain
        HorseBrainAdapter.recordRebuy(this.tableId, horse.user_id, rebuyAmount);
      } catch (err: unknown) {
        console.debug(
          `[HeadlessTableEngine:${this.tableId}] Auto-rebuy failed for ${horse.username}:`,
          err
        );
      }
    }
  }

  /**
   * Mark a horse as having left the table (set left_at timestamp)
   * Called when a horse runs out of chips and can't rebuy from wallet
   */
  /**
   * Process seats flagged with leave_pending=true after hand completes.
   * Credits remaining stack back to Player Wallet and removes the seat.
   * This handles the case where a player clicked "Leave" mid-hand.
   */
  private async processLeavePendingPlayers(): Promise<void> {
    const { data: pendingSeats, error } = await this.supabaseClient
      .from('table_seats')
      .select('user_id, stack, seat_number')
      .eq('table_id', this.tableId)
      .eq('leave_pending', true)
      .is('left_at', null);

    if (error || !pendingSeats || pendingSeats.length === 0) return;

    const clubId = this.tableInfo?.club_id;

    for (const seat of pendingSeats) {
      try {
        // Use the FULLY ATOMIC cashout RPC to prevent double-spend if the node crashes
        // right after crediting the wallet but before updating the seat left_at timestamp.
        const { data: returnedChips, error: cashoutError } = await this.supabaseClient.rpc(
          'atomic_table_cashout',
          {
            p_table_id: this.tableId,
            p_user_id: seat.user_id,
          }
        );

        if (cashoutError) {
          console.debug(
            `[HeadlessTableEngine:${this.tableId}] Failed atomic cashout for ${seat.user_id}:`,
            cashoutError.message
          );
          continue; // Skip accounting log if it failed
        }

        // Emit BALANCE_UPDATED so the player's cashier/wallet UI refreshes in real-time
        masterBus.emit('BALANCE_UPDATED', {
          source: 'leave_pending_cashout',
          userId: seat.user_id,
          amount: returnedChips,
        });
        // Try to log in chip_transactions for club accounting (fire-and-forget)
        if (clubId && returnedChips > 0) {
          // Fire-and-forget (Supabase JS client executes when not awaited but then/catch causes TS issues)
          // Actually, we must `then()` or await it to execute in older supabase-js versions,
          // but we can wrap it in an immediately invoked async function.
          const logChipRx = async () => {
            try {
              await this.supabaseClient.from('chip_transactions').insert({
                club_id: clubId,
                from_user_id: seat.user_id,
                amount: returnedChips,
                transaction_type: 'cashout',
                notes: `Cash-out from table (leave_pending after hand) ${this.tableId}`,
              });
            } catch (e: unknown) {
              // silent
            }
          };
          logChipRx();
        }
      } catch (err: unknown) {
        console.debug(
          `[HeadlessTableEngine:${this.tableId}] Error processing leave_pending for ${seat.user_id}:`,
          err
        );
      }
    }

    // Update player count after removals
    const { count, error: countErr } = await this.supabaseClient
      .from('table_seats')
      .select('*', { count: 'exact', head: true })
      .eq('table_id', this.tableId)
      .is('left_at', null);

    if (!countErr) {
      await this.supabaseClient
        .from('tables')
        .update({ current_players: count ?? 0 })
        .eq('id', this.tableId);
    } else {
      console.debug(
        `[HeadlessTableEngine:${this.tableId}] Recount after leave-pending failed:`,
        countErr
      );
    }
  }

  private async markHorseAsLeft(userId: string, reason: string): Promise<void> {
    const { error } = await this.supabaseClient
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .eq('table_id', this.tableId)
      .eq('user_id', userId)
      .is('left_at', null);

    if (error) {
      console.debug(`[HeadlessTableEngine:${this.tableId}] Failed to mark horse as left:`, error);
    } else {
      // Sync tables.current_players immediately so merge/balance reads correct count
      const { count, error: countErr } = await this.supabaseClient
        .from('table_seats')
        .select('*', { count: 'exact', head: true })
        .eq('table_id', this.tableId)
        .is('left_at', null);

      if (countErr) {
        console.debug(
          `[HeadlessTableEngine:${this.tableId}] Recount failed after horse left:`,
          countErr
        );
      } else {
        await this.supabaseClient
          .from('tables')
          .update({ current_players: count ?? 0 })
          .eq('id', this.tableId);

        // Emit bus event so lobby/UI updates the table player count in real-time
        masterBus.emit('TABLE_UPDATED', { tableId: this.tableId });
      }
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: RAKE WATERFALL
  // ═════════════════════════════════════════════════════════════════════════════

  private async executeRakeWaterfall(players: SeatedPlayer[]): Promise<void> {
    if (!this.tableInfo) return;

    const potSize = this.currentHandPotSize;
    const wentToFlop = this.currentHandWentToFlop;

    // No Flop, No Drop — skip entirely if pot never reached flop
    if (!wentToFlop) {
      return;
    }

    // Minimum pot threshold — don't rake tiny pots
    if (potSize <= 0) {
      return;
    }

    // Get hand ID directly from per-table persistence (no extra DB query needed)
    const handId = this.persistence.getCurrentHandId() || crypto.randomUUID();

    // Resolve unionId from club's union membership (cached per engine instance)
    let unionId: string | undefined;
    try {
      if (!this._cachedUnionId && this.tableInfo.club_id) {
        const { data: ucRow } = await this.supabaseClient
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', this.tableInfo.club_id)
          .limit(1)
          .maybeSingle();
        this._cachedUnionId = ucRow?.union_id || '__none__';
      }
      unionId = this._cachedUnionId === '__none__' ? undefined : this._cachedUnionId;
    } catch {
      /* standalone club — no union */
    }

    // Build dealt-in player list for rake attribution
    const dealtInPlayers: DealtInPlayer[] = players.map((p) => ({
      userId: p.user_id,
      agentId: p.agent_id, // Include agent ID for commission tracking
      clubId: this.tableInfo!.club_id,
      isSittingOut: false, // All players in HeadlessTableEngine are active
      hasCards: true, // All dealt players have cards
      wentToFlop,
    }));

    try {
      const result = await RakeService.executeWaterfall({
        handId,
        tableId: this.tableId,
        clubId: this.tableInfo.club_id,
        unionId,
        smallBlind: this.tableInfo.small_blind,
        bigBlind: this.tableInfo.big_blind,
        potSize,
        wentToFlop,
        players: dealtInPlayers,
        // Pass HandController's authoritative rake so waterfall doesn't re-calculate
        // This ensures rake is based on the FINAL pot at hand end (single source of truth)
        preCalculatedRake: this.currentHandRake > 0 ? this.currentHandRake : undefined,
      });

      if (result.calculation.cappedRake > 0) {
        // Rake collected — no additional action needed (waterfall handles distribution)
      }
    } catch (err: unknown) {
      console.debug(
        `[HeadlessTableEngine:${this.tableId}] RakeService.executeWaterfall failed:`,
        err
      );
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: BBJ TRIGGER CHECK
  // ═════════════════════════════════════════════════════════════════════════════

  private async checkAndExecuteBBJTrigger(players: SeatedPlayer[]): Promise<void> {
    // Need at least 2 players in showdown
    if (this.currentHandShowdownResults.length < 2) {
      return;
    }

    // Sort by hand ranking to identify winner and loser (descending: best hand first)
    const sorted = [...this.currentHandShowdownResults].sort((a, b) => {
      // Higher ranking number is better (ROYAL_FLUSH=10 > HIGH_CARD=1)
      const rankA = a.hand?.ranking ?? 0;
      const rankB = b.hand?.ranking ?? 0;
      if (rankA !== rankB) return rankB - rankA;
      // Tie-break by kickers
      const kickA = a.hand?.kickers || [];
      const kickB = b.hand?.kickers || [];
      for (let i = 0; i < Math.max(kickA.length, kickB.length); i++) {
        if ((kickB[i] ?? 0) !== (kickA[i] ?? 0)) return (kickB[i] ?? 0) - (kickA[i] ?? 0);
      }
      return 0;
    });

    const winner = sorted[0];
    const loser = sorted[1];

    if (!winner?.hand || !loser?.hand) {
      return;
    }

    // Check if this hand qualifies for Bad Beat Jackpot
    const gameVariant = (this.tableInfo?.game_variant || 'nlh') as BBJGameVariant;
    const bbjResult = BBJService.checkBBJTrigger(loser.hand, winner.hand, gameVariant);

    if (!bbjResult.triggered) {
      return;
    }

    // BBJ triggered! Get the pool and execute payout
    try {
      const pool = await BBJService.getPool({
        clubId: this.tableInfo?.club_id,
      });

      if (!pool) {
        console.debug(
          `[HeadlessTableEngine:${this.tableId}] BBJ pool not found for club ${this.tableInfo?.club_id}`
        );
        return;
      }

      // Get hand ID and other context
      const handId = this.persistence.getCurrentHandId() || crypto.randomUUID();
      const dealtInPlayerIds = players.map((p) => p.user_id);

      // Find winner and loser user IDs from showdown results
      const winnerPlayer = players.find((p) => p.user_id === winner.userId);
      const loserPlayer = players.find((p) => p.user_id === loser.userId);

      if (!winnerPlayer || !loserPlayer) {
        console.debug(
          `[HeadlessTableEngine:${this.tableId}] Could not find winner or loser in players`
        );
        return;
      }

      if (!this.tableInfo) {
        console.debug(`[HeadlessTableEngine:${this.tableId}] Table info is missing`);
        return;
      }

      // Determine stakes tier from big blind
      const stakesTier = this.tableInfo.big_blind
        ? this.tableInfo.big_blind <= 1
          ? 'micro'
          : this.tableInfo.big_blind <= 5
            ? 'low'
            : this.tableInfo.big_blind <= 20
              ? 'mid'
              : 'high'
        : 'mid';

      // Execute the payout with full parameters
      await BBJService.executePayout({
        poolId: pool.id,
        handId,
        clubId: this.tableInfo.club_id,
        tableId: this.tableId,
        handNumber: this.handCount,
        bigBlind: this.tableInfo.big_blind,
        stakesTier,
        gameVariant: gameVariant,
        winnerUserId: winner.userId,
        winnerHand: winner.hand.name || 'Unknown',
        winnerCards: winner.cards?.join(', ') || '',
        winnerDisplayName: winnerPlayer.username,
        loserUserId: loser.userId,
        loserHand: loser.hand.name || 'Unknown',
        loserCards: loser.cards?.join(', ') || '',
        loserDisplayName: loserPlayer.username,
        dealtInPlayerIds,
      });
      // Broadcast BBJ_HIT event for UI notification via table channel
      try {
        supabase
          .channel(`table:${this.tableId}`)
          .send({
            type: 'broadcast',
            event: 'bbj_hit',
            payload: {
              table_id: this.tableId,
              winner_name: winnerPlayer.username,
              loser_name: loserPlayer.username,
              pool_amount: pool.main_balance,
            },
          })
          .catch((err: unknown) => {
            console.debug(
              `[HeadlessTableEngine:${this.tableId}] Failed to broadcast BBJ event:`,
              err
            );
          });
      } catch (broadcastErr: unknown) {
        console.debug(`[HeadlessTableEngine:${this.tableId}] BBJ broadcast error:`, broadcastErr);
      }
    } catch (err: unknown) {
      console.debug(`[HeadlessTableEngine:${this.tableId}] BBJ payout execution failed:`, err);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // PRIVATE: RAKE CONFIG
  // ═════════════════════════════════════════════════════════════════════════════

  private getRakeConfig(sb: number, bb: number) {
    // Use RakeService for single source of truth on rake tiers
    const tier = RakeService.getTier(sb, bb);
    return { percent: 10, cap: tier.maxAmount, noFlop: true };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // DAILY CHALLENGE EVENT EMITTING
  // ═════════════════════════════════════════════════════════════════════════════

  /** Check if current logged-in user is at this table; if so, run the callback */
  private emitIfUserAtTable(players: SeatedPlayer[], fn: () => void): void {
    const userId = useUserStore.getState()?.user?.id;
    if (!userId) return;
    if (players.some((p) => p.user_id === userId && !p.is_horse)) {
      fn();
    }
  }

  /** Emit winner-specific events for Daily Challenges */
  private emitWinnerEvents(event: HandEvent, players: SeatedPlayer[]): void {
    const userId = useUserStore.getState()?.user?.id;
    if (!userId) return;
    if (!players.some((p) => p.user_id === userId && !p.is_horse)) return;

    const winners: Array<{ userId?: string; user_id?: string; pot?: number; hand?: unknown }> =
      (event as any).winners || [];
    const userWon = winners.some((w) => (w.userId || w.user_id) === userId);
    if (!userWon) return;

    const handId = `${this.tableId}-${this.handCount}`;
    const totalPot = this.currentHandPotSize || 0;
    const bb = this.tableInfo?.big_blind || 2;

    // HAND_WON
    masterBus.emit('HAND_WON', {
      handId,
      winners: winners.map((w) => w.userId || w.user_id || ''),
      pot: totalPot,
    });

    // BIG_POT_WON — pot > 100 big blinds
    if (totalPot > bb * 100) {
      masterBus.emit('BIG_POT_WON', { handId, pot: totalPot });
    }

    // PREFLOP_WIN — won without seeing a flop
    if (!this.currentHandWentToFlop) {
      masterBus.emit('PREFLOP_WIN', { handId, playerId: userId });
    }

    // ALL_IN_WON — check if user was all-in
    const state = this.handController?.getState();
    const userEngine = state?.players?.find((p: { user_id: string }) => p.user_id === userId);
    if (userEngine?.is_all_in) {
      masterBus.emit('ALL_IN_WON', { handId, playerId: userId, pot: totalPot });
    }

    // FLUSH_WIN — check showdown results for flush
    if (this.currentHandShowdownResults.length > 0) {
      const userResult = this.currentHandShowdownResults.find(
        (r: { userId?: string; user_id?: string }) => (r.userId || r.user_id) === userId
      );
      const handName = (userResult?.handName || userResult?.hand_name || '').toLowerCase();
      if (handName.includes('flush') && !handName.includes('straight')) {
        masterBus.emit('FLUSH_WIN', { handId, playerId: userId });
      }
    }
  }
}

export default HeadlessTableEngine;
