/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🐴 HYDRA SERVICE — Bot Liquidity Fleet Management
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Manages the Hydra bot fleet (300 Horses #101-#400) to ensure 24/7 table liquidity.
 * 
 * LAWS:
 * - "3 Horses to Start": Tables seed with 3 bot players
 * - "Organic Recede": When real player joins, 1 bot leaves after orbit
 * - "Fleet Size": 300 unique sovereign bot IDs (#101-#400)
 * - "Entry Variance": Random 10-90s delays for natural appearance
 * - "Invisible Fleet": Bots are indistinguishable from human players
 * 
 * BOT PROFILES:
 * - FISH: Loose-passive, calls too much (40% of fleet)
 * - REG: Balanced TAG play (30% of fleet)
 * - NIT: Tight-passive, fold equity (15% of fleet)
 * - LAG: Loose-aggressive, wide ranges (10% of fleet)
 * - MANIAC: Ultra-aggressive, high variance (5% of fleet)
 */

import { supabase, isDemoMode } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type BotProfile = 'fish' | 'reg' | 'nit' | 'lag' | 'maniac';
export type BotStatus = 'available' | 'seated' | 'leaving' | 'disabled';

export interface HorsePlayer {
    id: string;
    name: string;
    playerNumber: number;
    avatar: string;
    profile: BotProfile;
    stack: number;
    seatNumber: number;
    status: BotStatus;
    tableId: string;
    joinedAt: string;
    leavingAfterOrbit: boolean;
    handsPlayed: number;
    orbitsPlayed: number;
}

export interface HydraConfig {
    maxHorsesPerTable: number;
    minHorsesPerTable: number;
    fleetSize: number;
    entryDelayRange: [number, number]; // [min, max] in seconds
    organicRecedeEnabled: boolean;
    seatWarmupDelay: number; // ms before bot starts playing
    thinkTimeRange: [number, number]; // [min, max] in ms for action delay
}

export interface TableLiquidityStatus {
    tableId: string;
    realPlayers: number;
    botPlayers: number;
    availableSeats: number;
    needsMoreBots: boolean;
    needsFewerBots: boolean;
}

export interface BotDecision {
    action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
    amount?: number;
    thinkTime: number; // ms to wait before acting
}

export interface HandContext {
    pot: number;
    toCall: number;
    minRaise: number;
    maxRaise: number;
    position: 'early' | 'middle' | 'late' | 'blind';
    street: 'preflop' | 'flop' | 'turn' | 'river';
    playersInHand: number;
    stackToPotRatio: number;
    isHeadsUp: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: HydraConfig = {
    maxHorsesPerTable: 3,
    minHorsesPerTable: 0,
    fleetSize: 300,
    entryDelayRange: [10, 90],
    organicRecedeEnabled: true,
    seatWarmupDelay: 2000,
    thinkTimeRange: [800, 4000],
};

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
    maniac: { fold: 10, check: 10, call: 15, bet: 30, raise: 35 },
};

// Stack size ranges per profile (in BB)
const PROFILE_STACK_RANGES: Record<BotProfile, [number, number]> = {
    fish: [50, 100],
    reg: [80, 150],
    nit: [100, 100],
    lag: [100, 200],
    maniac: [150, 300],
};

// Preflop hand ranges (simplified)
const PREFLOP_RANGES: Record<BotProfile, {
    vpip: number; // Voluntarily Put $ In Pot percentage
    pfr: number; // Pre-Flop Raise percentage
    threeBet: number; // 3-bet percentage
}> = {
    fish: { vpip: 45, pfr: 10, threeBet: 3 },
    reg: { vpip: 22, pfr: 18, threeBet: 8 },
    nit: { vpip: 12, pfr: 10, threeBet: 5 },
    lag: { vpip: 32, pfr: 28, threeBet: 12 },
    maniac: { vpip: 55, pfr: 40, threeBet: 18 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA (Synced with database horses #101-#400)
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_HORSES: HorsePlayer[] = [
    {
        id: 'horse-101', name: 'Alex R.', playerNumber: 101, avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Alex101',
        profile: 'fish', stack: 1000, seatNumber: 2, status: 'seated', tableId: 'table-1',
        joinedAt: new Date(Date.now() - 15 * 60000).toISOString(), leavingAfterOrbit: false, handsPlayed: 42, orbitsPlayed: 5,
    },
    {
        id: 'horse-102', name: 'Jordan S.', playerNumber: 102, avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Jordan102',
        profile: 'reg', stack: 1200, seatNumber: 5, status: 'seated', tableId: 'table-1',
        joinedAt: new Date(Date.now() - 8 * 60000).toISOString(), leavingAfterOrbit: false, handsPlayed: 28, orbitsPlayed: 3,
    },
    {
        id: 'horse-103', name: 'Taylor K.', playerNumber: 103, avatar: 'https://api.dicebear.com/7.x/avataaars/svg?seed=Taylor103',
        profile: 'lag', stack: 1500, seatNumber: 8, status: 'seated', tableId: 'table-1',
        joinedAt: new Date(Date.now() - 22 * 60000).toISOString(), leavingAfterOrbit: true, handsPlayed: 65, orbitsPlayed: 8,
    },
];

// Available horses pool (simulates the 300 fleet)
const AVAILABLE_HORSE_POOL: Array<{ id: string; name: string; playerNumber: number; avatar: string; profile: BotProfile }> = Array.from(
    { length: 50 }, (_, i) => ({
        id: `horse-${101 + i}`,
        name: `Player${101 + i}`,
        playerNumber: 101 + i,
        avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=Horse${101 + i}`,
        profile: (['fish', 'fish', 'reg', 'nit', 'lag'][i % 5]) as BotProfile,
    })
);

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function randomInRange(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getStackForProfile(profile: BotProfile, bigBlind: number): number {
    const [minBB, maxBB] = PROFILE_STACK_RANGES[profile];
    const bbCount = randomInRange(minBB, maxBB);
    return bbCount * bigBlind;
}

function weightedRandom<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as [T, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let random = Math.random() * total;

    for (const [key, weight] of entries) {
        random -= weight;
        if (random <= 0) return key;
    }

    return entries[0][0];
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

    // ─────────────────────────────────────────────────────────────────────────────
    // HORSE FLEET MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get available horses from the fleet (not currently seated)
     */
    async getAvailableHorses(count: number = 3, profile?: BotProfile): Promise<HorsePlayer[]> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            let available = AVAILABLE_HORSE_POOL.filter(h =>
                !DEMO_HORSES.some(dh => dh.id === h.id)
            );
            if (profile) {
                available = available.filter(h => h.profile === profile);
            }
            return available.slice(0, count).map(h => ({
                ...h,
                stack: 0,
                seatNumber: 0,
                status: 'available' as BotStatus,
                tableId: '',
                joinedAt: '',
                leavingAfterOrbit: false,
                handsPlayed: 0,
                orbitsPlayed: 0,
            }));
        }

        const { data, error } = await supabase.rpc('get_available_horses', {
            p_count: count,
            p_profile: profile || null,
        });

        if (error) {
            console.error('HydraService.getAvailableHorses error:', error);
            return [];
        }

        return data.map((h: any) => ({
            id: h.id,
            name: h.display_name,
            playerNumber: h.player_number,
            avatar: h.avatar_url,
            profile: h.horse_profile as BotProfile,
            stack: 0,
            seatNumber: 0,
            status: 'available' as BotStatus,
            tableId: '',
            joinedAt: '',
            leavingAfterOrbit: false,
            handsPlayed: 0,
            orbitsPlayed: 0,
        }));
    },

    /**
     * Get active horses at a table
     */
    async getActiveHorses(tableId: string): Promise<HorsePlayer[]> {
        if (isDemoMode) {
            return DEMO_HORSES.filter(h => h.tableId === tableId);
        }

        const { data, error } = await supabase
            .from('seats')
            .select(`
        seat_number,
        stack,
        status,
        created_at,
        profiles:user_id (
          id,
          display_name,
          player_number,
          avatar_url,
          is_horse,
          horse_profile,
          horse_status
        )
      `)
            .eq('table_id', tableId)
            .eq('profiles.is_horse', true);

        if (error) {
            console.error('HydraService.getActiveHorses error:', error);
            return [];
        }

        return (data || []).map((seat: any) => ({
            id: seat.profiles.id,
            name: seat.profiles.display_name,
            playerNumber: seat.profiles.player_number,
            avatar: seat.profiles.avatar_url || '',
            profile: seat.profiles.horse_profile || 'reg',
            stack: seat.stack,
            seatNumber: seat.seat_number,
            status: seat.profiles.horse_status || 'seated',
            tableId,
            joinedAt: seat.created_at,
            leavingAfterOrbit: seat.profiles.horse_status === 'leaving',
            handsPlayed: 0,
            orbitsPlayed: 0,
        }));
    },

    /**
     * Assess table liquidity status
     */
    async getTableLiquidityStatus(tableId: string): Promise<TableLiquidityStatus> {
        const horses = await this.getActiveHorses(tableId);

        if (isDemoMode) {
            const totalPlayers = horses.length + 2; // Assume 2 real players
            return {
                tableId,
                realPlayers: 2,
                botPlayers: horses.length,
                availableSeats: 9 - totalPlayers,
                needsMoreBots: horses.length < this.config.maxHorsesPerTable && totalPlayers < 5,
                needsFewerBots: horses.length > 0 && totalPlayers >= 6,
            };
        }

        const { data: seats, error } = await supabase
            .from('seats')
            .select('user_id, profiles:user_id(is_horse)')
            .eq('table_id', tableId);

        if (error) {
            console.error('HydraService.getTableLiquidityStatus error:', error);
            return {
                tableId,
                realPlayers: 0,
                botPlayers: horses.length,
                availableSeats: 9,
                needsMoreBots: true,
                needsFewerBots: false,
            };
        }

        const totalPlayers = seats?.length || 0;
        const botPlayers = horses.length;
        const realPlayers = totalPlayers - botPlayers;
        const availableSeats = 9 - totalPlayers;

        return {
            tableId,
            realPlayers,
            botPlayers,
            availableSeats,
            needsMoreBots: botPlayers < this.config.maxHorsesPerTable && realPlayers < 3,
            needsFewerBots: realPlayers >= 3 && botPlayers > 0,
        };
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // TABLE SEEDING & RECEDING
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Seed a table with bot players (3 Horses to Start law)
     */
    async seedTable(tableId: string, bigBlind: number = 2): Promise<HorsePlayer[]> {
        const status = await this.getTableLiquidityStatus(tableId);
        const horsesToAdd = this.config.maxHorsesPerTable - status.botPlayers;

        if (horsesToAdd <= 0) {
            console.log('🐴 Table already has enough horses');
            return [];
        }

        console.log(`🐴 Seeding table with ${horsesToAdd} horses...`);
        const availableHorses = await this.getAvailableHorses(horsesToAdd);
        const seatedHorses: HorsePlayer[] = [];

        for (let i = 0; i < Math.min(horsesToAdd, availableHorses.length); i++) {
            const horse = availableHorses[i];
            const delay = randomInRange(
                this.config.entryDelayRange[0] * 1000,
                this.config.entryDelayRange[1] * 1000
            );

            // Stagger entries for natural appearance
            setTimeout(async () => {
                try {
                    const seatedHorse = await this.seatHorse(horse.id, tableId, bigBlind);
                    if (seatedHorse) {
                        seatedHorses.push(seatedHorse);
                        console.log(`🐴 Horse #${seatedHorse.playerNumber} (${seatedHorse.profile}) joined seat ${seatedHorse.seatNumber}`);
                    }
                } catch (err) {
                    console.error(`Failed to seat horse ${horse.id}:`, err);
                }
            }, delay * (i + 1));
        }

        return seatedHorses;
    },

    /**
     * Seat a specific horse at a table
     */
    async seatHorse(horseId: string, tableId: string, bigBlind: number): Promise<HorsePlayer | null> {
        if (isDemoMode) {
            const poolHorse = AVAILABLE_HORSE_POOL.find(h => h.id === horseId);
            if (!poolHorse) return null;

            const stack = getStackForProfile(poolHorse.profile, bigBlind);
            const seatNumber = randomInRange(1, 9);

            const horse: HorsePlayer = {
                ...poolHorse,
                stack,
                seatNumber,
                status: 'seated',
                tableId,
                joinedAt: new Date().toISOString(),
                leavingAfterOrbit: false,
                handsPlayed: 0,
                orbitsPlayed: 0,
            };

            DEMO_HORSES.push(horse);
            return horse;
        }

        // Get horse info
        const { data: horseData } = await supabase
            .from('profiles')
            .select('id, display_name, player_number, avatar_url, horse_profile')
            .eq('id', horseId)
            .eq('is_horse', true)
            .single();

        if (!horseData) return null;

        const stack = getStackForProfile(horseData.horse_profile as BotProfile, bigBlind);

        // Seat the horse using RPC
        const { data, error } = await supabase.rpc('seat_horse', {
            p_horse_id: horseId,
            p_table_id: tableId,
            p_seat_number: 0, // RPC will find available seat
            p_buy_in: stack,
        });

        if (error) {
            console.error('HydraService.seatHorse error:', error);
            return null;
        }

        return {
            id: horseData.id,
            name: horseData.display_name,
            playerNumber: horseData.player_number,
            avatar: horseData.avatar_url,
            profile: horseData.horse_profile as BotProfile,
            stack,
            seatNumber: data.seat_number,
            status: 'seated',
            tableId,
            joinedAt: new Date().toISOString(),
            leavingAfterOrbit: false,
            handsPlayed: 0,
            orbitsPlayed: 0,
        };
    },

    /**
     * Schedule horse for removal (Organic Recede law)
     */
    async scheduleHorseRemoval(tableId: string, horseId: string, triggeredBy?: string): Promise<void> {
        const horses = await this.getActiveHorses(tableId);
        const horse = horses.find(h => h.id === horseId);

        if (!horse) {
            console.warn('Horse not found for removal:', horseId);
            return;
        }

        horse.leavingAfterOrbit = true;
        console.log(`🐴 Horse #${horse.playerNumber} scheduled to leave after current orbit`);

        if (!isDemoMode) {
            await supabase.rpc('schedule_horse_leave', {
                p_horse_id: horseId,
                p_triggered_by: triggeredBy || null,
            });
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
                console.log(`🐴 Horse #${horse.playerNumber} left the table after ${horse.handsPlayed} hands`);
                return true;
            }
            return false;
        }

        const { error } = await supabase.rpc('remove_horse', {
            p_horse_id: horseId,
            p_table_id: tableId,
        });

        if (error) {
            console.error('HydraService.removeHorse error:', error);
            return false;
        }

        return true;
    },

    /**
     * Handle real player joining (trigger organic recede)
     */
    async onRealPlayerJoined(tableId: string, playerId: string): Promise<void> {
        if (!this.config.organicRecedeEnabled) return;

        const status = await this.getTableLiquidityStatus(tableId);

        // If we have bots and enough real players, schedule one to leave
        if (status.needsFewerBots && status.botPlayers > 0) {
            const horses = await this.getActiveHorses(tableId);
            const horseToRemove = horses.find(h => !h.leavingAfterOrbit);

            if (horseToRemove) {
                await this.scheduleHorseRemoval(tableId, horseToRemove.id, playerId);
            }
        }
    },

    /**
     * Handle real player leaving (potentially reseed)
     */
    async onRealPlayerLeft(tableId: string, bigBlind: number): Promise<void> {
        const status = await this.getTableLiquidityStatus(tableId);

        if (status.needsMoreBots) {
            const delay = randomInRange(
                this.config.entryDelayRange[0] * 1000,
                this.config.entryDelayRange[1] * 1000
            );

            setTimeout(() => {
                this.seedTable(tableId, bigBlind);
            }, delay);
        }
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // BOT DECISION MAKING (Poker AI)
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get action decision for a bot
     */
    getDecision(horse: HorsePlayer, context: HandContext): BotDecision {
        const weights = this.getAdjustedWeights(horse.profile, context);
        const baseAction = weightedRandom(weights);

        // Calculate think time (varies by profile and situation)
        const [minThink, maxThink] = this.config.thinkTimeRange;
        let thinkTime = randomInRange(minThink, maxThink);

        // Adjust think time based on situation
        if (context.isHeadsUp) thinkTime *= 0.7; // Faster heads up
        if (context.street === 'river') thinkTime *= 1.3; // Slower on river
        if (horse.profile === 'maniac') thinkTime *= 0.6; // Maniacs act fast
        if (horse.profile === 'nit') thinkTime *= 1.2; // Nits take time

        // Determine final action and amount
        let action = baseAction as BotDecision['action'];
        let amount: number | undefined;

        // Convert bet/raise to specific amounts
        if (action === 'bet' || action === 'raise') {
            amount = this.getBetSize(horse.profile, context);

            // Check if we should just go all-in
            if (amount >= horse.stack * 0.9) {
                action = 'allin';
                amount = horse.stack;
            }
        }

        // Handle invalid actions
        if (action === 'check' && context.toCall > 0) {
            action = weightedRandom({ fold: 50, call: 50 }) as 'fold' | 'call';
        }
        if (action === 'bet' && context.toCall > 0) {
            action = 'raise';
        }
        if (action === 'call') {
            amount = context.toCall;
        }

        return { action, amount, thinkTime: Math.round(thinkTime) };
    },

    /**
   * Adjust action weights based on context
   */
    getAdjustedWeights(profile: BotProfile, context: HandContext): Record<string, number> {
        const base: Record<string, number> = { ...PROFILE_WEIGHTS[profile] };

        // Positional adjustments
        if (context.position === 'late') {
            base.raise *= 1.3;
            base.bet *= 1.2;
            base.fold *= 0.8;
        } else if (context.position === 'early') {
            base.fold *= 1.2;
            base.raise *= 0.8;
        }

        // Street adjustments
        if (context.street === 'preflop') {
            base.call *= 1.2;
        } else if (context.street === 'river') {
            base.bet *= 1.1;
            base.raise *= 1.2;
        }

        // Pot odds adjustments
        if (context.stackToPotRatio < 3) {
            base.allin = (base.allin || 0) + 15;
            base.raise *= 1.3;
        }

        // Heads up adjustments
        if (context.isHeadsUp) {
            base.fold *= 0.7;
            base.raise *= 1.2;
            base.bet *= 1.2;
        }

        return base;
    },

    /**
     * Calculate bet sizing for a bot
     */
    getBetSize(profile: BotProfile, context: HandContext): number {
        const { pot, minRaise, maxRaise } = context;

        const sizingFactors: Record<BotProfile, [number, number]> = {
            fish: [0.3, 1.0],   // Small to pot
            reg: [0.5, 0.75],   // Standard sizing
            nit: [0.5, 0.65],   // Conservative
            lag: [0.75, 1.5],   // Overbet capable
            maniac: [1.0, 2.0], // Big overbets
        };

        const [minFactor, maxFactor] = sizingFactors[profile];
        const targetSize = pot * (minFactor + Math.random() * (maxFactor - minFactor));

        return Math.max(minRaise, Math.min(maxRaise, Math.round(targetSize)));
    },

    /**
     * Determine if bot should enter pot preflop
     */
    shouldEnterPot(profile: BotProfile, position: string): boolean {
        const ranges = PREFLOP_RANGES[profile];
        const roll = Math.random() * 100;

        // Positional adjustment
        let vpipAdjustment = 0;
        if (position === 'late') vpipAdjustment = 10;
        if (position === 'blind') vpipAdjustment = 5;
        if (position === 'early') vpipAdjustment = -5;

        return roll < (ranges.vpip + vpipAdjustment);
    },

    /**
     * Get action weights (for external use)
     */
    getActionWeights(profile: BotProfile): typeof PROFILE_WEIGHTS.fish {
        return PROFILE_WEIGHTS[profile];
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // STATISTICS & MONITORING
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get fleet statistics
     */
    async getFleetStats(): Promise<{
        totalHorses: number;
        available: number;
        seated: number;
        leaving: number;
        byProfile: Record<BotProfile, number>;
    }> {
        if (isDemoMode) {
            return {
                totalHorses: 300,
                available: 297 - DEMO_HORSES.length,
                seated: DEMO_HORSES.filter(h => h.status === 'seated').length,
                leaving: DEMO_HORSES.filter(h => h.leavingAfterOrbit).length,
                byProfile: {
                    fish: 120,
                    reg: 90,
                    nit: 45,
                    lag: 30,
                    maniac: 15,
                },
            };
        }

        const { data, error } = await supabase
            .from('profiles')
            .select('horse_status, horse_profile')
            .eq('is_horse', true);

        if (error) {
            console.error('HydraService.getFleetStats error:', error);
            return { totalHorses: 0, available: 0, seated: 0, leaving: 0, byProfile: { fish: 0, reg: 0, nit: 0, lag: 0, maniac: 0 } };
        }

        const stats = {
            totalHorses: data.length,
            available: data.filter(h => h.horse_status === 'available').length,
            seated: data.filter(h => h.horse_status === 'seated').length,
            leaving: data.filter(h => h.horse_status === 'leaving').length,
            byProfile: {
                fish: data.filter(h => h.horse_profile === 'fish').length,
                reg: data.filter(h => h.horse_profile === 'reg').length,
                nit: data.filter(h => h.horse_profile === 'nit').length,
                lag: data.filter(h => h.horse_profile === 'lag').length,
                maniac: data.filter(h => h.horse_profile === 'maniac').length,
            },
        };

        return stats;
    },
};

export default HydraService;
