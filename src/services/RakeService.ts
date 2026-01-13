import { supabase, isDemoMode } from '../lib/supabase';
import { BBJService } from './BBJService';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💰 RAKE WATERFALL ENGINE
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Complete rake management implementing the financial laws:
 * 
 * LOCKED SCALING LAWS (Hard Law):
 * - 10% Rake Law: Flat 10.00% of Total Pot (No Flop, No Drop)
 * - 2.5x Cap Law: Rake Cap = Big Blind × 2.5
 * - 0.5x BBJ Law: BBJ Drop = Big Blind × 0.5
 * 
 * WATERFALL FLOW:
 * 1. Calculate Rake & BBJ from pot
 * 2. Execute Pot Drops (RPC)
 * 3. Attribute Rake to Dealt-In Players
 * 4. Queue Commission Credits → Monday Settlement
 * 
 * CORE LAWS:
 * 1. Rake is taken from Pot
 * 2. Rake is split EVENLY among DEALT-IN players
 * 3. Sitting Out = ZERO Credit
 * 4. No Flop = No Drop
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RakeCalculation {
    potSize: number;
    bigBlind: number;
    rakePercent: number;
    rawRake: number;
    cappedRake: number;
    rakeCap: number;
    bbjDrop: number;
    totalDeduction: number;
    netPot: number;
}

export interface RakeAttribution {
    userId: string;
    tableId: string;
    handId: string;
    rakeCredit: number;
    timestamp: string;
}

export interface WaterfallResult {
    handId: string;
    tableId: string;
    calculation: RakeCalculation;
    attributions: RakeAttribution[];
    bbjContributed: boolean;
    commissionsQueued: boolean;
}

export interface DealtInPlayer {
    userId: string;
    agentId?: string;
    clubId: string;
    isSittingOut: boolean;
    hasCards: boolean;
    wentToFlop: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS (HARD LAWS - DO NOT MODIFY)
// ═══════════════════════════════════════════════════════════════════════════════

const RAKE_LAWS = {
    RAKE_PERCENT: 0.10,        // 10% of pot
    CAP_MULTIPLIER: 2.5,       // Rake cap = BB × 2.5
    BBJ_MULTIPLIER: 0.5,       // BBJ drop = BB × 0.5
    TOURNAMENT_RAKE: 0.10,     // Flat 10% on tournament buy-ins
    MIN_POT_FOR_RAKE: 0,       // Minimum pot size to take rake
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const RakeService = {
    /**
     * CALCULATE RAKE & BBJ
     * Implements the Locked Scaling Laws
     */
    calculateRake(potSize: number, bigBlind: number, wentToFlop: boolean = true): RakeCalculation {
        // NO FLOP, NO DROP rule
        if (!wentToFlop) {
            return {
                potSize,
                bigBlind,
                rakePercent: RAKE_LAWS.RAKE_PERCENT,
                rawRake: 0,
                cappedRake: 0,
                rakeCap: bigBlind * RAKE_LAWS.CAP_MULTIPLIER,
                bbjDrop: 0,
                totalDeduction: 0,
                netPot: potSize,
            };
        }

        // Calculate raw rake (10% of pot)
        const rawRake = potSize * RAKE_LAWS.RAKE_PERCENT;

        // Apply cap (2.5x BB)
        const rakeCap = bigBlind * RAKE_LAWS.CAP_MULTIPLIER;
        const cappedRake = Math.min(rawRake, rakeCap);

        // Calculate BBJ drop (0.5x BB)
        const bbjDrop = bigBlind * RAKE_LAWS.BBJ_MULTIPLIER;

        // Total deduction from pot
        const totalDeduction = cappedRake + bbjDrop;

        return {
            potSize,
            bigBlind,
            rakePercent: RAKE_LAWS.RAKE_PERCENT,
            rawRake,
            cappedRake,
            rakeCap,
            bbjDrop,
            totalDeduction,
            netPot: potSize - totalDeduction,
        };
    },

    /**
     * EXECUTE WATERFALL
     * Main entry point - orchestrates the full rake flow
     */
    async executeWaterfall(params: {
        handId: string;
        tableId: string;
        clubId: string;
        unionId?: string;
        potSize: number;
        bigBlind: number;
        wentToFlop: boolean;
        players: DealtInPlayer[];
    }): Promise<WaterfallResult> {
        const { handId, tableId, clubId, unionId, potSize, bigBlind, wentToFlop, players } = params;

        // STEP 1: Calculate rake and BBJ
        const calculation = this.calculateRake(potSize, bigBlind, wentToFlop);

        // STEP 2: Execute pot drops (if there's rake to take)
        if (calculation.cappedRake > 0) {
            await this.executePotDrops({
                handId,
                tableId,
                clubId,
                unionId,
                rakeAmount: calculation.cappedRake,
                bbjAmount: calculation.bbjDrop,
            });
        }

        // STEP 3: Attribute rake to dealt-in players
        const attributions = await this.distributeHandRake(
            tableId,
            handId,
            calculation.cappedRake,
            players
        );

        // STEP 4: Queue commission credits
        let commissionsQueued = false;
        if (calculation.cappedRake > 0 && attributions.length > 0) {
            commissionsQueued = await this.queueCommissionCredits({
                handId,
                clubId,
                rakeAmount: calculation.cappedRake,
                players: players.filter(p => !p.isSittingOut && p.hasCards),
            });
        }

        // STEP 5: Record BBJ contribution
        let bbjContributed = false;
        if (calculation.bbjDrop > 0) {
            const pool = await BBJService.getPool({ unionId, clubId });
            if (pool) {
                await BBJService.recordContribution({
                    poolId: pool.id,
                    handId,
                    tableId,
                    bigBlind,
                    currentMainBalance: pool.main_balance,
                });
                bbjContributed = true;
            }
        }

        return {
            handId,
            tableId,
            calculation,
            attributions,
            bbjContributed,
            commissionsQueued,
        };
    },

    /**
     * EXECUTE POT DROPS
     * Atomically deduct rake and BBJ from pot
     */
    async executePotDrops(params: {
        handId: string;
        tableId: string;
        clubId: string;
        unionId?: string;
        rakeAmount: number;
        bbjAmount: number;
    }): Promise<boolean> {
        if (isDemoMode) {
            console.log('💰 Pot Drops (Demo):', {
                rake: params.rakeAmount.toFixed(2),
                bbj: params.bbjAmount.toFixed(2),
            });
            return true;
        }

        const { error } = await supabase.rpc('execute_pot_drops', {
            p_hand_id: params.handId,
            p_table_id: params.tableId,
            p_club_id: params.clubId,
            p_union_id: params.unionId,
            p_rake_amount: params.rakeAmount,
            p_bbj_amount: params.bbjAmount,
        });

        if (error) {
            console.error('RakeService.executePotDrops error:', error);
            return false;
        }

        return true;
    },

    /**
     * DISTRIBUTE RAKE CREDIT
     * Split rake evenly among dealt-in players
     */
    async distributeHandRake(
        tableId: string,
        handId: string,
        totalRake: number,
        players: DealtInPlayer[]
    ): Promise<RakeAttribution[]> {
        // Filter to active players only
        const activePlayers = players.filter(p => !p.isSittingOut && p.hasCards);

        if (activePlayers.length === 0 || totalRake === 0) {
            return [];
        }

        // Calculate equal split
        const creditPerPlayer = totalRake / activePlayers.length;
        const timestamp = new Date().toISOString();

        // Build attribution records
        const attributions: RakeAttribution[] = activePlayers.map(p => ({
            userId: p.userId,
            tableId,
            handId,
            rakeCredit: creditPerPlayer,
            timestamp,
        }));

        if (isDemoMode) {
            console.log('💰 Rake Attribution (Demo):', {
                totalRake: totalRake.toFixed(2),
                players: activePlayers.length,
                perPlayer: creditPerPlayer.toFixed(2),
            });
            return attributions;
        }

        // Persist attributions to database
        const { error } = await supabase.from('rake_credits').insert(
            attributions.map(a => ({
                user_id: a.userId,
                table_id: a.tableId,
                hand_id: a.handId,
                amount: a.rakeCredit,
                created_at: a.timestamp,
            }))
        );

        if (error) {
            console.error('RakeService.distributeHandRake error:', error);
        }

        return attributions;
    },

    /**
     * QUEUE COMMISSION CREDITS
     * Stage rake credits for Monday settlement payout
     */
    async queueCommissionCredits(params: {
        handId: string;
        clubId: string;
        rakeAmount: number;
        players: DealtInPlayer[];
    }): Promise<boolean> {
        if (isDemoMode) {
            console.log('💰 Commission Queue (Demo):', {
                handId: params.handId,
                amount: params.rakeAmount.toFixed(2),
            });
            return true;
        }

        // Group players by agent for commission attribution
        const byAgent = new Map<string, number>();
        const perPlayer = params.rakeAmount / params.players.length;

        for (const player of params.players) {
            if (player.agentId) {
                const current = byAgent.get(player.agentId) || 0;
                byAgent.set(player.agentId, current + perPlayer);
            }
        }

        // Queue commission credits for each agent
        for (const [agentId, amount] of byAgent) {
            const { error } = await supabase.from('commission_queue').insert({
                agent_id: agentId,
                club_id: params.clubId,
                hand_id: params.handId,
                rake_generated: amount,
                status: 'pending',
                created_at: new Date().toISOString(),
            });

            if (error) {
                console.error('RakeService.queueCommissionCredits error:', error);
                return false;
            }
        }

        return true;
    },

    /**
     * CALCULATE TOURNAMENT RAKE
     * Law: Flat 10% on Buy-in
     */
    calculateTournamentRake(buyIn: number): { rake: number; prizePoolContribution: number } {
        const rake = buyIn * RAKE_LAWS.TOURNAMENT_RAKE;
        const contribution = buyIn - rake;

        return {
            rake,
            prizePoolContribution: contribution,
        };
    },

    /**
     * GET SCALING MATRIX
     * Reference table for stake-based caps
     */
    getScalingMatrix(): { stakeLevel: string; bigBlind: number; rakeCap: number; bbjDrop: number }[] {
        const stakes = [
            { stakeLevel: '$0.10 / $0.20', bigBlind: 0.20 },
            { stakeLevel: '$0.25 / $0.50', bigBlind: 0.50 },
            { stakeLevel: '$0.50 / $1.00', bigBlind: 1.00 },
            { stakeLevel: '$1.00 / $2.00', bigBlind: 2.00 },
            { stakeLevel: '$2.00 / $5.00', bigBlind: 5.00 },
            { stakeLevel: '$5.00 / $10.00', bigBlind: 10.00 },
            { stakeLevel: '$10.00 / $20.00', bigBlind: 20.00 },
            { stakeLevel: '$25.00 / $50.00', bigBlind: 50.00 },
        ];

        return stakes.map(s => ({
            ...s,
            rakeCap: s.bigBlind * RAKE_LAWS.CAP_MULTIPLIER,
            bbjDrop: s.bigBlind * RAKE_LAWS.BBJ_MULTIPLIER,
        }));
    },

    /**
     * GET LAWS
     * Expose rake laws for external reference
     */
    getLaws(): typeof RAKE_LAWS {
        return { ...RAKE_LAWS };
    },
};

export default RakeService;
