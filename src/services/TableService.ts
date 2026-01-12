/**
 * ♠ CLUB ARENA — Table Service
 * Manages poker tables and game sessions
 */

import { supabase, isDemoMode, subscribeToTable } from '../lib/supabase';
import type { PokerTable, TableSettings, GameVariant, HandState } from '../types/database.types';

// Demo tables
const DEMO_TABLES: PokerTable[] = [
    {
        id: 'table-1',
        club_id: '1',
        name: 'Table 1 - High Stakes',
        game_type: 'cash',
        game_variant: 'nlh',
        stakes: '5/10',
        small_blind: 5,
        big_blind: 10,
        min_buy_in: 400,
        max_buy_in: 2000,
        max_players: 9,
        current_players: 6,
        status: 'running',
        settings: {
            straddle_enabled: true,
            straddle_type: 'utg',
            run_it_twice: true,
            bomb_pot_enabled: false,
            bomb_pot_frequency: 0,
            bomb_pot_ante_bb: 0,
            time_bank_seconds: 30,
            auto_muck: true,
        },
        created_at: new Date().toISOString(),
    },
    {
        id: 'table-2',
        club_id: '1',
        name: 'Table 2 - PLO Action',
        game_type: 'cash',
        game_variant: 'plo4',
        stakes: '2/5',
        small_blind: 2,
        big_blind: 5,
        min_buy_in: 200,
        max_buy_in: 1000,
        max_players: 6,
        current_players: 5,
        status: 'running',
        settings: {
            straddle_enabled: true,
            straddle_type: 'any_position',
            run_it_twice: true,
            bomb_pot_enabled: true,
            bomb_pot_frequency: 10,
            bomb_pot_ante_bb: 2,
            time_bank_seconds: 45,
            auto_muck: true,
        },
        created_at: new Date().toISOString(),
    },
    {
        id: 'table-3',
        club_id: '1',
        name: 'Beginners NLH',
        game_type: 'cash',
        game_variant: 'nlh',
        stakes: '0.5/1',
        small_blind: 0.5,
        big_blind: 1,
        min_buy_in: 40,
        max_buy_in: 200,
        max_players: 9,
        current_players: 4,
        status: 'running',
        settings: {
            straddle_enabled: false,
            straddle_type: 'utg',
            run_it_twice: false,
            bomb_pot_enabled: false,
            bomb_pot_frequency: 0,
            bomb_pot_ante_bb: 0,
            time_bank_seconds: 60,
            auto_muck: true,
        },
        created_at: new Date().toISOString(),
    },
];

class TableService {
    // ═══════════════════════════════════════════════════════════════════════════════
    // Table Operations
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Get all tables for a club
     */
    async getClubTables(clubId: string): Promise<PokerTable[]> {
        if (isDemoMode) {
            return DEMO_TABLES.filter((t) => t.club_id === clubId);
        }

        const { data, error } = await supabase
            .from('tables')
            .select('*')
            .eq('club_id', clubId)
            .neq('status', 'closed')
            .order('created_at', { ascending: false });

        if (error) throw error;
        return data || [];
    }

    /**
     * Get all active tables in a union
     */
    async getUnionTables(unionId: string): Promise<PokerTable[]> {
        if (isDemoMode) {
            await new Promise(resolve => setTimeout(resolve, 600));
            return [
                ...DEMO_TABLES.map(t => ({ ...t, id: `${t.id}-${unionId}`, club_id: 'c1' })),
                { ...DEMO_TABLES[1], id: `u-tbl-plo`, club_id: 'c2', name: 'Union PLO Action', stakes: '5/10' }
            ];
        }
        return [];
    }

    /**
     * Get a single table
     */
    async getTable(tableId: string): Promise<PokerTable | null> {
        if (isDemoMode) {
            return DEMO_TABLES.find((t) => t.id === tableId) || null;
        }

        const { data, error } = await supabase
            .from('tables')
            .select('*')
            .eq('id', tableId)
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Create a new table
     */
    async createTable(
        clubId: string,
        name: string,
        gameVariant: GameVariant,
        smallBlind: number,
        bigBlind: number,
        maxPlayers: number = 9,
        settings?: Partial<TableSettings>
    ): Promise<PokerTable> {
        const defaultSettings: TableSettings = {
            straddle_enabled: true,
            straddle_type: 'utg',
            run_it_twice: true,
            bomb_pot_enabled: false,
            bomb_pot_frequency: 0,
            bomb_pot_ante_bb: 0,
            time_bank_seconds: 30,
            auto_muck: true,
            ...settings,
        };

        if (isDemoMode) {
            const newTable: PokerTable = {
                id: crypto.randomUUID(),
                club_id: clubId,
                name,
                game_type: 'cash',
                game_variant: gameVariant,
                stakes: `${smallBlind}/${bigBlind}`,
                small_blind: smallBlind,
                big_blind: bigBlind,
                min_buy_in: bigBlind * 40,
                max_buy_in: bigBlind * 200,
                max_players: maxPlayers,
                current_players: 0,
                status: 'waiting',
                settings: defaultSettings,
                created_at: new Date().toISOString(),
            };
            DEMO_TABLES.push(newTable);
            return newTable;
        }

        const { data, error } = await supabase
            .from('tables')
            .insert({
                club_id: clubId,
                name,
                game_type: 'cash',
                game_variant: gameVariant,
                stakes: `${smallBlind}/${bigBlind}`,
                small_blind: smallBlind,
                big_blind: bigBlind,
                min_buy_in: bigBlind * 40,
                max_buy_in: bigBlind * 200,
                max_players: maxPlayers,
                current_players: 0,
                status: 'waiting',
                settings: defaultSettings,
            })
            .select()
            .single();

        if (error) throw error;
        return data;
    }

    /**
     * Update table player count
     */
    async updatePlayerCount(tableId: string, count: number): Promise<void> {
        if (isDemoMode) {
            const table = DEMO_TABLES.find((t) => t.id === tableId);
            if (table) table.current_players = count;
            return;
        }

        await supabase
            .from('tables')
            .update({ current_players: count })
            .eq('id', tableId);
    }

    /**
     * Close a table
     */
    async closeTable(tableId: string): Promise<void> {
        if (isDemoMode) {
            const idx = DEMO_TABLES.findIndex((t) => t.id === tableId);
            if (idx !== -1) DEMO_TABLES.splice(idx, 1);
            return;
        }

        await supabase
            .from('tables')
            .update({ status: 'closed' })
            .eq('id', tableId);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Real-time Subscriptions
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Subscribe to table updates
     */
    subscribeToTable(
        tableId: string,
        callback: (table: PokerTable) => void
    ): () => void {
        if (isDemoMode) {
            // Demo mode: no real-time updates
            return () => { };
        }

        return subscribeToTable<PokerTable>('tables', callback, {
            column: 'id',
            value: tableId,
        });
    }

    /**
     * Subscribe to hand state updates
     */
    subscribeToHand(
        tableId: string,
        callback: (hand: HandState) => void
    ): () => void {
        if (isDemoMode) {
            return () => { };
        }

        return subscribeToTable<HandState>('hand_states', callback, {
            column: 'table_id',
            value: tableId,
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // Statistics
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Get average pot size for a table
     */
    async getAveragePot(tableId: string): Promise<number> {
        if (isDemoMode) {
            return Math.floor(Math.random() * 500) + 50;
        }

        // Would query hand history
        return 250; // Placeholder
    }

    /**
     * Get waiting list count
     */
    async getWaitlistCount(tableId: string): Promise<number> {
        if (isDemoMode) {
            return Math.floor(Math.random() * 5);
        }

        const { count, error } = await supabase
            .from('table_waitlist')
            .select('*', { count: 'exact', head: true })
            .eq('table_id', tableId);

        if (error) return 0;
        return count || 0;
    }
}

export const tableService = new TableService();
