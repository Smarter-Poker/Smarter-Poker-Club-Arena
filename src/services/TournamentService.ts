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

export interface TournamentConfig {
    name: string;
    type: 'sng' | 'mtt' | 'satellite';
    buyIn: number;
    rake: number;
    startingStack: number;
    maxPlayers: number;
    minPlayers: number;
    blindStructure: BlindLevel[];
    payoutStructure: PayoutStructure[];
    lateRegistrationLevels: number;
    startTime?: Date;
    isRebuy: boolean;
    rebuyLevels?: number;
    rebuyChips?: number;
    rebuyCost?: number;
    addOnAvailable: boolean;
    addOnChips?: number;
    addOnCost?: number;
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
}

export const tournamentService = new TournamentService();
