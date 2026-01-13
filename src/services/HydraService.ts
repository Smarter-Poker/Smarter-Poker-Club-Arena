/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🐴 HYDRA SERVICE — Bot Liquidity Fleet Management
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Manages the Hydra bot fleet to ensure 24/7 table liquidity:
 * 
 * LAWS:
 * - "3 Horses to Start": Tables seed with 3 bot players
 * - "Organic Recede": When real player joins, 1 bot leaves after orbit
 * - "Fleet Size": 300 unique sovereign bot IDs
 * - "Entry Variance": Random 10-90s delays for natural appearance
 * 
 * BOT PROFILES:
 * - FISH: Loose-passive, calls too much
 * - REG: Balanced TAG play
 * - NIT: Tight-passive, fold equity
 * - LAG: Loose-aggressive, wide ranges
 */

import { supabase, isDemoMode } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type BotProfile = 'fish' | 'reg' | 'nit' | 'lag';
export type BotStatus = 'idle' | 'seated' | 'leaving' | 'banned';

export interface HorsePlayer {
    id: string;
    name: string;
    avatar: string;
    profile: BotProfile;
    stack: number;
    seatNumber: number;
    status: BotStatus;
    tableId: string;
    joinedAt: string;
    leavingAfterOrbit: boolean;
}

export interface HydraConfig {
    maxHorsesPerTable: number;
    minHorsesPerTable: number;
    fleetSize: number;
    entryDelayRange: [number, number]; // [min, max] in seconds
    orgaincRecedeEnabled: boolean;
    seatWarmupDelay: number; // ms before bot starts playing
}

export interface TableLiquidityStatus {
    tableId: string;
    realPlayers: number;
    botPlayers: number;
    availableSeats: number;
    needsMoreBots: boolean;
    needsFewerBots: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: HydraConfig = {
    maxHorsesPerTable: 3,
    minHorsesPerTable: 0,
    fleetSize: 300,
    entryDelayRange: [10, 90],
    orgaincRecedeEnabled: true,
    seatWarmupDelay: 2000,
};

// Bot name pools for realistic appearance
const BOT_NAME_PREFIXES = [
    'Ace', 'King', 'River', 'Lucky', 'Card', 'Poker', 'Chip', 'Stack',
    'Bluff', 'Fold', 'All', 'High', 'Low', 'Pro', 'Shark', 'Fish',
];

const BOT_NAME_SUFFIXES = [
    'Master', 'King', 'Queen', 'Hunter', 'Player', 'Grinder', 'Star', 'Pro',
    '99', '42', 'XL', 'Jr', 'Sr', 'Max', 'Min', 'Top',
];

// Profile action weights (probabilities)
const PROFILE_WEIGHTS: Record<BotProfile, {
    fold: number;
    check: number;
    call: number;
    bet: number;
    raise: number;
}> = {
    fish: { fold: 15, check: 20, call: 40, bet: 15, raise: 10 },
    reg: { fold: 30, check: 25, call: 20, bet: 15, raise: 10 },
    nit: { fold: 50, check: 25, call: 15, bet: 5, raise: 5 },
    lag: { fold: 20, check: 15, call: 15, bet: 25, raise: 25 },
};

// Stack size ranges per profile
const PROFILE_STACK_RANGES: Record<BotProfile, [number, number]> = {
    fish: [50, 100],   // Min buy-in to 100bb
    reg: [80, 150],   // Standard to deep
    nit: [100, 100],  // Always 100bb exactly
    lag: [100, 200],  // Deep stacked
};

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_HORSES: HorsePlayer[] = [
    {
        id: 'bot-1',
        name: 'AceHunter42',
        avatar: '',
        profile: 'reg',
        stack: 1000,
        seatNumber: 2,
        status: 'seated',
        tableId: 'table-1',
        joinedAt: new Date(Date.now() - 15 * 60000).toISOString(),
        leavingAfterOrbit: false,
    },
    {
        id: 'bot-2',
        name: 'ChipMasterPro',
        avatar: '',
        profile: 'fish',
        stack: 750,
        seatNumber: 5,
        status: 'seated',
        tableId: 'table-1',
        joinedAt: new Date(Date.now() - 8 * 60000).toISOString(),
        leavingAfterOrbit: false,
    },
    {
        id: 'bot-3',
        name: 'BluffKing99',
        avatar: '',
        profile: 'lag',
        stack: 1500,
        seatNumber: 8,
        status: 'seated',
        tableId: 'table-1',
        joinedAt: new Date(Date.now() - 22 * 60000).toISOString(),
        leavingAfterOrbit: true,
    },
];

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function generateBotName(): string {
    const prefix = BOT_NAME_PREFIXES[Math.floor(Math.random() * BOT_NAME_PREFIXES.length)];
    const suffix = BOT_NAME_SUFFIXES[Math.floor(Math.random() * BOT_NAME_SUFFIXES.length)];
    return `${prefix}${suffix}`;
}

function randomInRange(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function selectRandomProfile(): BotProfile {
    const profiles: BotProfile[] = ['fish', 'reg', 'nit', 'lag'];
    const weights = [40, 30, 15, 15]; // Fish are most common
    const total = weights.reduce((a, b) => a + b, 0);
    let random = Math.random() * total;

    for (let i = 0; i < profiles.length; i++) {
        random -= weights[i];
        if (random <= 0) return profiles[i];
    }

    return 'reg';
}

function getStackForProfile(profile: BotProfile, bigBlind: number): number {
    const [minBB, maxBB] = PROFILE_STACK_RANGES[profile];
    const bbCount = randomInRange(minBB, maxBB);
    return bbCount * bigBlind;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const HydraService = {
    config: { ...DEFAULT_CONFIG },

    /**
     * Initialize Hydra with custom config
     */
    initialize(customConfig: Partial<HydraConfig> = {}): void {
        this.config = { ...DEFAULT_CONFIG, ...customConfig };
        console.log('🐴 Hydra Service initialized', this.config);
    },

    /**
     * Get active horses at a table
     */
    async getActiveHorses(tableId: string): Promise<HorsePlayer[]> {
        if (isDemoMode) {
            return DEMO_HORSES.filter(h => h.tableId === tableId);
        }

        const { data, error } = await supabase
            .from('table_seats')
            .select(`
        seat_number,
        stack,
        status,
        created_at,
        profiles:user_id (
          id,
          username,
          avatar_url,
          is_bot,
          bot_profile
        )
      `)
            .eq('table_id', tableId)
            .eq('profiles.is_bot', true);

        if (error) {
            console.error('HydraService.getActiveHorses error:', error);
            return [];
        }

        return (data || []).map((seat: any) => ({
            id: seat.profiles.id,
            name: seat.profiles.username,
            avatar: seat.profiles.avatar_url || '',
            profile: seat.profiles.bot_profile || 'reg',
            stack: seat.stack,
            seatNumber: seat.seat_number,
            status: 'seated' as BotStatus,
            tableId,
            joinedAt: seat.created_at,
            leavingAfterOrbit: false,
        }));
    },

    /**
     * Assess table liquidity status
     */
    async getTableLiquidityStatus(tableId: string): Promise<TableLiquidityStatus> {
        const horses = await this.getActiveHorses(tableId);

        // Get total players at table
        const { data: seats, error } = await supabase
            .from('table_seats')
            .select('user_id, profiles:user_id(is_bot)')
            .eq('table_id', tableId);

        if (error) {
            console.error('HydraService.getTableLiquidityStatus error:', error);
            return {
                tableId,
                realPlayers: 0,
                botPlayers: horses.length,
                availableSeats: 10,
                needsMoreBots: true,
                needsFewerBots: false,
            };
        }

        const totalPlayers = seats?.length || 0;
        const botPlayers = horses.length;
        const realPlayers = totalPlayers - botPlayers;
        const availableSeats = 10 - totalPlayers;

        return {
            tableId,
            realPlayers,
            botPlayers,
            availableSeats,
            needsMoreBots: botPlayers < this.config.maxHorsesPerTable && realPlayers < 3,
            needsFewerBots: realPlayers >= 3 && botPlayers > 0,
        };
    },

    /**
     * Seed a table with bot players (3 Horses to Start law)
     */
    async seedTable(tableId: string, bigBlind: number = 2): Promise<HorsePlayer[]> {
        const status = await this.getTableLiquidityStatus(tableId);
        const horsesToAdd = this.config.maxHorsesPerTable - status.botPlayers;

        if (horsesToAdd <= 0) {
            console.log('Table already has enough horses');
            return [];
        }

        const newHorses: HorsePlayer[] = [];

        for (let i = 0; i < horsesToAdd; i++) {
            const delay = randomInRange(
                this.config.entryDelayRange[0] * 1000,
                this.config.entryDelayRange[1] * 1000
            );

            // Schedule bot entry with random delay
            setTimeout(async () => {
                const horse = await this.addHorse(tableId, bigBlind);
                if (horse) {
                    newHorses.push(horse);
                    console.log(`🐴 Horse ${horse.name} (${horse.profile}) joined table after ${delay / 1000}s delay`);
                }
            }, delay * (i + 1)); // Stagger entries
        }

        return newHorses;
    },

    /**
     * Add a single horse to a table
     */
    async addHorse(tableId: string, bigBlind: number): Promise<HorsePlayer | null> {
        const profile = selectRandomProfile();
        const stack = getStackForProfile(profile, bigBlind);
        const name = generateBotName();

        if (isDemoMode) {
            const horse: HorsePlayer = {
                id: `bot-${Date.now()}`,
                name,
                avatar: '',
                profile,
                stack,
                seatNumber: randomInRange(1, 10),
                status: 'seated',
                tableId,
                joinedAt: new Date().toISOString(),
                leavingAfterOrbit: false,
            };
            DEMO_HORSES.push(horse);
            return horse;
        }

        // In production, would call RPC to:
        // 1. Get/create bot profile from fleet
        // 2. Reserve available seat
        // 3. Create table_seat record

        const { data, error } = await supabase.rpc('hydra_add_horse', {
            p_table_id: tableId,
            p_profile: profile,
            p_stack: stack,
            p_name: name,
        });

        if (error) {
            console.error('HydraService.addHorse error:', error);
            return null;
        }

        return data;
    },

    /**
     * Schedule horse for removal (Organic Recede law)
     * Horse completes current orbit before leaving
     */
    async scheduleHorseRemoval(tableId: string, horseId: string): Promise<void> {
        const horses = await this.getActiveHorses(tableId);
        const horse = horses.find(h => h.id === horseId);

        if (!horse) {
            console.warn('Horse not found for removal:', horseId);
            return;
        }

        // Mark horse for removal after orbit
        horse.leavingAfterOrbit = true;
        console.log(`🐴 Horse ${horse.name} scheduled to leave after current orbit`);

        if (!isDemoMode) {
            await supabase
                .from('table_seats')
                .update({ leaving_after_orbit: true })
                .eq('table_id', tableId)
                .eq('user_id', horseId);
        }
    },

    /**
     * Remove a horse from table (called after orbit completes)
     */
    async removeHorse(tableId: string, horseId: string): Promise<boolean> {
        if (isDemoMode) {
            const index = DEMO_HORSES.findIndex(h => h.id === horseId);
            if (index !== -1) {
                const horse = DEMO_HORSES[index];
                DEMO_HORSES.splice(index, 1);
                console.log(`🐴 Horse ${horse.name} left the table`);
                return true;
            }
            return false;
        }

        const { error } = await supabase
            .from('table_seats')
            .delete()
            .eq('table_id', tableId)
            .eq('user_id', horseId);

        if (error) {
            console.error('HydraService.removeHorse error:', error);
            return false;
        }

        return true;
    },

    /**
     * Handle real player joining (trigger organic recede)
     */
    async onRealPlayerJoined(tableId: string): Promise<void> {
        if (!this.config.orgaincRecedeEnabled) return;

        const status = await this.getTableLiquidityStatus(tableId);

        // If we have bots and enough real players, schedule one to leave
        if (status.needsFewerBots && status.botPlayers > 0) {
            const horses = await this.getActiveHorses(tableId);
            const horseToRemove = horses.find(h => !h.leavingAfterOrbit);

            if (horseToRemove) {
                await this.scheduleHorseRemoval(tableId, horseToRemove.id);
            }
        }
    },

    /**
     * Handle real player leaving (potentially reseed)
     */
    async onRealPlayerLeft(tableId: string, bigBlind: number): Promise<void> {
        const status = await this.getTableLiquidityStatus(tableId);

        // If table needs more action, add a horse
        if (status.needsMoreBots) {
            const delay = randomInRange(
                this.config.entryDelayRange[0] * 1000,
                this.config.entryDelayRange[1] * 1000
            );

            setTimeout(() => {
                this.addHorse(tableId, bigBlind);
            }, delay);
        }
    },

    /**
     * Get action decision for a bot (used by BotLogic)
     */
    getActionWeights(profile: BotProfile): typeof PROFILE_WEIGHTS.fish {
        return PROFILE_WEIGHTS[profile];
    },

    /**
     * Calculate bet sizing for a bot
     */
    getBetSize(
        profile: BotProfile,
        potSize: number,
        minBet: number,
        maxBet: number
    ): number {
        const sizingFactors: Record<BotProfile, [number, number]> = {
            fish: [0.3, 1.0],   // Small to pot
            reg: [0.5, 0.75],  // Standard sizing
            nit: [0.5, 0.65],  // Conservative
            lag: [0.75, 1.5],  // Overbet capable
        };

        const [minFactor, maxFactor] = sizingFactors[profile];
        const targetSize = potSize * randomInRange(minFactor * 100, maxFactor * 100) / 100;

        return Math.max(minBet, Math.min(maxBet, Math.round(targetSize)));
    },
};

export default HydraService;
