/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * TOURNAMENT ENGINE — Headless tournament orchestrator
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the full lifecycle of a poker tournament:
 * 1. REGISTERING → RUNNING transition
 * 2. Creates tournament tables and seats players
 * 3. Deals hands via HeadlessTableEngine (tournament mode)
 * 4. Tracks blind level advancement
 * 5. Eliminates busted players, awards prizes
 * 6. Handles table balancing when players bust
 * 7. Detects winner (last player standing)
 *
 * Used by DealerPage to orchestrate all active tournaments.
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { HeadlessTableEngine } from './HeadlessTableEngine';
import { tableBreakEngine, type TableSnapshot } from './TableBreakEngine';
import { chipRaceEngine } from './ChipRaceEngine';
import {
  BLIND_STRUCTURES,
  PAYOUT_STRUCTURES,
  SPIN_BLIND_STRUCTURE,
} from '../services/TournamentService';
import { WalletService } from '../services/WalletService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
  isBreak?: boolean;
}

interface PayoutEntry {
  place: number;
  position?: number; // DB may use 'position' instead of 'place'
  percentage: number;
}

interface TournamentInfo {
  id: string;
  name: string;
  club_id: string;
  game_type: string;
  variant?: string;
  tournament_type?: string;
  buy_in_amount: number;
  buy_in_fee?: number;
  starting_chips: number;
  max_players: number;
  current_players: number;
  prize_pool: number;
  blind_structure: BlindLevel[];
  payout_structure: PayoutEntry[];
  started_at: string;
  current_level?: number;
  // Late reg / rebuy / add-on (level-based)
  late_reg_levels?: number;
  late_reg_mins?: number; // Legacy
  add_on_available?: boolean;
  rebuy_levels?: number;
  is_reentry?: boolean;
  prize_pool_finalized?: boolean;
  // Add-on details
  addon_cost?: number;
  addon_chips?: number;
  addon_levels?: number;
  // Bounty fields
  is_bounty?: boolean;
  is_pko?: boolean;
  is_mystery_bounty?: boolean;
  bounty_amount?: number;
  // Satellite fields
  satellite_target?: string | null;
}

interface TournamentTable {
  tableId: string;
  engine: HeadlessTableEngine;
  playerCount: number;
}

interface TournamentPlayer {
  user_id: string;
  username: string;
  chips: number;
  status: 'playing' | 'eliminated' | 'winner';
  tableId?: string;
  seatNumber?: number;
  position?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BLIND STRUCTURE RESOLVER
// ═══════════════════════════════════════════════════════════════════════════════

function resolveBlindStructure(raw: unknown): BlindLevel[] {
  if (Array.isArray(raw) && raw.length > 0) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      /* not JSON */
    }

    // Resolve named structures
    const key = raw.toLowerCase().replace(/\s+/g, '');
    if (key === 'turbo') return BLIND_STRUCTURES.turbo;
    if (key === 'regular' || key === 'standard') return BLIND_STRUCTURES.regular;
    if (key === 'deepstack' || key === 'deep') return BLIND_STRUCTURES.deepStack;
    if (key === 'sng') return BLIND_STRUCTURES.sng;
    if (key === 'hyperturbo' || key === 'hyper' || key === 'spin') return SPIN_BLIND_STRUCTURE;
  }
  // Default to regular (covers empty arrays, null, undefined, unrecognized strings)
  return BLIND_STRUCTURES.regular;
}

function resolvePayoutStructure(raw: unknown, playerCount: number): PayoutEntry[] {
  // Normalize: ensure every entry has 'place' (DB may use 'position' instead)
  const normalize = (arr: Array<Record<string, unknown>>): PayoutEntry[] =>
    arr.map((p) => ({
      place: (p.place as number) || (p.position as number) || 0,
      position: (p.position as number) || (p.place as number) || 0,
      percentage: (p.percentage as number) || 0,
    }));

  if (Array.isArray(raw)) return normalize(raw);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalize(parsed);
    } catch {
      /* not JSON */
    }
  }

  // Auto-select based on player count — pay ~15% of field for larger tournaments
  if (playerCount <= 6) return PAYOUT_STRUCTURES.sng6;
  if (playerCount <= 9) return PAYOUT_STRUCTURES.sng9;
  if (playerCount <= 18) return PAYOUT_STRUCTURES.mtt10;
  if (playerCount <= 45) return PAYOUT_STRUCTURES.mtt20;
  if (playerCount <= 90) return PAYOUT_STRUCTURES.mtt50;
  if (playerCount <= 180) return PAYOUT_STRUCTURES.mtt100;
  return PAYOUT_STRUCTURES.mtt200;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT ENGINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class TournamentEngine {
  private tournamentId: string;
  private supabase: SupabaseClient;
  private tournamentInfo: TournamentInfo | null = null;
  private tables: TournamentTable[] = [];
  private players: Map<string, TournamentPlayer> = new Map();
  private running = false;
  private finishing = false; // Guard against concurrent finishTournament calls
  private currentLevel = 0;
  private blindCheckInterval: ReturnType<typeof setInterval> | null = null;
  private eliminationCheckInterval: ReturnType<typeof setInterval> | null = null;
  private handsDealt = 0;
  // Hand-for-hand mode (money bubble)
  private handForHandActive = false;
  private handForHandAnnounced = false;
  // Add-on period (60s after rebuy levels end)
  private addOnPeriodTriggered = false;
  private addOnPeriodActive = false;
  private addOnAbortController: AbortController | null = null;
  private tableBreakInProgress = false;

  constructor(tournamentId: string, supabase: SupabaseClient) {
    this.tournamentId = tournamentId;
    this.supabase = supabase;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  async start(): Promise<void> {
    if (this.running) return;

    // Set running immediately to prevent stale cleanup from killing us during async startup
    this.running = true;

    // Check tournament status — only start if REGISTERING or ANNOUNCED
    const { data: statusCheck, error: statusErr } = await this.supabase
      .from('tournaments')
      .select('status')
      .eq('id', this.tournamentId)
      .maybeSingle();

    if (statusErr || !statusCheck) {
      this.running = false;
      return;
    }

    if (statusCheck.status === 'RUNNING') {
      // Already running — resume tracking instead of starting fresh
      try {
        await this.resumeRunning();
      } catch (err: unknown) {
        console.error(`[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to resume:`, err);
        this.running = false;
      }
      return;
    }

    if (statusCheck.status !== 'REGISTERING' && statusCheck.status !== 'ANNOUNCED') {
      // COMPLETED or CANCELLED — nothing to do
      this.running = false;
      return;
    }

    try {
      // Step 1: Load tournament info
      await this.loadTournament();
      if (!this.tournamentInfo) throw new Error('Failed to load tournament');

      // Step 2: Migrate registrations → tournament_players
      await this.migrateRegistrations();

      // Step 2b: Enforce minimum player count
      const minPlayers = this.getMinPlayers();
      if (this.players.size < minPlayers) {
        // Use TournamentService for proper refund + cancel flow
        const { tournamentService } = await import('../services/TournamentService');
        await tournamentService.cancelTournament(
          this.tournamentId,
          `Only ${this.players.size} player(s) registered — minimum ${minPlayers} required`
        );
        this.running = false;
        return;
      }

      // Step 2c: For Spin & Go tournaments, roll the multiplier with pool-based economics
      if (
        this.tournamentInfo.variant === 'spin' ||
        this.tournamentInfo.tournament_type === 'SPIN'
      ) {
        const {
          tournamentService,
          SPIN_MULTIPLIERS,
          SPIN_BONUS_TIERS,
          SPIN_RAKE_PERCENT,
          SPIN_POOL_CONTRIBUTION_MULTIPLIER,
        } = await import('../services/TournamentService');

        const spinResult = tournamentService.spinMultiplier(SPIN_MULTIPLIERS.standard);
        const buyIn = this.tournamentInfo.buy_in_amount || 0;

        // ── Pool-Based Prize Calculation ──────────────────────────────────
        // Base payout: winner always gets at least 2× buy_in
        const basePayout = 2 * buyIn;
        const poolContribution = SPIN_POOL_CONTRIBUTION_MULTIPLIER * buyIn;
        const requestedBonus = spinResult.bonusBuyIns * buyIn;

        let actualBonus = 0;
        let poolDeposited = 0;

        if (requestedBonus > 0) {
          // Try to draw bonus from pool (capped at balance)
          const clubId = this.tournamentInfo.club_id;
          if (clubId) {
            const { data: poolBalance } = await this.supabase
              .from('spin_bonus_pools')
              .select('balance')
              .eq('club_id', clubId)
              .single();

            const available = poolBalance?.balance ?? 0;
            actualBonus = Math.min(requestedBonus, available);

            if (actualBonus > 0) {
              // Debit from pool
              await this.supabase
                .from('spin_bonus_pools')
                .update({
                  balance: available - actualBonus,
                  updated_at: new Date().toISOString(),
                })
                .eq('club_id', clubId);
            }
          }
        }

        if (actualBonus === 0) {
          // No bonus drawn — deposit 1× buy_in into pool
          const clubId = this.tournamentInfo.club_id;
          if (clubId) {
            poolDeposited = poolContribution;
            const { data: existing } = await this.supabase
              .from('spin_bonus_pools')
              .select('balance')
              .eq('club_id', clubId)
              .single();

            if (existing) {
              await this.supabase
                .from('spin_bonus_pools')
                .update({
                  balance: existing.balance + poolContribution,
                  updated_at: new Date().toISOString(),
                })
                .eq('club_id', clubId);
            } else {
              await this.supabase
                .from('spin_bonus_pools')
                .insert({ club_id: clubId, balance: poolContribution });
            }
          }
        }

        const prizePool = Math.trunc((basePayout + actualBonus) * 100) / 100;

        await this.supabase
          .from('tournaments')
          .update({
            prize_pool: prizePool,
            spin_multiplier: spinResult.multiplier,
            is_premium_spin: spinResult.isPremium || false,
          })
          .eq('id', this.tournamentId);

        this.tournamentInfo.prize_pool = prizePool;

        console.debug(
          `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Spin result: ` +
          `${spinResult.multiplier}x display | prize=${prizePool} | ` +
          `bonus=${actualBonus} | poolDeposit=${poolDeposited}`
        );
      }

      // Step 3: Create tournament tables
      await this.createTournamentTables();

      // Step 4: Seat players at tables
      await this.seatPlayers();

      // Step 5: Update tournament status to RUNNING
      await this.setTournamentRunning();

      // Step 6: Start dealing on each table
      for (const table of this.tables) {
        try {
          await table.engine.start();
        } catch (err: unknown) {
          console.error(
            `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to start table engine ${table.tableId.slice(0, 8)}:`,
            err
          );
        }
      }

      // Step 7: Start blind level timer
      this.startBlindTimer();

      // Step 8: Start elimination checker
      this.startEliminationChecker();
    } catch (err: unknown) {
      console.error(`[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to start:`, err);
      this.running = false;
      throw err;
    }
  }

  stop(): void {
    this.running = false;
    if (this.blindCheckInterval) clearInterval(this.blindCheckInterval);
    if (this.eliminationCheckInterval) clearInterval(this.eliminationCheckInterval);
    // Cancel any pending add-on period timeout
    if (this.addOnAbortController) {
      this.addOnAbortController.abort();
      this.addOnAbortController = null;
    }
    for (const table of this.tables) {
      table.engine.stop();
    }
  }

  isRunning(): boolean {
    return this.running;
  }
  getHandCount(): number {
    return this.handsDealt;
  }
  getPlayerCount(): number {
    return Array.from(this.players.values()).filter((p) => p.status === 'playing').length;
  }
  getTableCount(): number {
    return this.tables.length;
  }
  getCurrentLevel(): number {
    return this.currentLevel;
  }
  getTournamentName(): string {
    return this.tournamentInfo?.name || 'Unknown';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESUME: Pick up an already-RUNNING tournament
  // ═══════════════════════════════════════════════════════════════════════════

  private async resumeRunning(): Promise<void> {
    // Step 1: Load tournament info
    await this.loadTournament();
    if (!this.tournamentInfo) throw new Error('Failed to load tournament');

    // Step 2: Load existing players from tournament_players
    const { data: existingPlayers } = await this.supabase
      .from('tournament_players')
      .select('user_id, chips, status, username')
      .eq('tournament_id', this.tournamentId);

    if (existingPlayers) {
      for (const p of existingPlayers) {
        this.players.set(p.user_id, {
          user_id: p.user_id,
          username: p.username || p.user_id.slice(0, 8),
          chips: p.chips || this.tournamentInfo.starting_chips,
          status: p.status || 'playing',
        });
      }
    }

    const activePlayers = Array.from(this.players.values()).filter((p) => p.status === 'playing');
    // If no active players left, mark as COMPLETED
    if (activePlayers.length === 0) {
      await this.supabase
        .from('tournaments')
        .update({ status: 'COMPLETED', ended_at: new Date().toISOString() })
        .eq('id', this.tournamentId);
      this.running = false;
      return;
    }

    // Step 3: Find existing tournament tables
    const { data: existingTables } = await this.supabase
      .from('tables')
      .select('id, name, current_players')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'RUNNING');

    if (!existingTables || existingTables.length === 0) {
      // No tables exist — need to create them and seat players
      await this.createTournamentTables();
      await this.seatPlayers();
    } else {
      // Tables exist — attach engines
      for (const t of existingTables) {
        const engine = new HeadlessTableEngine(t.id, this.supabase);
        engine.onHandComplete((tId, players) => this.syncChipsAfterHand(tId, players));
        this.tables.push({
          tableId: t.id,
          engine,
          playerCount: t.current_players || 0,
        });
      }
      // Check if tables have seats — if not, seat players
      const { data: anySeats } = await this.supabase
        .from('table_seats')
        .select('id')
        .eq('table_id', existingTables[0].id)
        .limit(1);

      if (!anySeats || anySeats.length === 0) {
        await this.seatPlayers();
      }
    }

    // Step 4: Restore blind level
    // DB stores 1-indexed level numbers, but internal tracking is 0-indexed array position
    const dbLevel = this.tournamentInfo.current_level || 1;
    this.currentLevel = Math.max(0, dbLevel - 1);

    // Step 5: Start dealing on each table
    for (const table of this.tables) {
      try {
        await table.engine.start();
      } catch (err: unknown) {
        console.error(
          `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to start table engine ${table.tableId.slice(0, 8)}:`,
          err
        );
      }
    }

    // Step 6: Start blind level timer
    this.startBlindTimer();

    // Step 7: Start elimination checker
    this.startEliminationChecker();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: LOAD TOURNAMENT
  // ═══════════════════════════════════════════════════════════════════════════

  private async loadTournament(): Promise<void> {
    const { data, error } = await this.supabase
      .from('tournaments')
      .select('*')
      .eq('id', this.tournamentId)
      .maybeSingle();

    if (error || !data) {
      throw new Error(`Failed to load tournament: ${error?.message}`);
    }

    const blinds = resolveBlindStructure(data.blind_structure);
    const playerCount = data.current_players || 0;
    const payouts = resolvePayoutStructure(data.payout_structure, playerCount);

    this.tournamentInfo = {
      id: data.id,
      name: data.name,
      club_id: data.club_id,
      game_type: data.game_type || 'NLH',
      buy_in_amount: data.buy_in_amount || 0,
      starting_chips: data.starting_chips || 0,
      max_players: data.max_players || 0,
      current_players: playerCount,
      prize_pool: data.prize_pool || playerCount * (data.buy_in_amount || 0),
      blind_structure: blinds,
      payout_structure: payouts,
      started_at: data.started_at || '',
      current_level: data.current_level || 1,
      // Tournament type/variant for Spin & Bounty detection
      variant: data.variant || 'freezeout',
      tournament_type: data.tournament_type || 'MTT',
      buy_in_fee: data.buy_in_fee || 0,
      // Late reg / rebuy / add-on (level-based)
      late_reg_levels: data.late_reg_levels || data.late_reg_mins || 0,
      late_reg_mins: data.late_reg_mins || 0,
      add_on_available: data.add_on_available || false,
      rebuy_levels: data.rebuy_levels || 0,
      is_reentry: data.is_reentry || false,
      prize_pool_finalized: data.prize_pool_finalized || false,
      addon_cost: data.addon_cost || data.buy_in_amount || 0,
      addon_chips: data.addon_chips || data.starting_chips || 0,
      addon_levels: data.addon_levels || 1,
      // Bounty fields
      is_bounty: data.is_bounty || false,
      is_pko: data.is_pko || false,
      is_mystery_bounty: data.is_mystery_bounty || false,
      bounty_amount: data.bounty_amount || 0,
      // Satellite fields
      satellite_target: data.satellite_target || null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: MIGRATE REGISTRATIONS → TOURNAMENT_PLAYERS
  // ═══════════════════════════════════════════════════════════════════════════

  private async migrateRegistrations(): Promise<void> {
    if (!this.tournamentInfo) return;

    // Check if tournament_players already has entries for this tournament
    const { data: existingPlayers } = await this.supabase
      .from('tournament_players')
      .select('user_id')
      .eq('tournament_id', this.tournamentId);

    if (existingPlayers && existingPlayers.length > 0) {
      // Activate any 'registered' players to 'playing' (they haven't been seated yet)
      await this.supabase
        .from('tournament_players')
        .update({ status: 'playing', chips: this.tournamentInfo.starting_chips })
        .eq('tournament_id', this.tournamentId)
        .eq('status', 'registered');

      // Load all players with updated status
      const { data: fullPlayers } = await this.supabase
        .from('tournament_players')
        .select('user_id, chips, status, username')
        .eq('tournament_id', this.tournamentId);
      if (fullPlayers) {
        for (const p of fullPlayers) {
          this.players.set(p.user_id, {
            user_id: p.user_id,
            username: p.username || p.user_id.slice(0, 8),
            chips: p.chips || this.tournamentInfo.starting_chips,
            status: p.status || 'playing',
          });
        }
      }

      // Update prize pool
      const activeCount = Array.from(this.players.values()).filter(
        (p) => p.status === 'playing'
      ).length;
      // Use DB prize pool if available (includes rebuys/addons), otherwise calculate from entries
      const dbPrizePool = this.tournamentInfo.prize_pool;
      const actualPrizePool =
        dbPrizePool > 0 ? dbPrizePool : activeCount * this.tournamentInfo.buy_in_amount;
      this.tournamentInfo.prize_pool = actualPrizePool;
      this.tournamentInfo.current_players = existingPlayers.length;

      await this.supabase
        .from('tournaments')
        .update({ prize_pool: actualPrizePool, current_players: existingPlayers.length })
        .eq('id', this.tournamentId);
      return;
    }

    // Load registered players from tournament_players (inserted by TournamentService.registerPlayer)
    const { data: registrations, error } = await this.supabase
      .from('tournament_players')
      .select('user_id, username, chips, status')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'registered');

    if (error || !registrations || registrations.length === 0) {
      // No registrations — mark tournament as COMPLETED and bail
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] No registrations found — marking COMPLETED`
      );
      await this.supabase
        .from('tournaments')
        .update({ status: 'COMPLETED', current_players: 0 })
        .eq('id', this.tournamentId);
      throw new Error(`No registrations found for tournament ${this.tournamentId}`);
    }

    // Need at least 2 players for a tournament
    if (registrations.length < 2) {
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Only ${registrations.length} registration — marking COMPLETED`
      );
      await this.supabase
        .from('tournaments')
        .update({ status: 'COMPLETED', current_players: registrations.length })
        .eq('id', this.tournamentId);
      throw new Error(
        `Not enough players (${registrations.length}) for tournament ${this.tournamentId}`
      );
    }
    // Update tournament_players status to 'playing' and set starting chips
    const { error: updateError } = await this.supabase
      .from('tournament_players')
      .update({ status: 'playing', chips: this.tournamentInfo!.starting_chips })
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'registered');

    if (updateError) {
      console.error(`[TournamentEngine] Player activation error:`, updateError.message);
      throw new Error(`Failed to activate players: ${updateError.message}`);
    }

    // Populate local player map (buy-ins already deducted during registration by TournamentService.registerPlayer)
    for (const r of registrations) {
      this.players.set(r.user_id, {
        user_id: r.user_id,
        username: r.username || r.user_id.slice(0, 8),
        chips: this.tournamentInfo.starting_chips,
        status: 'playing',
      });
    }

    // Calculate initial prize pool from registrations (rebuys/addons added later by TournamentService)
    const existingPool = this.tournamentInfo.prize_pool;
    const actualPrizePool =
      existingPool > 0 ? existingPool : registrations.length * this.tournamentInfo.buy_in_amount;
    this.tournamentInfo.prize_pool = actualPrizePool;
    this.tournamentInfo.current_players = registrations.length;

    await this.supabase
      .from('tournaments')
      .update({
        prize_pool: actualPrizePool,
        current_players: registrations.length,
      })
      .eq('id', this.tournamentId);
  }

  private getTableCapacity(): number {
    if (!this.tournamentInfo) return 9;
    const type = this.tournamentInfo.tournament_type?.toUpperCase();
    const variant = this.tournamentInfo.variant?.toLowerCase();
    const mp = this.tournamentInfo.max_players;

    // Explicit 2-max / Heads Up (variant='hu' OR max_players=2)
    if (variant === 'hu' || mp === 2) return 2;
    // Explicit 3-max / Spin & Go
    if (type === 'SPIN' || variant === 'spin') return 3;
    // SNG: use max_players directly as table capacity (2, 3, 6, or 9)
    if (type === 'SNG' && mp && mp >= 2 && mp <= 9) return mp;

    // Otherwise standard 9-max table
    return 9;
  }

  private getMinPlayers(): number {
    if (!this.tournamentInfo) return 2;
    const type = this.tournamentInfo.tournament_type?.toUpperCase();
    const variant = this.tournamentInfo.variant?.toLowerCase();
    // Spin & Go requires exactly 3
    if (type === 'SPIN' || variant === 'spin') return 3;
    // Heads-up requires exactly 2
    if (variant === 'hu' || this.tournamentInfo.max_players === 2) return 2;
    // SNGs: use min_players or 2
    if (type === 'SNG') return 2;
    // MTT: minimum 2 players
    return 2;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: CREATE TOURNAMENT TABLES
  // ═══════════════════════════════════════════════════════════════════════════

  private async createTournamentTables(): Promise<void> {
    if (!this.tournamentInfo) return;

    const capacity = this.getTableCapacity();
    const activePlayers = Array.from(this.players.values()).filter((p) => p.status === 'playing');
    const numTables = Math.max(1, Math.ceil(activePlayers.length / capacity));
    const firstBlinds = this.tournamentInfo.blind_structure[0] || {
      smallBlind: 10,
      bigBlind: 20,
      ante: 0,
    };
    // Map game_type to game_variant
    const gameVariant = this.mapGameVariant(this.tournamentInfo.game_type);

    for (let i = 0; i < numTables; i++) {
      const tableRow = {
        club_id: this.tournamentInfo.club_id,
        tournament_id: this.tournamentId,
        name: `${this.tournamentInfo.name} — Table ${i + 1}`,
        game_type: 'tournament',
        game_variant: gameVariant,
        stakes: 'Tournament',
        small_blind: firstBlinds.smallBlind,
        big_blind: firstBlinds.bigBlind,
        ante: firstBlinds.ante || 0,
        max_players: capacity,
        current_players: 0,
        status: 'RUNNING',
      };

      const { data, error } = await this.supabase
        .from('tables')
        .insert(tableRow)
        .select('id')
        .maybeSingle();

      if (error || !data) {
        console.error(`[TournamentEngine] Failed to create table ${i + 1}:`, error?.message);
        continue;
      }

      const engine = new HeadlessTableEngine(data.id, this.supabase);
      engine.onHandComplete((tId, players) => this.syncChipsAfterHand(tId, players));
      this.tables.push({
        tableId: data.id,
        engine,
        playerCount: 0,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: SEAT PLAYERS AT TABLES
  // ═══════════════════════════════════════════════════════════════════════════

  private async seatPlayers(): Promise<void> {
    if (!this.tournamentInfo) return;

    const activePlayers = Array.from(this.players.values()).filter((p) => p.status === 'playing');
    if (activePlayers.length === 0) {
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] No active players to seat!`
      );
      return;
    }

    // Fisher-Yates shuffle
    for (let i = activePlayers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [activePlayers[i], activePlayers[j]] = [activePlayers[j], activePlayers[i]];
    }

    // Distribute round-robin across tables
    if (this.tables.length === 0) {
      console.error(
        `[TournamentEngine:${this.tournamentId}] No tables created — cannot seat players`
      );
      return;
    }
    const seatInserts: Array<Record<string, unknown>> = [];
    for (let i = 0; i < activePlayers.length; i++) {
      const tableIdx = i % this.tables.length;
      const table = this.tables[tableIdx];
      const seatNumber = Math.floor(i / this.tables.length) + 1;

      activePlayers[i].tableId = table.tableId;
      activePlayers[i].seatNumber = seatNumber;
      table.playerCount++;

      seatInserts.push({
        table_id: table.tableId,
        seat_number: seatNumber,
        user_id: activePlayers[i].user_id,
        stack: activePlayers[i].chips,
        is_sitting_out: false,
        // Note: horse_id omitted — tournament players are registered users, not horses
        // The horse_id FK constraint would reject non-horse user_ids
      });
    }

    // Batch insert all seats
    const { error } = await this.supabase.from('table_seats').insert(seatInserts);

    if (error) {
      console.error(`[TournamentEngine] Failed to seat players:`, error.message);
      throw new Error(`Seating failed: ${error.message}`);
    }

    // Update tournament_players.table_id for each seated player so the UI can show "Enter Table"
    for (const player of activePlayers) {
      if (player.tableId) {
        await this.supabase
          .from('tournament_players')
          .update({ table_id: player.tableId })
          .eq('tournament_id', this.tournamentId)
          .eq('user_id', player.user_id);
      }
    }

    // Update tables.current_players in DB so checkTableMerge/balancing reads correct counts
    for (const table of this.tables) {
      await this.supabase
        .from('tables')
        .update({ current_players: table.playerCount })
        .eq('id', table.tableId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: SET TOURNAMENT RUNNING
  // ═══════════════════════════════════════════════════════════════════════════

  private async setTournamentRunning(): Promise<void> {
    const now = new Date().toISOString();
    this.tournamentInfo!.started_at = now;

    const { error } = await this.supabase
      .from('tournaments')
      .update({
        status: 'RUNNING',
        started_at: now,
        current_level: 1,
      })
      .eq('id', this.tournamentId);

    if (error) {
      console.error(`[TournamentEngine] Failed to update tournament status:`, error.message);
    }

    // Update all tournament_players to 'playing'
    await this.supabase
      .from('tournament_players')
      .update({ status: 'playing', chips: this.tournamentInfo!.starting_chips })
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'registered');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BLIND LEVEL TIMER
  // ═══════════════════════════════════════════════════════════════════════════

  private startBlindTimer(): void {
    if (!this.tournamentInfo) return;

    this.currentLevel = 0;

    // Check blind levels every 30 seconds
    this.blindCheckInterval = setInterval(() => {
      this.checkBlindLevel();
    }, 30_000);

    // Initial check
    this.checkBlindLevel();
  }

  private checkBlindLevel(): void {
    if (!this.tournamentInfo || !this.running) return;

    const blinds = this.tournamentInfo.blind_structure;
    const startedAt = new Date(this.tournamentInfo.started_at).getTime();
    const elapsed = Date.now() - startedAt;
    const elapsedMinutes = elapsed / 60_000;

    // Find current level based on elapsed time
    let accumulated = 0;
    let newLevel = blinds.length - 1; // Default to last level (cap)
    for (let i = 0; i < blinds.length; i++) {
      accumulated += blinds[i].durationMinutes;
      if (elapsedMinutes < accumulated) {
        newLevel = i;
        break;
      }
    }

    if (newLevel !== this.currentLevel) {
      const prevLevel = this.currentLevel;
      this.currentLevel = newLevel;
      const level = blinds[newLevel];

      // Handle break levels — pause dealing and broadcast break event
      if (level.isBreak) {
        // During a break, pause all table engines
        for (const table of this.tables) {
          if (table.engine.setHandForHand) table.engine.setHandForHand(true);
        }
        // Broadcast TOURNAMENT_BREAK event
        masterBus.emit('TOURNAMENT_BREAK', {
          tournamentId: this.tournamentId,
          level: newLevel + 1,
          durationMinutes: level.durationMinutes || 5,
        });
        // Don't update table blinds during break — keep previous level's blinds
        // Also persist the current level in DB
        this.supabase
          .from('tournaments')
          .update({ current_level: level.level })
          .eq('id', this.tournamentId)
          .then(() => {});
        return;
      }

      // If previous level was a break, resume all table engines
      if (prevLevel >= 0 && prevLevel < blinds.length && blinds[prevLevel]?.isBreak) {
        for (const table of this.tables) {
          if (table.engine.setHandForHand) table.engine.setHandForHand(false);
          if (table.engine.releaseHandForHand) table.engine.releaseHandForHand();
        }
        masterBus.emit('TOURNAMENT_BREAK_END', {
          tournamentId: this.tournamentId,
        });
      }

      // Update all tournament tables with new blinds
      this.updateTableBlinds(level);

      // Notify listeners about the level change
      masterBus.emit('BLIND_LEVEL_CHANGE', {
        tournamentId: this.tournamentId,
        level: newLevel + 1,
        smallBlind: level.smallBlind,
        bigBlind: level.bigBlind,
        ante: level.ante || 0,
      });
      masterBus.emit('TOURNAMENT_LEVEL_CHANGE', {
        tournamentId: this.tournamentId,
        level: newLevel + 1,
        smallBlind: level.smallBlind,
        bigBlind: level.bigBlind,
      });

      // Execute chip race: remove obsolete small denomination chips
      if (newLevel > 0 && this.tournamentInfo.blind_structure[prevLevel]) {
        const prevBlind = this.tournamentInfo.blind_structure[prevLevel];
        const oldSmallest = prevBlind.smallBlind;
        const newSmallest = level.smallBlind;
        // Only race if the smallest denomination actually increased
        if (newSmallest > oldSmallest && this.players.size > 0) {
          const playerStacks = new Map<string, number>();
          for (const [pid, pdata] of this.players) {
            playerStacks.set(pid, pdata.chips);
          }
          const raceResult = chipRaceEngine.executeChipRace(
            this.tournamentId,
            playerStacks,
            oldSmallest,
            newSmallest
          );
          // Sync adjusted stacks back to player records
          for (const [pid, newStack] of playerStacks) {
            const player = this.players.get(pid);
            if (player) player.chips = newStack;
          }
        }
      }

      // ── ADD-ON PERIOD TRIGGER ──
      // When we advance past the rebuy_levels threshold and add-on is available,
      // pause the tournament for 60 seconds and broadcast ADDON_PERIOD_START
      if (this.tournamentInfo.add_on_available && !this.addOnPeriodTriggered) {
        const rebuyLevelCap =
          this.tournamentInfo.late_reg_levels ?? this.tournamentInfo.rebuy_levels ?? 8;
        // Trigger when we pass from within rebuy period to beyond it
        if (prevLevel < rebuyLevelCap && newLevel >= rebuyLevelCap) {
          this.triggerAddOnPeriod();
        }
      }
    }
  }

  private async updateTableBlinds(level: BlindLevel): Promise<void> {
    for (const table of this.tables) {
      const { error } = await this.supabase
        .from('tables')
        .update({
          small_blind: level.smallBlind,
          big_blind: level.bigBlind,
          ante: level.ante,
        })
        .eq('id', table.tableId);

      if (error) {
        console.error(
          `[TournamentEngine] Failed to update blinds for table ${table.tableId.slice(0, 8)}:`,
          error.message
        );
      }
    }

    // Also update tournament current_level
    await this.supabase
      .from('tournaments')
      .update({ current_level: level.level })
      .eq('id', this.tournamentId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADD-ON PERIOD (60 seconds after rebuy levels end)
  // ═══════════════════════════════════════════════════════════════════════════

  private async triggerAddOnPeriod(): Promise<void> {
    if (!this.tournamentInfo || this.addOnPeriodTriggered) return;

    this.addOnPeriodTriggered = true;
    this.addOnPeriodActive = true;

    const addonCost = this.tournamentInfo.addon_cost || this.tournamentInfo.buy_in_amount;
    const addonChips = this.tournamentInfo.addon_chips || this.tournamentInfo.starting_chips;
    // Pause all table engines during add-on period
    for (const table of this.tables) {
      if (table.engine.setHandForHand) table.engine.setHandForHand(true);
    }

    // Broadcast ADDON_PERIOD_START to all tables via tournament channel
    try {
      const { realtimeChannelService } = await import('../services/RealtimeChannelService');
      await realtimeChannelService.broadcastTournamentEvent(this.tournamentId, {
        type: 'ADDON_PERIOD_START' as any,
        payload: {
          addOnCost: addonCost,
          addOnChips: addonChips,
          durationSeconds: 60,
        },
      });
    } catch (e: unknown) {
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to broadcast addon period:`,
        e
      );
    }

    // Also broadcast on the addon-specific channel for direct table pickup
    try {
      const chan = this.supabase.channel(`t-addon-${this.tournamentId}`);
      await chan.subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error(`[TournamentEngine] ❌ Addon channel error:`, err?.message || err);
        }
      });
      await chan.send({
        type: 'broadcast',
        event: 'addon_event',
        payload: {
          type: 'ADDON_PERIOD_START',
          addOnCost: addonCost,
          addOnChips: addonChips,
          durationSeconds: 60,
        },
      });
      // Clean up after a brief delay to ensure delivery
      setTimeout(async () => {
        try {
          await chan.unsubscribe();
          this.supabase.removeChannel(chan);
        } catch {
          /* best effort */
        }
      }, 3000);
    } catch (e: unknown) {
      /* noop */
    }

    // Wait 60 seconds for all players to accept/decline (cancellable via AbortController)
    this.addOnAbortController = new AbortController();
    const abortSignal = this.addOnAbortController.signal;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 60_000);
      // If abort() is called (e.g., stop()), resolve immediately and clear the timer
      abortSignal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });

    this.addOnAbortController = null;

    // If the engine was stopped during the add-on period, bail out silently
    if (!this.running) return;

    // Add-on period ended — resume tournament
    this.addOnPeriodActive = false;
    // Release all table engines
    for (const table of this.tables) {
      if (table.engine.setHandForHand) table.engine.setHandForHand(false);
      if (table.engine.releaseHandForHand) table.engine.releaseHandForHand();
    }

    // Finalize prize pool after add-on period
    try {
      const { tournamentService } = await import('../services/TournamentService');
      await tournamentService.finalizePrizePool(this.tournamentId);
      if (this.tournamentInfo) this.tournamentInfo.prize_pool_finalized = true;
    } catch (e: unknown) {
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to finalize after addon:`,
        e
      );
    }

    // Broadcast ADDON_PERIOD_END
    try {
      const { realtimeChannelService } = await import('../services/RealtimeChannelService');
      await realtimeChannelService.broadcastTournamentEvent(this.tournamentId, {
        type: 'ADDON_PERIOD_END' as any,
        payload: {},
      });
    } catch (e: unknown) {
      /* noop */
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ELIMINATION CHECKER
  // ═══════════════════════════════════════════════════════════════════════════

  private startEliminationChecker(): void {
    // Check for busted players every 5 seconds
    this.eliminationCheckInterval = setInterval(() => {
      this.checkEliminations();
    }, 5_000);
  }

  private eliminationCheckRunning = false;
  private prizePoolRefreshCounter = 0;
  private async checkEliminations(): Promise<void> {
    if (!this.running || !this.tournamentInfo) return;
    // Prevent overlapping elimination checks (async race condition guard)
    if (this.eliminationCheckRunning) return;
    this.eliminationCheckRunning = true;
    try {
      // Refresh prize pool from DB every ~30s (6 ticks × 5s) to catch late reg additions
      this.prizePoolRefreshCounter++;
      if (this.prizePoolRefreshCounter % 6 === 0) {
        const { data: freshT } = await this.supabase
          .from('tournaments')
          .select('prize_pool, current_players, prize_pool_finalized')
          .eq('id', this.tournamentId)
          .maybeSingle();
        if (freshT && freshT.prize_pool !== this.tournamentInfo.prize_pool) {
          this.tournamentInfo.prize_pool = freshT.prize_pool;
          this.tournamentInfo.current_players = freshT.current_players;
        }
        if (freshT) {
          this.tournamentInfo.prize_pool_finalized = freshT.prize_pool_finalized || false;
        }

        // Check if late reg period has ended (level-based) — finalize prize pool if not yet done
        const lateRegLevelCap =
          this.tournamentInfo.late_reg_levels || this.tournamentInfo.late_reg_mins || 0;
        if (!this.tournamentInfo.prize_pool_finalized && lateRegLevelCap > 0) {
          const currentLevel = this.tournamentInfo.current_level || 0;
          if (currentLevel >= lateRegLevelCap) {
            try {
              const { tournamentService } = await import('../services/TournamentService');
              await tournamentService.finalizePrizePool(this.tournamentId);
              this.tournamentInfo.prize_pool_finalized = true;
            } catch (e: unknown) {
              console.error(
                `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to finalize prize pool:`,
                e
              );
            }
          }
        }
      }

      // Check each tournament table for players with 0 chips
      for (const table of this.tables) {
        const { data: seats } = await this.supabase
          .from('table_seats')
          .select('user_id, stack')
          .eq('table_id', table.tableId)
          .is('left_at', null);

        if (!seats) continue;

        // Get last hand winners for bounty knockout attribution
        const lastWinners = table.engine.getLastHandWinnerIds
          ? table.engine.getLastHandWinnerIds()
          : [];
        const knockerId = lastWinners.length > 0 ? lastWinners[0] : undefined;

        const eliminationPromises: Promise<void>[] = [];
        for (const seat of seats) {
          if (seat.stack <= 0) {
            // Pass the knocker ID (winner of last hand) for bounty crediting
            eliminationPromises.push(
              this.eliminatePlayer(
                seat.user_id,
                table.tableId,
                knockerId !== seat.user_id ? knockerId : undefined
              )
            );
          }
        }

        if (eliminationPromises.length > 0) {
          await Promise.allSettled(eliminationPromises);
        }

        // Update local table player count
        const activeSeats = seats.filter((s) => s.stack > 0);
        table.playerCount = activeSeats.length;
      }

      // Automatically seat alternates if tables have room
      await this.seatAlternates();

      // Update hand count
      this.handsDealt = this.tables.reduce((sum, t) => sum + t.engine.getHandCount(), 0);

      // Check if tournament is over
      const remainingPlayers = Array.from(this.players.values()).filter(
        (p) => p.status === 'playing'
      );
      if (remainingPlayers.length <= 1) {
        await this.finishTournament(remainingPlayers[0]);
      }

      // Check if any tables need to be merged (< 3 players)
      await this.checkTableBalance();

      // ── HAND-FOR-HAND BUBBLE MODE ──
      // Applies to multi-table tournaments only (not Spin/SNG single-table)
      if (this.tournamentInfo && this.tables.length > 1) {
        const isSpin =
          this.tournamentInfo.variant === 'spin' || this.tournamentInfo.tournament_type === 'SPIN';
        if (!isSpin) {
          const payoutCount = this.tournamentInfo.payout_structure?.length || 0;
          const playingNow = Array.from(this.players.values()).filter(
            (p) => p.status === 'playing'
          ).length;

          if (payoutCount > 0 && playingNow === payoutCount + 1 && !this.handForHandActive) {
            // Entering the money bubble — activate hand-for-hand
            this.handForHandActive = true;
            if (!this.handForHandAnnounced) {
              this.handForHandAnnounced = true;
              // Broadcast bubble event
              try {
                const { realtimeChannelService } =
                  await import('../services/RealtimeChannelService');
                await realtimeChannelService.broadcastTournamentEvent(this.tournamentId, {
                  type: 'hand_for_hand',
                  payload: {
                    active: true,
                    playersRemaining: playingNow,
                    paidPositions: payoutCount,
                  },
                });
              } catch (e: unknown) {
                /* noop */
              }
            }
            // Enable hand-for-hand sync on all table engines
            for (const table of this.tables) {
              if (table.engine.setHandForHand) table.engine.setHandForHand(true);
            }
          } else if (this.handForHandActive && playingNow === payoutCount + 1) {
            // Still on bubble — release all tables to deal next synchronized hand
            for (const table of this.tables) {
              if (table.engine.releaseHandForHand) table.engine.releaseHandForHand();
            }
          } else if (this.handForHandActive && playingNow <= payoutCount) {
            // Bubble burst — someone busted, now in the money
            this.handForHandActive = false;
            // Disable hand-for-hand on all table engines
            for (const table of this.tables) {
              if (table.engine.setHandForHand) table.engine.setHandForHand(false);
            }
            try {
              const { realtimeChannelService } = await import('../services/RealtimeChannelService');
              await realtimeChannelService.broadcastTournamentEvent(this.tournamentId, {
                type: 'hand_for_hand',
                payload: { active: false, playersRemaining: playingNow, bubbleBurst: true },
              });
            } catch (e: unknown) {
              /* noop */
            }
          }
        }
      }
    } finally {
      this.eliminationCheckRunning = false;
    }
  }

  /**
   * Automatically scoops up any 'registered' players from the Alternate List
   * and drops them into open table seats when full tables free up space.
   */
  private async seatAlternates(): Promise<void> {
    if (!this.running || !this.tournamentInfo || this.tables.length === 0) return;

    const capacity = this.getTableCapacity();

    // Fetch players waiting on the alternate list (status = 'registered')
    // Oldest first to be fair
    const { data: waitlist } = await this.supabase
      .from('tournament_players')
      .select('user_id, username')
      .eq('tournament_id', this.tournamentId)
      .eq('status', 'registered')
      .order('created_at', { ascending: true });

    if (!waitlist || waitlist.length === 0) return;

    // We have players waiting. Find open seats at active tables.
    for (const player of waitlist) {
      if (!this.running) break;

      // Find an open table using dynamic capacity for this tournament variant
      const openTable = this.tables.find((t) => t.playerCount < capacity);
      if (!openTable) break; // All tables are full again, must wait for next elimination.

      try {
        // Find an empty seat number
        const { data: existingSeats } = await this.supabase
          .from('table_seats')
          .select('seat_number')
          .eq('table_id', openTable.tableId)
          .is('left_at', null);

        const takenSeats = new Set((existingSeats || []).map((s) => s.seat_number));
        let seatNumber = 1;
        while (takenSeats.has(seatNumber) && seatNumber <= capacity) seatNumber++;

        // Guard: Mismatch between local playerCount and db state
        if (seatNumber > capacity) {
          openTable.playerCount = capacity; // Corect local cache
          continue;
        }

        // 1. ATOMIC CAS CLAIM: Secure the player before physically seating them
        // This Compare-And-Swap prevents a race condition where the player unregisters simultaneously
        const { data: claimedRows, error: claimErr } = await this.supabase
          .from('tournament_players')
          .update({
            status: 'playing',
            chips: this.tournamentInfo.starting_chips,
            table_id: openTable.tableId,
          })
          .eq('tournament_id', this.tournamentId)
          .eq('user_id', player.user_id)
          .eq('status', 'registered') // CRITICAL: Only claim if they are STILL registered
          .select('id');

        if (claimErr || !claimedRows || claimedRows.length === 0) {
          console.error(
            `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Alternate ${player.username} unregister race condition prevented. Skipping seating.`
          );
          continue;
        }
        // 2. Safely Insert seat now that we own the state transition
        const { error: seatErr } = await this.supabase.from('table_seats').insert({
          table_id: openTable.tableId,
          user_id: player.user_id,
          seat_number: seatNumber,
          stack: this.tournamentInfo.starting_chips,
        });

        if (seatErr) {
          console.error(
            `[TournamentEngine] Failed to insert seat for alternate ${player.username}:`,
            seatErr
          );

          // Rollback claim if physical seat insert failed
          await this.supabase
            .from('tournament_players')
            .update({ status: 'registered', chips: 0, table_id: null })
            .eq('tournament_id', this.tournamentId)
            .eq('user_id', player.user_id);
        } else {
          // Update local maps
          openTable.playerCount++;
          this.players.set(player.user_id, {
            user_id: player.user_id,
            username: player.username || player.user_id.slice(0, 8),
            chips: this.tournamentInfo.starting_chips,
            status: 'playing',
            tableId: openTable.tableId,
            seatNumber,
          });

          // Sync tables.current_players in DB
          await this.supabase
            .from('tables')
            .update({ current_players: openTable.playerCount })
            .eq('id', openTable.tableId);
        }
      } catch (err: unknown) {
        console.error(`[TournamentEngine] Failed to seat alternate ${player.user_id}:`, err);
      }
    }
  }

  /**
   * Real-time chip sync — called by HeadlessTableEngine callback the instant a hand completes.
   * Updates tournament_players.chips in the DB so lobby/table pages reflect live stacks.
   */
  private async syncChipsAfterHand(
    tableId: string,
    playerStacks: { user_id: string; stack: number }[]
  ): Promise<void> {
    if (!this.running || !this.tournamentInfo) return;

    // Update local player map + batch DB updates
    const upsertPayload: Array<Record<string, unknown>> = [];

    for (const { user_id, stack } of playerStacks) {
      const player = this.players.get(user_id);
      if (player && player.status === 'playing') {
        player.chips = stack;
        // tournament_players.chips is INTEGER — truncate to whole number (never round up)
        const rounded = Math.trunc(stack);

        // Build payload with unique key + fields to update
        upsertPayload.push({
          tournament_id: this.tournamentId,
          user_id: user_id,
          chips: rounded,
        });
      }
    }

    // Fire 1 bulk update for true batching instead of N parallel HTTP requests
    if (upsertPayload.length > 0) {
      const { error } = await this.supabase.from('tournament_players').upsert(
        upsertPayload.map((p) => ({ ...p, status: 'playing' })), // ensure required fields don't accidentally blank
        { onConflict: 'tournament_id,user_id', ignoreDuplicates: false }
      );

      if (error) {
        console.error(
          `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Bulk chip sync failed: ${error.message}`
        );
      }
    }

    // Update hand count
    this.handsDealt = this.tables.reduce((sum, t) => sum + t.engine.getHandCount(), 0);
  }

  private async eliminatePlayer(
    userId: string,
    tableId: string,
    knockerId?: string
  ): Promise<void> {
    const player = this.players.get(userId);
    if (!player || player.status === 'eliminated') return;

    const remainingBefore = Array.from(this.players.values()).filter(
      (p) => p.status === 'playing'
    ).length;
    const position = remainingBefore; // e.g., if 10 playing, eliminated player gets 10th place

    player.status = 'eliminated';

    // Calculate prize
    const prize = this.calculatePrize(position);
    // Update tournament_players
    const { error: elimErr } = await this.supabase
      .from('tournament_players')
      .update({
        status: 'eliminated',
        position: position,
        prize: prize,
        chips: 0,
        eliminated_at: new Date().toISOString(),
      })
      .eq('tournament_id', this.tournamentId)
      .eq('user_id', userId);
    if (elimErr)
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to mark player ${userId.slice(0, 8)} as eliminated:`,
        elimErr
      );

    // Remove from table_seats
    const { error: seatErr } = await this.supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .eq('table_id', tableId)
      .eq('user_id', userId)
      .is('left_at', null);
    if (seatErr)
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to vacate seat for ${userId.slice(0, 8)}:`,
        seatErr
      );

    // Decrement tables.current_players and local playerCount
    const table = this.tables.find((t) => t.tableId === tableId);
    if (table) {
      table.playerCount = Math.max(0, table.playerCount - 1);
      const { error: countErr } = await this.supabase
        .from('tables')
        .update({ current_players: table.playerCount })
        .eq('id', tableId);
      if (countErr)
        console.error(
          `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to update table player count:`,
          countErr
        );
    }

    // Credit prize to player wallet (if any)
    if (prize > 0) {
      await this.creditPrize(userId, prize);
    }

    // Emit bus event for immediate cross-page updates
    try {
      masterBus.emit('PLAYER_ELIMINATED', {
        tournamentId: this.tournamentId,
        userId,
        position,
        prize,
        username: player.username,
      });
    } catch {
      /* bus not initialized yet */
    }

    // Handle bounty crediting if this is a bounty tournament and we know the knocker
    if (
      knockerId &&
      this.tournamentInfo &&
      (this.tournamentInfo.is_bounty ||
        this.tournamentInfo.is_pko ||
        this.tournamentInfo.is_mystery_bounty)
    ) {
      try {
        const { tournamentService } = await import('../services/TournamentService');
        const bountyResult = await tournamentService.collectBounty(
          this.tournamentId,
          userId,
          knockerId
        );

        if (bountyResult.bountyAmount > 0) {
          // Credit bounty winnings to knocker's wallet
          await this.creditPrize(knockerId, bountyResult.bountyAmount);

          // Update knocker's bounty stats — manual update (no RPC needed)
          try {
            const { data: knockerStats } = await this.supabase
              .from('tournament_players')
              .select('bounties_collected, bounty_winnings')
              .eq('tournament_id', this.tournamentId)
              .eq('user_id', knockerId)
              .maybeSingle();

            if (knockerStats) {
              const { error: updateErr } = await this.supabase
                .from('tournament_players')
                .update({
                  bounties_collected: (knockerStats.bounties_collected || 0) + 1,
                  bounty_winnings:
                    Math.trunc(
                      ((knockerStats.bounty_winnings || 0) + bountyResult.bountyAmount) * 100
                    ) / 100,
                })
                .eq('tournament_id', this.tournamentId)
                .eq('user_id', knockerId);

              if (updateErr) {
                console.error(
                  `[TournamentEngine] Failed to update bounty stats for ${knockerId.slice(0, 8)}:`,
                  updateErr
                );
              }
            }
          } catch (statsErr) {
            console.error(`[TournamentEngine] Bounty stats update failed:`, statsErr);
          }
        }
      } catch (err: unknown) {
        console.error(
          `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Bounty collection failed:`,
          err
        );
      }
    }
  }

  private calculatePrize(position: number): number {
    if (!this.tournamentInfo) return 0;
    if (
      !this.tournamentInfo.payout_structure ||
      !Array.isArray(this.tournamentInfo.payout_structure)
    )
      return 0;

    const payoutEntry = this.tournamentInfo.payout_structure.find(
      (p) => (p.place || p.position) === position
    );
    if (!payoutEntry) return 0;

    // Exact precision — scale ×100 first to avoid floating point errors
    // prize = pool * (percentage / 100), then truncate to 2 decimal places
    const prizeRaw = (this.tournamentInfo.prize_pool * payoutEntry.percentage) / 100;
    return Math.trunc(prizeRaw * 100) / 100;
  }

  private async creditPrize(userId: string, amount: number): Promise<void> {
    if (!this.tournamentInfo) return;

    // Validate userId — skip zero UUIDs or invalid IDs
    const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
    if (
      !userId ||
      userId === ZERO_UUID ||
      userId.length < 8 ||
      userId.replace(/0/g, '').replace(/-/g, '').length === 0
    ) {
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Skipping prize credit — invalid userId: ${userId}`
      );
      return;
    }

    const clubId = this.tournamentInfo.club_id;

    // Credit prize to Player Wallet ATOMICALLY via SECURITY DEFINER RPC
    const { data: creditResult, error: creditError } = await retryAsync(
      () =>
        this.supabase.rpc('atomic_credit_wallet_and_log', {
          p_user_id: userId,
          p_amount: amount,
          p_category: 'prize',
          p_description: `Tournament prize — ${this.tournamentInfo?.name}`,
          p_table_id: null,
          p_hand_id: null,
          p_related_entity_id: this.tournamentId,
        }),
      3
    );

    if (creditError) {
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to atomically credit Player Wallet for ${userId.slice(0, 8)} — prize ${amount.toFixed(2)}:`,
        creditError
      );
      return;
    }
    // Log in chip_transactions for club accounting
    const { error: auditErr } = await this.supabase.from('chip_transactions').insert({
      club_id: clubId,
      from_user_id: null,
      to_user_id: userId,
      amount: amount,
      transaction_type: 'cash_out',
      notes: `Tournament prize: ${this.tournamentInfo.name}`,
    });
    if (auditErr)
      console.error(
        `[TournamentEngine:${this.tournamentId.slice(0, 8)}] chip_transactions audit log failed:`,
        auditErr
      );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TABLE BALANCING
  // ═══════════════════════════════════════════════════════════════════════════

  private async checkTableBalance(): Promise<void> {
    if (this.tables.length <= 1 || this.tableBreakInProgress) return;

    // Find tables with active players
    const activeTables = this.tables.filter((t) => t.playerCount > 0);
    if (activeTables.length <= 1) return;

    // Clean up empty tables first (0 players)
    const emptyTables = this.tables.filter((t) => t.playerCount === 0);
    for (const empty of emptyTables) {
      empty.engine.stop();
      // 1. Evict any ghost seats to keep DB clean
      await this.supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', empty.tableId)
        .is('left_at', null);

      // 2. Mark table closed
      await this.supabase
        .from('tables')
        .update({ status: 'closed', current_players: 0 })
        .eq('id', empty.tableId);

      this.removeTable(empty);
    }

    // Re-check active tables after cleanup
    const remainingTables = this.tables.filter((t) => t.playerCount > 0);
    if (remainingTables.length <= 1) return;

    // Sort by player count ascending — merge smallest first
    remainingTables.sort((a, b) => a.playerCount - b.playerCount);

    // Merge tables that are too small (< 3 players) into larger ones
    // Also merge if total remaining players can fit at fewer tables
    const capacity = this.getTableCapacity();
    const totalPlayers = remainingTables.reduce((s, t) => s + t.playerCount, 0);
    const minTablesNeeded = Math.ceil(totalPlayers / capacity);

    if (remainingTables.length > minTablesNeeded) {
      // Lock to prevent overlapping table breaks
      this.tableBreakInProgress = true;
      try {
        await this.mergeTable(remainingTables[0]);
      } finally {
        this.tableBreakInProgress = false;
      }
    }
  }

  private async mergeTable(sourceTable: TournamentTable): Promise<void> {
    // Stop the source table engine immediately to prevent new hands
    sourceTable.engine.stop();

    // Build TableSnapshots for the break engine
    const snapshots: TableSnapshot[] = [];
    const activeTables = this.tables.filter((t) => t.playerCount > 0);

    for (const t of activeTables) {
      const { data: seats } = await this.supabase
        .from('table_seats')
        .select('user_id, stack, seat_number')
        .eq('table_id', t.tableId)
        .is('left_at', null);

      snapshots.push({
        tableId: t.tableId,
        playerCount: seats?.length || 0,
        maxPlayers: this.getTableCapacity(),
        occupiedSeats: seats?.map((s) => s.seat_number) || [],
        players:
          seats?.map((s) => ({
            playerId: s.user_id,
            seat: s.seat_number,
            stack: s.stack,
          })) || [],
      });
    }

    const brokenSnapshot = snapshots.find((s) => s.tableId === sourceTable.tableId);
    const remainingSnapshots = snapshots.filter((s) => s.tableId !== sourceTable.tableId);

    if (!brokenSnapshot || brokenSnapshot.players.length === 0) {
      await this.supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', sourceTable.tableId)
        .is('left_at', null);

      await this.supabase
        .from('tables')
        .update({ status: 'closed', current_players: 0 })
        .eq('id', sourceTable.tableId);

      this.removeTable(sourceTable);
      return;
    }

    if (remainingSnapshots.length === 0) return;

    // Initiate Break using Phase 4 Engine (handles 30s countdown and balanced redistribution)
    const result = await tableBreakEngine.initiateBreak(
      brokenSnapshot,
      remainingSnapshots,
      this.tournamentId
    );

    // Apply the returned movements
    for (const move of result.movements) {
      // Mark old seat as left
      await this.supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', move.fromTableId)
        .eq('user_id', move.playerId)
        .is('left_at', null);

      // Clear target seat if occupied
      await this.supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString(), status: 'left' })
        .eq('table_id', move.toTableId)
        .eq('seat_number', move.toSeat)
        .is('left_at', null);

      // Insert at target table
      const { error: insertErr } = await this.supabase.from('table_seats').insert({
        table_id: move.toTableId,
        seat_number: move.toSeat,
        user_id: move.playerId,
        stack: move.stack,
        is_sitting_out: false,
      });

      if (insertErr) {
        console.error(
          `[TournamentEngine:${this.tournamentId.slice(0, 8)}] Failed to insert merged seat for ${move.playerId.slice(0, 8)}:`,
          insertErr.message
        );
        continue;
      }

      // Update local state
      const targetTable = this.tables.find((t) => t.tableId === move.toTableId);
      if (targetTable) {
        targetTable.playerCount++;
        // Sync destination table current_players in DB
        await this.supabase
          .from('tables')
          .update({ current_players: targetTable.playerCount })
          .eq('id', move.toTableId);
      }

      const player = this.players.get(move.playerId);
      if (player) {
        player.tableId = move.toTableId;
        player.seatNumber = move.toSeat;
      }

      // Update tournament_players.table_id so UI "Enter Table" button routes correctly
      await this.supabase
        .from('tournament_players')
        .update({ table_id: move.toTableId })
        .eq('tournament_id', this.tournamentId)
        .eq('user_id', move.playerId);
    }

    // Clean up source table
    this.removeTable(sourceTable);

    // Evict all seats (should be empty from the merge, but safe cleanup)
    await this.supabase
      .from('table_seats')
      .update({ left_at: new Date().toISOString() })
      .eq('table_id', sourceTable.tableId)
      .is('left_at', null);

    await this.supabase
      .from('tables')
      .update({ status: 'closed', current_players: 0 })
      .eq('id', sourceTable.tableId);

    masterBus.emit('TABLE_MERGED', {
      tournamentId: this.tournamentId,
      sourceTableId: sourceTable.tableId,
      tablesRemaining: this.tables.length,
    });
  }

  private removeTable(table: TournamentTable): void {
    const idx = this.tables.indexOf(table);
    if (idx !== -1) {
      this.tables.splice(idx, 1);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FINISH TOURNAMENT
  // ═══════════════════════════════════════════════════════════════════════════

  private async finishTournament(winner?: TournamentPlayer): Promise<void> {
    if (!this.running || this.finishing) return;
    this.finishing = true;
    this.running = false;

    // Stop all table engines
    for (const table of this.tables) {
      table.engine.stop();
    }

    // Check if this is a satellite tournament BEFORE awarding prizes
    const isSatellite =
      this.tournamentInfo?.variant === 'satellite' ||
      this.tournamentInfo?.tournament_type === 'SATELLITE';

    if (isSatellite && this.tournamentInfo) {
      // SATELLITE: Award seats/tickets to top N finishers, NOT cash prizes
      const ticketPlaces = this.tournamentInfo.payout_structure?.length || 1;

      // Get all finished players sorted by finish position
      const winners = Array.from(this.players.values())
        .filter((p) => p.status === 'winner' || p.status === 'eliminated')
        .sort((a, b) => {
          const aPos = a.position || 999;
          const bPos = b.position || 999;
          return aPos - bPos; // Lower position = better finish
        })
        .slice(0, ticketPlaces);

      // Award tickets to top N finishers (no cash prizes for satellites)
      const ticketWinnerIds: string[] = [];
      for (const player of winners) {
        // Update tournament_players with 0 prize (no cash)
        await this.supabase
          .from('tournament_players')
          .update({
            status: player === winner ? 'winner' : 'eliminated',
            position: player.position || 0,
            prize: 0, // Satellites pay seats, not cash
          })
          .eq('tournament_id', this.tournamentId)
          .eq('user_id', player.user_id);

        // Record ticket award in tournament_bounties table (reusing for satellites)
        await this.supabase.from('tournament_bounties').insert({
          tournament_id: this.tournamentId,
          collector_player_id: player.user_id,
          bounty_amount: 1, // 1 ticket = 1 seat
          is_satellite_ticket: true, // Flag as satellite ticket
        });

        // Credit ticket to player wallet as tournament currency
        try {
          await this.supabase.rpc('credit_player_wallet', {
            p_user_id: player.user_id,
            p_amount: 1, // 1 ticket
          });
        } catch (e: unknown) {
          console.error(
            `[TournamentEngine] Failed to credit satellite ticket to ${player.user_id}:`,
            e
          );
        }

        ticketWinnerIds.push(player.user_id);
      }

      // Emit satellite completion with actual winner list
      masterBus.emit('SATELLITE_COMPLETE', {
        tournamentId: this.tournamentId,
        ticketWinners: ticketWinnerIds,
        targetTournament: this.tournamentInfo?.satellite_target || null,
      });
    } else {
      // REGULAR TOURNAMENT: Award cash prizes
      if (winner) {
        winner.status = 'winner';
        const firstPrize = this.calculatePrize(1);
        await this.supabase
          .from('tournament_players')
          .update({
            status: 'winner',
            position: 1,
            prize: firstPrize,
          })
          .eq('tournament_id', this.tournamentId)
          .eq('user_id', winner.user_id);

        if (firstPrize > 0) {
          await this.creditPrize(winner.user_id, firstPrize);
        }
      }
    }

    // Update tournament status
    await this.supabase
      .from('tournaments')
      .update({
        status: 'COMPLETED',
        ended_at: new Date().toISOString(),
      })
      .eq('id', this.tournamentId);

    // Close all tournament tables and evict seats
    for (const table of this.tables) {
      await this.supabase
        .from('table_seats')
        .update({ left_at: new Date().toISOString() })
        .eq('table_id', table.tableId)
        .is('left_at', null);

      await this.supabase
        .from('tables')
        .update({ status: 'closed', current_players: 0 })
        .eq('id', table.tableId);
    }

    // Clear intervals
    if (this.blindCheckInterval) clearInterval(this.blindCheckInterval);
    if (this.eliminationCheckInterval) clearInterval(this.eliminationCheckInterval);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════════

  private mapGameVariant(gameType: string): string {
    const map: Record<string, string> = {
      NLH: 'nlh',
      PLO: 'plo4',
      PLO4: 'plo4',
      PLO5: 'plo5',
      PLO6: 'plo6',
      PLO8: 'plo8',
      OFC_PINEAPPLE: 'ofc_pineapple',
      SHORT_DECK: 'short_deck',
    };
    return map[gameType?.toUpperCase()] || 'nlh';
  }

  private getOrdinal(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  }
}
