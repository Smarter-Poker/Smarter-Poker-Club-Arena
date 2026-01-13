/**
 * ♠ CLUB ARENA — Tournament Service
 * SNGs and MTTs with blind levels and payout structures
 */

import { supabase, isDemoMode } from '../lib/supabase';
import type { Tournament, TournamentPlayer } from '../types/database.types';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BlindLevel {
    level: number;
    smallBlind: number;
    bigBlind: number;
    ante: number;
    durationMinutes: number;
}

export interface PayoutStructure {
    place: number;
    percentage: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tournament Types:
 * - sng: Sit & Go (starts when full)
 * - mtt: Multi-Table Tournament (scheduled start)
 * - satellite: Wins seats to bigger tournaments
 * - spin: Spin & Go (random multiplier prize pools)
 * - bounty: Fixed bounty per knockout
 * - mystery_bounty: Hidden bounty revealed on knockout
 * - progressive_bounty: Half bounty to knocker, half added to their head
 */
export type TournamentType =
    | 'sng'
    | 'mtt'
    | 'satellite'
    | 'spin'
    | 'bounty'
    | 'mystery_bounty'
    | 'progressive_bounty';

export interface BountyConfig {
    bountyType: 'fixed' | 'mystery' | 'progressive';
    baseBounty: number; // Starting bounty per player
    mysteryTiers?: MysteryBountyTier[]; // For mystery bounties
    progressiveStartLevel?: number; // When progressive bounties start
}

export interface MysteryBountyTier {
    minMultiplier: number;
    maxMultiplier: number;
    probability: number; // Percentage chance
}

export interface SpinConfig {
    possibleMultipliers: SpinMultiplier[];
}

export interface SpinMultiplier {
    multiplier: number; // e.g., 2, 3, 5, 10, 25, 120, 10000
    probability: number; // Percentage chance
    isPremium?: boolean; // Special handling for huge multipliers
}

export interface TournamentConfig {
    name: string;
    type: TournamentType;
    buyIn: number;
    rake: number;
    startingStack: number;
    maxPlayers: number;
    minPlayers: number;
    blindStructure: BlindLevel[];
    payoutStructure: PayoutStructure[];
    lateRegistrationLevels: number;
    startTime?: Date;

    // Rebuy/Add-on
    isRebuy: boolean;
    rebuyLevels?: number;
    rebuyChips?: number;
    rebuyCost?: number;
    addOnAvailable: boolean;
    addOnChips?: number;
    addOnCost?: number;

    // Bounty Configuration
    bountyConfig?: BountyConfig;

    // Spin Configuration
    spinConfig?: SpinConfig;

    // Satellite Target
    satelliteTarget?: {
        tournamentId: string;
        seatsAwarded: number;
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STANDARD STRUCTURES
// ═══════════════════════════════════════════════════════════════════════════════

export const BLIND_STRUCTURES = {
    turbo: [
        { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 3 },
        { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 3 },
        { level: 3, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 3 },
        { level: 4, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 3 },
        { level: 5, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 3 },
        { level: 6, smallBlind: 100, bigBlind: 200, ante: 20, durationMinutes: 3 },
        { level: 7, smallBlind: 150, bigBlind: 300, ante: 30, durationMinutes: 3 },
        { level: 8, smallBlind: 200, bigBlind: 400, ante: 40, durationMinutes: 3 },
        { level: 9, smallBlind: 300, bigBlind: 600, ante: 60, durationMinutes: 3 },
        { level: 10, smallBlind: 400, bigBlind: 800, ante: 80, durationMinutes: 3 },
    ],
    regular: [
        { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 8 },
        { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 8 },
        { level: 3, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 8 },
        { level: 4, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 8 },
        { level: 5, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 8 },
        { level: 6, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 8 },
        { level: 7, smallBlind: 150, bigBlind: 300, ante: 40, durationMinutes: 8 },
        { level: 8, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 8 },
        { level: 9, smallBlind: 300, bigBlind: 600, ante: 75, durationMinutes: 8 },
        { level: 10, smallBlind: 400, bigBlind: 800, ante: 100, durationMinutes: 8 },
    ],
    deepStack: [
        { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 15 },
        { level: 2, smallBlind: 15, bigBlind: 30, ante: 0, durationMinutes: 15 },
        { level: 3, smallBlind: 20, bigBlind: 40, ante: 0, durationMinutes: 15 },
        { level: 4, smallBlind: 25, bigBlind: 50, ante: 5, durationMinutes: 15 },
        { level: 5, smallBlind: 50, bigBlind: 100, ante: 10, durationMinutes: 15 },
        { level: 6, smallBlind: 75, bigBlind: 150, ante: 15, durationMinutes: 15 },
        { level: 7, smallBlind: 100, bigBlind: 200, ante: 25, durationMinutes: 15 },
        { level: 8, smallBlind: 150, bigBlind: 300, ante: 40, durationMinutes: 15 },
        { level: 9, smallBlind: 200, bigBlind: 400, ante: 50, durationMinutes: 15 },
        { level: 10, smallBlind: 300, bigBlind: 600, ante: 75, durationMinutes: 15 },
    ],
};

export const PAYOUT_STRUCTURES = {
    sng6: [
        { place: 1, percentage: 65 },
        { place: 2, percentage: 35 },
    ],
    sng9: [
        { place: 1, percentage: 50 },
        { place: 2, percentage: 30 },
        { place: 3, percentage: 20 },
    ],
    mtt10: [
        { place: 1, percentage: 50 },
        { place: 2, percentage: 30 },
        { place: 3, percentage: 20 },
    ],
    mtt20: [
        { place: 1, percentage: 38 },
        { place: 2, percentage: 27 },
        { place: 3, percentage: 18 },
        { place: 4, percentage: 10 },
        { place: 5, percentage: 7 },
    ],
    mtt50: [
        { place: 1, percentage: 28 },
        { place: 2, percentage: 18 },
        { place: 3, percentage: 13 },
        { place: 4, percentage: 10 },
        { place: 5, percentage: 8 },
        { place: 6, percentage: 6 },
        { place: 7, percentage: 5 },
        { place: 8, percentage: 4.5 },
        { place: 9, percentage: 4 },
        { place: 10, percentage: 3.5 },
    ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// SPIN CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const SPIN_MULTIPLIERS: Record<string, SpinMultiplier[]> = {
    standard: [
        { multiplier: 2, probability: 75.0 },
        { multiplier: 3, probability: 15.0 },
        { multiplier: 5, probability: 7.0 },
        { multiplier: 10, probability: 2.5 },
        { multiplier: 25, probability: 0.4 },
        { multiplier: 120, probability: 0.09, isPremium: true },
        { multiplier: 10000, probability: 0.01, isPremium: true },
    ],
    hyper: [
        { multiplier: 2, probability: 65.0 },
        { multiplier: 4, probability: 20.0 },
        { multiplier: 6, probability: 10.0 },
        { multiplier: 12, probability: 4.0 },
        { multiplier: 50, probability: 0.9 },
        { multiplier: 240, probability: 0.09, isPremium: true },
        { multiplier: 12000, probability: 0.01, isPremium: true },
    ],
};

// ═══════════════════════════════════════════════════════════════════════════════
// BOUNTY CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const BOUNTY_PRESETS: Record<string, BountyConfig> = {
    fixed: {
        bountyType: 'fixed',
        baseBounty: 5, // 50% of buy-in typically goes to bounty
    },
    progressive: {
        bountyType: 'progressive',
        baseBounty: 2.5, // 25% of buy-in as starting bounty
        progressiveStartLevel: 1,
    },
    mystery: {
        bountyType: 'mystery',
        baseBounty: 10,
        mysteryTiers: [
            { minMultiplier: 1, maxMultiplier: 1, probability: 60 },
            { minMultiplier: 2, maxMultiplier: 2, probability: 25 },
            { minMultiplier: 5, maxMultiplier: 5, probability: 10 },
            { minMultiplier: 10, maxMultiplier: 10, probability: 4 },
            { minMultiplier: 50, maxMultiplier: 50, probability: 0.9 },
            { minMultiplier: 500, maxMultiplier: 500, probability: 0.1 },
        ],
    },
};

// ═══════════════════════════════════════════════════════════════════════════════
// HYPER-TURBO STRUCTURE (for Spins)
// ═══════════════════════════════════════════════════════════════════════════════

export const SPIN_BLIND_STRUCTURE: BlindLevel[] = [
    { level: 1, smallBlind: 10, bigBlind: 20, ante: 0, durationMinutes: 2 },
    { level: 2, smallBlind: 20, bigBlind: 40, ante: 0, durationMinutes: 2 },
    { level: 3, smallBlind: 30, bigBlind: 60, ante: 0, durationMinutes: 2 },
    { level: 4, smallBlind: 50, bigBlind: 100, ante: 0, durationMinutes: 2 },
    { level: 5, smallBlind: 75, bigBlind: 150, ante: 0, durationMinutes: 2 },
    { level: 6, smallBlind: 100, bigBlind: 200, ante: 0, durationMinutes: 2 },
    { level: 7, smallBlind: 150, bigBlind: 300, ante: 0, durationMinutes: 2 },
    { level: 8, smallBlind: 250, bigBlind: 500, ante: 0, durationMinutes: 2 },
];

// Demo tournaments
const DEMO_TOURNAMENTS: Tournament[] = [
    {
        id: 'tourn-1',
        club_id: '1',
        name: '10 Chip Turbo SNG',
        type: 'sng',
        buy_in: 10,
        rake: 1,
        starting_chips: 1500,
        max_players: 6,
        current_players: 4,
        status: 'registering',
        blind_structure: BLIND_STRUCTURES.turbo,
        payout_structure: PAYOUT_STRUCTURES.sng6,
        prize_pool: 40,
        created_at: new Date().toISOString(),
    },
    {
        id: 'tourn-2',
        club_id: '1',
        name: 'Sunday 50K GTD',
        type: 'mtt',
        buy_in: 5,
        rake: 0.5,
        starting_chips: 5000,
        max_players: 50,
        current_players: 23,
        status: 'registering',
        blind_structure: BLIND_STRUCTURES.regular,
        payout_structure: PAYOUT_STRUCTURES.mtt50,
        prize_pool: 115,
        start_time: new Date(Date.now() + 3600000).toISOString(),
        created_at: new Date().toISOString(),
    },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class TournamentService {
    // ─────────────────────────────────────────────────────────────────────────────
    // Tournament CRUD
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get all tournaments for a club
     */
    async getTournaments(clubId: string): Promise<Tournament[]> {
        if (isDemoMode) {
            return DEMO_TOURNAMENTS.filter(t => t.club_id === clubId);
        }

        const { data, error } = await supabase
            .from('tournaments')
            .select('*')
            .eq('club_id', clubId)
            .order('created_at', { ascending: false });

        if (error) throw error;
        return data || [];
    }

    /**
     * Get a single tournament
     */
    async getTournament(tournamentId: string): Promise<Tournament | null> {
        if (isDemoMode) {
            return DEMO_TOURNAMENTS.find(t => t.id === tournamentId) || null;
        }

        const { data, error } = await supabase
            .from('tournaments')
            .select('*')
            .eq('id', tournamentId)
            .single();

        if (error) return null;
        return data;
    }

    /**
     * Create a new tournament
     */
    async createTournament(clubId: string, config: TournamentConfig): Promise<Tournament> {
        if (isDemoMode) {
            const tournament: Tournament = {
                id: crypto.randomUUID(),
                club_id: clubId,
                name: config.name,
                type: config.type,
                buy_in: config.buyIn,
                rake: config.rake,
                starting_chips: config.startingStack,
                max_players: config.maxPlayers,
                current_players: 0,
                status: 'scheduled',
                blind_structure: config.blindStructure,
                payout_structure: config.payoutStructure,
                prize_pool: 0,
                start_time: config.startTime?.toISOString(),
                created_at: new Date().toISOString(),
            };
            DEMO_TOURNAMENTS.push(tournament);
            return tournament;
        }

        const { data, error } = await supabase
            .from('tournaments')
            .insert({
                club_id: clubId,
                name: config.name,
                type: config.type,
                buy_in: config.buyIn,
                rake: config.rake,
                starting_chips: config.startingStack,
                max_players: config.maxPlayers,
                current_players: 0,
                status: 'scheduled',
                blind_structure: config.blindStructure,
                payout_structure: config.payoutStructure,
                prize_pool: 0,
                start_time: config.startTime?.toISOString(),
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Registration
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Register a player for a tournament
     */
    async registerPlayer(
        tournamentId: string,
        userId: string,
        username: string
    ): Promise<TournamentPlayer> {
        if (isDemoMode) {
            return {
                id: crypto.randomUUID(),
                tournament_id: tournamentId,
                user_id: userId,
                username,
                chips: 0,
                status: 'registered',
                position: null,
                prize: null,
                registered_at: new Date().toISOString(),
            };
        }

        const tournament = await this.getTournament(tournamentId);
        if (!tournament) throw new Error('Tournament not found');
        if (tournament.status !== 'registering' && tournament.status !== 'scheduled') {
            throw new Error('Registration is closed');
        }
        if (tournament.current_players >= tournament.max_players) {
            throw new Error('Tournament is full');
        }

        // Insert player
        const { data, error } = await supabase
            .from('tournament_players')
            .insert({
                tournament_id: tournamentId,
                user_id: userId,
                username,
                chips: 0,
                status: 'registered',
            })
            .select()
            .single();

        if (error) throw error;

        // Update player count
        await supabase
            .from('tournaments')
            .update({
                current_players: tournament.current_players + 1,
                prize_pool: tournament.prize_pool + tournament.buy_in,
            })
            .eq('id', tournamentId);

        return data;
    }

    /**
     * Unregister a player
     */
    async unregisterPlayer(tournamentId: string, userId: string): Promise<void> {
        if (isDemoMode) return;

        const tournament = await this.getTournament(tournamentId);
        if (!tournament) throw new Error('Tournament not found');
        if (tournament.status !== 'registering' && tournament.status !== 'scheduled') {
            throw new Error('Cannot unregister after tournament started');
        }

        await supabase
            .from('tournament_players')
            .delete()
            .eq('tournament_id', tournamentId)
            .eq('user_id', userId);

        await supabase
            .from('tournaments')
            .update({
                current_players: tournament.current_players - 1,
                prize_pool: tournament.prize_pool - tournament.buy_in,
            })
            .eq('id', tournamentId);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Tournament Operations
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Start a tournament
     */
    async startTournament(tournamentId: string): Promise<Tournament> {
        if (isDemoMode) {
            const tournament = DEMO_TOURNAMENTS.find(t => t.id === tournamentId);
            if (tournament) tournament.status = 'running';
            return tournament!;
        }

        const tournament = await this.getTournament(tournamentId);
        if (!tournament) throw new Error('Tournament not found');

        // 1. Get Players
        const { data: players } = await supabase
            .from('tournament_players')
            .select('*')
            .eq('tournament_id', tournamentId)
            .eq('status', 'registered');

        if (!players || players.length === 0) throw new Error('No players registered');

        // 2. Create Tables
        const playersPerTable = 9;
        const numTables = Math.ceil(players.length / playersPerTable);
        const createdTables: any[] = [];

        for (let i = 0; i < numTables; i++) {
            const { data: table } = await supabase
                .from('tables')
                .insert({
                    club_id: tournament.club_id,
                    tournament_id: tournament.id,
                    name: `${tournament.name} - Table ${i + 1}`,
                    game_type: 'tournament',
                    game_variant: 'nlh',
                    stakes: 'Tournament',
                    small_blind: tournament.blind_structure[0].smallBlind,
                    big_blind: tournament.blind_structure[0].bigBlind,
                    min_buy_in: 0,
                    max_buy_in: 0,
                    max_players: 9,
                    status: 'running',
                    settings: { auto_muck: true, time_bank_seconds: 30 }
                })
                .select()
                .single();

            if (table) createdTables.push(table);
        }

        // 3. Seat Players
        const shuffled = [...players].sort(() => 0.5 - Math.random());
        const tableSeats = createdTables.map(t => ({ tableId: t.id, nextSeat: 1 }));

        for (let i = 0; i < shuffled.length; i++) {
            const player = shuffled[i];
            const tableAssign = tableSeats[i % numTables];

            await supabase.from('table_seats').insert({
                table_id: tableAssign.tableId,
                seat_number: tableAssign.nextSeat,
                user_id: player.user_id,
                stack: tournament.starting_chips
            });
            tableAssign.nextSeat++;
        }

        // 4. Update Tournament
        const { data, error } = await supabase
            .from('tournaments')
            .update({
                status: 'running',
                started_at: new Date().toISOString(),
            })
            .eq('id', tournamentId)
            .select()
            .single();

        if (error) throw error;

        // 5. Update Player Chips
        await supabase
            .from('tournament_players')
            .update({
                chips: tournament.starting_chips,
                status: 'playing',
            })
            .eq('tournament_id', tournamentId)
            .eq('status', 'registered');

        return data;
    }

    /**
     * Eliminate a player
     */
    async eliminatePlayer(
        tournamentId: string,
        userId: string,
        position: number
    ): Promise<void> {
        if (isDemoMode) return;

        const tournament = await this.getTournament(tournamentId);
        if (!tournament) throw new Error('Tournament not found');

        // Calculate prize
        const payoutEntry = tournament.payout_structure.find(p => p.place === position);
        const prize = payoutEntry
            ? Math.floor((tournament.prize_pool * payoutEntry.percentage) / 100)
            : 0;

        await supabase
            .from('tournament_players')
            .update({
                status: 'eliminated',
                position,
                prize,
                eliminated_at: new Date().toISOString(),
            })
            .eq('tournament_id', tournamentId)
            .eq('user_id', userId);
    }

    /**
     * Automatically eliminate a player:
     * 1. Calculate rank based on remaining players.
     * 2. Update status to eliminated.
     * 3. Remove from table seat.
     */
    async eliminatePlayerAuto(tournamentId: string, userId: string): Promise<void> {
        if (isDemoMode) return;

        // 1. Get current active player count (this will be the position)
        const { count } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact', head: true })
            .eq('tournament_id', tournamentId)
            .eq('status', 'playing');

        const position = count || 1;

        // 2. Eliminate
        await this.eliminatePlayer(tournamentId, userId, position);

        // 3. Remove from seat (and trigger room update via postgres change or client refresh)
        // Find seat first to check correctness?
        // Note: Using maybeSingle to be safe.
        const { data: seat } = await supabase.from('table_seats').select('table_id').eq('user_id', userId).maybeSingle();
        if (seat) {
            const { data: table } = await supabase.from('tables').select('tournament_id').eq('id', seat.table_id).single();
            if (table?.tournament_id === tournamentId) {
                await supabase.from('table_seats').delete().eq('user_id', userId).eq('table_id', seat.table_id);
            }
        }
    }

    /**
     * Get payout amount for a position
     */
    calculatePayout(prizePool: number, position: number, structure: PayoutStructure[]): number {
        const entry = structure.find(p => p.place === position);
        if (!entry) return 0;
        return Math.floor((prizePool * entry.percentage) / 100);
    }

    /**
     * Get current blind level based on time elapsed
     */
    /**
     * Get current blind level state with high precision
     */
    getCurrentLevelState(tournament: Tournament): {
        currentLevel: BlindLevel;
        nextLevel: BlindLevel | null;
        timeRemainingSeconds: number;
        levelIndex: number;
    } {
        if (tournament.status !== 'running' || !tournament.started_at) {
            return {
                currentLevel: tournament.blind_structure[0],
                nextLevel: tournament.blind_structure[1] || null,
                timeRemainingSeconds: tournament.blind_structure[0].durationMinutes * 60,
                levelIndex: 0
            };
        }

        const elapsedMs = new Date().getTime() - new Date(tournament.started_at).getTime();
        let accumulatedMs = 0;

        for (let i = 0; i < tournament.blind_structure.length; i++) {
            const level = tournament.blind_structure[i];
            const durationMs = level.durationMinutes * 60 * 1000;

            if (elapsedMs < accumulatedMs + durationMs) {
                return {
                    currentLevel: level,
                    nextLevel: tournament.blind_structure[i + 1] || null,
                    timeRemainingSeconds: Math.floor((accumulatedMs + durationMs - elapsedMs) / 1000),
                    levelIndex: i
                };
            }
            accumulatedMs += durationMs;
        }

        // Capped at last level
        return {
            currentLevel: tournament.blind_structure[tournament.blind_structure.length - 1],
            nextLevel: null,
            timeRemainingSeconds: 0,
            levelIndex: tournament.blind_structure.length - 1
        };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Rebuy / Add-on
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Check if rebuy is available for a player
     */
    async canRebuy(tournamentId: string, userId: string): Promise<{ allowed: boolean; reason?: string }> {
        const tournament = await this.getTournament(tournamentId);
        if (!tournament) return { allowed: false, reason: 'Tournament not found' };

        // @ts-ignore - Check if rebuy is configured
        if (!tournament.is_rebuy) return { allowed: false, reason: 'Rebuys not available' };

        const levelState = this.getCurrentLevelState(tournament);
        // @ts-ignore
        if (levelState.levelIndex >= (tournament.rebuy_levels || 4)) {
            return { allowed: false, reason: 'Rebuy period has ended' };
        }

        // Check current stack (must be at or below starting stack)
        const { data: player } = await supabase
            .from('tournament_players')
            .select('chips')
            .eq('tournament_id', tournamentId)
            .eq('user_id', userId)
            .single();

        if (!player) return { allowed: false, reason: 'Player not found' };
        if (player.chips > tournament.starting_chips) {
            return { allowed: false, reason: 'Stack too high for rebuy' };
        }

        return { allowed: true };
    }

    /**
     * Process a rebuy for a player
     */
    async processRebuy(tournamentId: string, userId: string): Promise<{ success: boolean; newStack?: number }> {
        const canRebuyResult = await this.canRebuy(tournamentId, userId);
        if (!canRebuyResult.allowed) {
            throw new Error(canRebuyResult.reason || 'Rebuy not allowed');
        }

        const tournament = await this.getTournament(tournamentId);
        if (!tournament) throw new Error('Tournament not found');

        // @ts-ignore
        const rebuyChips = tournament.rebuy_chips || tournament.starting_chips;
        // @ts-ignore
        const rebuyCost = tournament.rebuy_cost || tournament.buy_in;

        if (isDemoMode) {
            return { success: true, newStack: rebuyChips };
        }

        // Process rebuy via RPC
        const { data, error } = await supabase.rpc('process_tournament_rebuy', {
            p_tournament_id: tournamentId,
            p_player_id: userId,
            p_rebuy_type: 'rebuy',
            p_cost: rebuyCost,
            p_chips: rebuyChips,
            p_current_level: this.getCurrentLevelState(tournament).levelIndex,
        });

        if (error) throw error;

        // Broadcast rebuy event
        try {
            const { realtimeChannelService } = await import('./RealtimeChannelService');
            await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
                type: 'player_registered', // Using existing event type
                payload: { type: 'rebuy', userId, chips: rebuyChips },
            });
        } catch (e) {
            console.warn('Failed to broadcast rebuy event:', e);
        }

        return { success: true, newStack: data?.new_stack || rebuyChips };
    }

    /**
     * Check if add-on is available
     */
    async canAddOn(tournamentId: string): Promise<{ allowed: boolean; reason?: string }> {
        const tournament = await this.getTournament(tournamentId);
        if (!tournament) return { allowed: false, reason: 'Tournament not found' };

        // @ts-ignore
        if (!tournament.addon_available) return { allowed: false, reason: 'Add-ons not available' };

        const levelState = this.getCurrentLevelState(tournament);
        // Add-on typically available at end of rebuy period
        // @ts-ignore
        const addonLevel = tournament.rebuy_levels || 4;
        if (levelState.levelIndex !== addonLevel) {
            return { allowed: false, reason: 'Add-on period not active' };
        }

        return { allowed: true };
    }

    /**
     * Process an add-on for a player
     */
    async processAddOn(tournamentId: string, userId: string): Promise<{ success: boolean; newStack?: number }> {
        const canAddOnResult = await this.canAddOn(tournamentId);
        if (!canAddOnResult.allowed) {
            throw new Error(canAddOnResult.reason || 'Add-on not allowed');
        }

        const tournament = await this.getTournament(tournamentId);
        if (!tournament) throw new Error('Tournament not found');

        // @ts-ignore
        const addonChips = tournament.addon_chips || tournament.starting_chips;
        // @ts-ignore
        const addonCost = tournament.addon_cost || tournament.buy_in;

        if (isDemoMode) {
            return { success: true, newStack: addonChips };
        }

        const { data, error } = await supabase.rpc('process_tournament_rebuy', {
            p_tournament_id: tournamentId,
            p_player_id: userId,
            p_rebuy_type: 'addon',
            p_cost: addonCost,
            p_chips: addonChips,
            p_current_level: this.getCurrentLevelState(tournament).levelIndex,
        });

        if (error) throw error;

        return { success: true, newStack: data?.new_stack };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Table Balancing
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Balance tables in a multi-table tournament
     */
    async balanceTables(tournamentId: string): Promise<{ movesMade: number }> {
        if (isDemoMode) {
            return { movesMade: 0 };
        }

        const { data, error } = await supabase.rpc('balance_tournament_tables', {
            p_tournament_id: tournamentId,
        });

        if (error) {
            console.error('Table balancing error:', error);
            return { movesMade: 0 };
        }

        return { movesMade: data || 0 };
    }

    /**
     * Check if tables need balancing
     */
    async checkBalanceNeeded(tournamentId: string): Promise<boolean> {
        // Get all active tables and their player counts
        const { data: tables } = await supabase
            .from('tournament_tables')
            .select('id, current_players')
            .eq('tournament_id', tournamentId)
            .eq('status', 'active');

        if (!tables || tables.length < 2) return false;

        const counts = tables.map(t => t.current_players);
        const max = Math.max(...counts);
        const min = Math.min(...counts);

        // Balance needed if difference is more than 1
        return (max - min) > 1;
    }

    /**
     * Merge tables when player count drops
     */
    async checkTableMerge(tournamentId: string): Promise<{ tableMerged: boolean }> {
        const { data: tables } = await supabase
            .from('tournament_tables')
            .select('id, current_players')
            .eq('tournament_id', tournamentId)
            .eq('status', 'active')
            .order('current_players', { ascending: true });

        if (!tables || tables.length < 2) return { tableMerged: false };

        // Get total remaining players
        const totalPlayers = tables.reduce((sum, t) => sum + t.current_players, 0);
        const playersPerTable = 9;
        const neededTables = Math.ceil(totalPlayers / playersPerTable);

        if (tables.length > neededTables) {
            // Break the smallest table
            const tableToBreak = tables[0];

            await supabase
                .from('tournament_tables')
                .update({ status: 'breaking' })
                .eq('id', tableToBreak.id);

            // Balance will move players
            await this.balanceTables(tournamentId);

            await supabase
                .from('tournament_tables')
                .update({ status: 'broken' })
                .eq('id', tableToBreak.id);

            return { tableMerged: true };
        }

        return { tableMerged: false };
    }

    /**
     * Create final table (consolidate to 1 table when 9 or fewer players remain)
     */
    async createFinalTable(tournamentId: string): Promise<{ finalTableId: string | null }> {
        const { data: activePlayers, count } = await supabase
            .from('tournament_players')
            .select('*', { count: 'exact' })
            .eq('tournament_id', tournamentId)
            .eq('status', 'playing');

        if (!count || count > 9) return { finalTableId: null };

        // Get or create final table
        let { data: finalTable } = await supabase
            .from('tournament_tables')
            .select('id')
            .eq('tournament_id', tournamentId)
            .eq('is_final_table', true)
            .single();

        if (!finalTable) {
            const tournament = await this.getTournament(tournamentId);
            if (!tournament) return { finalTableId: null };

            const { data: newTable } = await supabase
                .from('tables')
                .insert({
                    club_id: tournament.club_id,
                    tournament_id: tournamentId,
                    name: `${tournament.name} - Final Table`,
                    game_type: 'tournament',
                    game_variant: 'nlh',
                    stakes: 'Final Table',
                    small_blind: tournament.blind_structure[0].smallBlind,
                    big_blind: tournament.blind_structure[0].bigBlind,
                    min_buy_in: 0,
                    max_buy_in: 0,
                    max_players: 9,
                    status: 'running',
                    settings: { auto_muck: true, time_bank_seconds: 45 }
                })
                .select()
                .single();

            if (newTable) {
                await supabase
                    .from('tournament_tables')
                    .insert({
                        tournament_id: tournamentId,
                        table_number: 0,
                        is_final_table: true,
                    });

                finalTable = { id: newTable.id };
            }
        }

        if (finalTable) {
            // Broadcast final table event
            try {
                const { realtimeChannelService } = await import('./RealtimeChannelService');
                await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
                    type: 'final_table',
                    payload: { tableId: finalTable.id, playerCount: count },
                });
            } catch (e) {
                console.warn('Failed to broadcast final table event:', e);
            }
        }

        return { finalTableId: finalTable?.id || null };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Tournament Lifecycle Events
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Broadcast level up event
     */
    async broadcastLevelUp(tournamentId: string, newLevel: BlindLevel): Promise<void> {
        try {
            const { realtimeChannelService } = await import('./RealtimeChannelService');
            await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
                type: 'level_up',
                payload: {
                    level: newLevel.level,
                    smallBlind: newLevel.smallBlind,
                    bigBlind: newLevel.bigBlind,
                    ante: newLevel.ante,
                },
            });
        } catch (e) {
            console.warn('Failed to broadcast level up:', e);
        }
    }

    /**
     * Broadcast player elimination
     */
    async broadcastElimination(
        tournamentId: string,
        eliminatedPlayer: { id: string; name: string; position: number; prize: number }
    ): Promise<void> {
        try {
            const { realtimeChannelService } = await import('./RealtimeChannelService');
            await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
                type: 'player_eliminated',
                payload: eliminatedPlayer,
            });
        } catch (e) {
            console.warn('Failed to broadcast elimination:', e);
        }
    }

    /**
     * Broadcast tournament winner
     */
    async broadcastWinner(
        tournamentId: string,
        winner: { id: string; name: string; prize: number }
    ): Promise<void> {
        try {
            const { realtimeChannelService } = await import('./RealtimeChannelService');
            await realtimeChannelService.broadcastTournamentEvent(tournamentId, {
                type: 'winner',
                payload: winner,
            });
        } catch (e) {
            console.warn('Failed to broadcast winner:', e);
        }
    }

    /**
     * Finalize tournament (process payouts)
     */
    async finalizeTournament(tournamentId: string): Promise<{ success: boolean }> {
        if (isDemoMode) {
            const tournament = DEMO_TOURNAMENTS.find(t => t.id === tournamentId);
            if (tournament) tournament.status = 'finished';
            return { success: true };
        }

        // Update tournament status
        await supabase
            .from('tournaments')
            .update({
                status: 'finished',
                finished_at: new Date().toISOString(),
            })
            .eq('id', tournamentId);

        // Payouts are processed automatically by the settlement system
        // via the tournament_payouts table populated during eliminations

        return { success: true };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // SPIN & GO
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Spin the multiplier wheel for a Spin & Go
     */
    spinMultiplier(config: SpinMultiplier[]): { multiplier: number; isPremium: boolean } {
        const random = Math.random() * 100;
        let cumulative = 0;

        for (const tier of config) {
            cumulative += tier.probability;
            if (random <= cumulative) {
                return {
                    multiplier: tier.multiplier,
                    isPremium: tier.isPremium || false,
                };
            }
        }

        // Fallback to lowest multiplier
        return { multiplier: config[0].multiplier, isPremium: false };
    }

    /**
     * Create and start a Spin & Go
     */
    async createSpin(clubId: string, buyIn: number, rake: number): Promise<Tournament> {
        const spinResult = this.spinMultiplier(SPIN_MULTIPLIERS.standard);
        const prizePool = (buyIn - rake) * 3 * spinResult.multiplier;

        const config: TournamentConfig = {
            name: `Spin & Go ${buyIn}`,
            type: 'spin',
            buyIn,
            rake,
            startingStack: 500,
            maxPlayers: 3,
            minPlayers: 3,
            blindStructure: SPIN_BLIND_STRUCTURE,
            payoutStructure: [{ place: 1, percentage: 100 }], // Winner takes all
            lateRegistrationLevels: 0,
            isRebuy: false,
            addOnAvailable: false,
            spinConfig: {
                possibleMultipliers: SPIN_MULTIPLIERS.standard,
            },
        };

        const tournament = await this.createTournament(clubId, config);

        // Update with actual prize pool
        if (!isDemoMode) {
            await supabase
                .from('tournaments')
                .update({
                    prize_pool: prizePool,
                    spin_multiplier: spinResult.multiplier,
                    is_premium_spin: spinResult.isPremium,
                })
                .eq('id', tournament.id);
        }

        return { ...tournament, prize_pool: prizePool };
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // BOUNTY TOURNAMENTS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Process bounty collection on elimination
     */
    async collectBounty(
        tournamentId: string,
        eliminatedPlayerId: string,
        collectorPlayerId: string
    ): Promise<{ bountyAmount: number; collectorNewBounty?: number }> {
        const tournament = await this.getTournament(tournamentId);
        if (!tournament) throw new Error('Tournament not found');

        // @ts-ignore - Get bounty config
        const bountyConfig = tournament.bounty_config as BountyConfig | undefined;
        if (!bountyConfig) {
            return { bountyAmount: 0 };
        }

        // Get eliminated player's bounty
        const { data: eliminatedPlayer } = await supabase
            .from('tournament_players')
            .select('current_bounty')
            .eq('tournament_id', tournamentId)
            .eq('user_id', eliminatedPlayerId)
            .single();

        const bountyAmount = eliminatedPlayer?.current_bounty || bountyConfig.baseBounty;

        if (bountyConfig.bountyType === 'progressive') {
            // Progressive: 50% to collector, 50% added to collector's head
            const collectorPortion = Math.floor(bountyAmount / 2);
            const addedToHead = bountyAmount - collectorPortion;

            // Get collector's current bounty
            const { data: collector } = await supabase
                .from('tournament_players')
                .select('current_bounty')
                .eq('tournament_id', tournamentId)
                .eq('user_id', collectorPlayerId)
                .single();

            const newCollectorBounty = (collector?.current_bounty || bountyConfig.baseBounty) + addedToHead;

            // Update collector's bounty
            await supabase
                .from('tournament_players')
                .update({ current_bounty: newCollectorBounty })
                .eq('tournament_id', tournamentId)
                .eq('user_id', collectorPlayerId);

            // Record bounty payout
            await supabase
                .from('tournament_bounties')
                .insert({
                    tournament_id: tournamentId,
                    eliminated_player_id: eliminatedPlayerId,
                    collector_player_id: collectorPlayerId,
                    bounty_amount: collectorPortion,
                    added_to_collector_bounty: addedToHead,
                });

            return { bountyAmount: collectorPortion, collectorNewBounty: newCollectorBounty };
        } else if (bountyConfig.bountyType === 'mystery') {
            // Mystery: Reveal hidden bounty value
            const mysteryValue = this.rollMysteryBounty(bountyConfig);

            await supabase
                .from('tournament_bounties')
                .insert({
                    tournament_id: tournamentId,
                    eliminated_player_id: eliminatedPlayerId,
                    collector_player_id: collectorPlayerId,
                    bounty_amount: mysteryValue,
                    is_mystery_revealed: true,
                });

            return { bountyAmount: mysteryValue };
        } else {
            // Fixed bounty
            await supabase
                .from('tournament_bounties')
                .insert({
                    tournament_id: tournamentId,
                    eliminated_player_id: eliminatedPlayerId,
                    collector_player_id: collectorPlayerId,
                    bounty_amount: bountyAmount,
                });

            return { bountyAmount };
        }
    }

    /**
     * Roll mystery bounty value
     */
    rollMysteryBounty(config: BountyConfig): number {
        if (!config.mysteryTiers) return config.baseBounty;

        const random = Math.random() * 100;
        let cumulative = 0;

        for (const tier of config.mysteryTiers) {
            cumulative += tier.probability;
            if (random <= cumulative) {
                // Random value within the tier range
                const multiplier = tier.minMultiplier === tier.maxMultiplier
                    ? tier.minMultiplier
                    : Math.floor(Math.random() * (tier.maxMultiplier - tier.minMultiplier + 1)) + tier.minMultiplier;
                return config.baseBounty * multiplier;
            }
        }

        return config.baseBounty;
    }

    /**
     * Get total bounties won by a player in a tournament
     */
    async getPlayerBounties(tournamentId: string, playerId: string): Promise<number> {
        if (isDemoMode) return 50;

        const { data, error } = await supabase
            .from('tournament_bounties')
            .select('bounty_amount')
            .eq('tournament_id', tournamentId)
            .eq('collector_player_id', playerId);

        if (error) return 0;
        return (data || []).reduce((sum, b) => sum + b.bounty_amount, 0);
    }
}

export const tournamentService = new TournamentService();

