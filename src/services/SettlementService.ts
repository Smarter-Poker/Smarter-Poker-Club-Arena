/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🏛️ SETTLEMENT SERVICE — Weekly Financial Settlement Automation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles Union Cross-Club Wires and Monday Payouts.
 *
 * SETTLEMENT CYCLE:
 * - Sunday 11:59:59 PM PST → Snapshot all ledgers
 * - Monday 4:00 AM PST → Process payouts
 *
 * FORMULA:
 * Wire = (Net Player P/L) + (Gross Rake Return) - (Union Tax 10%)
 */

import { supabase, isDemoMode } from '../lib/supabase';
import { CommissionService } from './CommissionService';
import { WalletService } from './WalletService';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type SettlementStatus = 'open' | 'processing' | 'settled' | 'disputed';

export interface SettlementPeriod {
    id: string;
    periodNumber: number;
    year: number;
    startAt: string;
    endAt: string;
    status: SettlementStatus;
    totalRakeCollected: number;
    totalBBJContributions: number;
    totalPlayerWinnings: number;
    totalPlayerLosses: number;
    totalHandsDealt: number;
    settledAt?: string;
    settledBy?: string;
}

export interface ClubSettlement {
    id: string;
    periodId: string;
    clubId: string;
    clubName: string;
    totalRakeCollected: number;
    totalJackpotContributions: number;
    totalPromoCosts: number;
    uniquePlayers: number;
    totalHandsDealt: number;
    platformFee: number;
    agentCommissions: number;
    grossRevenue: number;
    netRevenue: number;
    status: 'pending' | 'finalized' | 'disputed';
}

export interface AgentSettlement {
    id: string;
    periodId: string;
    agentId: string;
    agentName: string;
    totalRakeGenerated: number;
    commissionRate: number;
    commissionEarned: number;
    creditExtended: number;
    creditRepaid: number;
    netSettlement: number;
    activePlayers: number;
    status: 'pending' | 'approved' | 'paid' | 'disputed';
}

export interface UnionWireCalculation {
    clubId: string;
    clubName: string;
    netPlayerPL: number;
    grossRake: number;
    unionTax: number;
    finalWire: number;
    action: 'COLLECT_FROM_UNION' | 'PAY_TO_UNION';
}

export interface SettlementSummary {
    period: SettlementPeriod;
    clubSettlements: ClubSettlement[];
    agentSettlements: AgentSettlement[];
    unionWires: UnionWireCalculation[];
    totalPlatformRevenue: number;
    totalAgentPayouts: number;
    totalPlayerRakeback: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_PERIOD: SettlementPeriod = {
    id: 'period_current',
    periodNumber: 2,
    year: 2026,
    startAt: '2026-01-06T00:00:00Z',
    endAt: '2026-01-12T23:59:59Z',
    status: 'open',
    totalRakeCollected: 125000,
    totalBBJContributions: 6250,
    totalPlayerWinnings: 450000,
    totalPlayerLosses: 475000,
    totalHandsDealt: 15420,
};

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const SettlementService = {
    // ─────────────────────────────────────────────────────────────────────────────
    // PERIOD MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get or create the current settlement period
     */
    async getCurrentPeriod(): Promise<SettlementPeriod> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            return DEMO_PERIOD;
        }

        const { data, error } = await supabase.rpc('get_current_settlement_period');
        if (error) throw error;

        const { data: period } = await supabase
            .from('settlement_periods')
            .select('*')
            .eq('id', data)
            .single();

        return this.mapPeriod(period);
    },

    /**
     * Get historical periods
     */
    async getPeriodHistory(limit: number = 12): Promise<SettlementPeriod[]> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return [DEMO_PERIOD];
        }

        const { data, error } = await supabase
            .from('settlement_periods')
            .select('*')
            .order('start_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data.map(this.mapPeriod);
    },

    /**
     * Close period and begin processing
     */
    async closePeriod(periodId: string): Promise<boolean> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 500));
            DEMO_PERIOD.status = 'processing';
            return true;
        }

        const { error } = await supabase.rpc('close_settlement_period', {
            p_period_id: periodId,
        });

        if (error) throw error;
        return true;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // SETTLEMENT CALCULATIONS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Calculate union wire for a club
     */
    calculateUnionWire(
        clubId: string,
        clubName: string,
        netPlayerPL: number,
        grossRake: number
    ): UnionWireCalculation {
        const unionTax = grossRake * 0.10; // 10% Union Tax
        const finalWire = netPlayerPL + grossRake - unionTax;

        return {
            clubId,
            clubName,
            netPlayerPL,
            grossRake,
            unionTax,
            finalWire: Math.abs(finalWire),
            action: finalWire >= 0 ? 'COLLECT_FROM_UNION' : 'PAY_TO_UNION',
        };
    },

    /**
     * Generate all settlements for a period
     */
    async generateSettlements(periodId: string): Promise<SettlementSummary> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 800));
            return {
                period: DEMO_PERIOD,
                clubSettlements: [
                    {
                        id: 'cs_1', periodId, clubId: 'club_1', clubName: 'Diamond Club',
                        totalRakeCollected: 50000, totalJackpotContributions: 2500, totalPromoCosts: 1000,
                        uniquePlayers: 145, totalHandsDealt: 5200, platformFee: 5000,
                        agentCommissions: 15000, grossRevenue: 50000, netRevenue: 30000, status: 'pending',
                    },
                ],
                agentSettlements: [
                    {
                        id: 'as_1', periodId, agentId: 'agent_1', agentName: 'Agent Smith',
                        totalRakeGenerated: 25000, commissionRate: 0.50, commissionEarned: 12500,
                        creditExtended: 5000, creditRepaid: 3000, netSettlement: 10500,
                        activePlayers: 45, status: 'pending',
                    },
                ],
                unionWires: [
                    this.calculateUnionWire('club_1', 'Diamond Club', 25000, 50000),
                ],
                totalPlatformRevenue: 5000,
                totalAgentPayouts: 12500,
                totalPlayerRakeback: 6250,
            };
        }

        const { data, error } = await supabase.rpc('generate_period_settlements', {
            p_period_id: periodId,
        });

        if (error) throw error;
        return data;
    },

    /**
     * Calculate agent settlement for a specific agent
     */
    async calculateAgentSettlement(periodId: string, agentId: string): Promise<AgentSettlement> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 400));
            return {
                id: 'as_demo', periodId, agentId, agentName: 'Demo Agent',
                totalRakeGenerated: 15000, commissionRate: 0.50, commissionEarned: 7500,
                creditExtended: 2000, creditRepaid: 2000, netSettlement: 7500,
                activePlayers: 25, status: 'pending',
            };
        }

        const { data, error } = await supabase.rpc('calculate_agent_settlement', {
            p_period_id: periodId,
            p_agent_id: agentId,
        });

        if (error) throw error;
        return data;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // PAYOUT EXECUTION
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Execute Monday payout cycle
     */
    async executeMondayPayouts(periodId: string): Promise<{
        agentsPaid: number;
        playersWithRakeback: number;
        totalDisbursed: number;
    }> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 1000));
            return {
                agentsPaid: 12,
                playersWithRakeback: 156,
                totalDisbursed: 45000,
            };
        }

        // 1. Get all approved agent settlements
        const { data: agentSettlements } = await supabase
            .from('agent_settlements')
            .select('*')
            .eq('period_id', periodId)
            .eq('status', 'approved');

        let agentsPaid = 0;
        let totalDisbursed = 0;

        // 2. Process each agent payout
        for (const settlement of agentSettlements || []) {
            try {
                await WalletService.creditCommission(
                    settlement.agent_id,
                    settlement.net_settlement,
                    periodId
                );

                await supabase
                    .from('agent_settlements')
                    .update({ status: 'paid', paid_at: new Date().toISOString() })
                    .eq('id', settlement.id);

                agentsPaid++;
                totalDisbursed += settlement.net_settlement;
            } catch (err) {
                console.error(`Failed to pay agent ${settlement.agent_id}:`, err);
            }
        }

        // 3. Process player rakeback
        const { data: playerSnapshots } = await supabase
            .from('player_weekly_snapshots')
            .select('*')
            .eq('period_id', periodId)
            .gt('rakeback_earned', 0);

        let playersWithRakeback = 0;
        for (const snapshot of playerSnapshots || []) {
            try {
                await WalletService.creditRakeback(
                    snapshot.player_id,
                    snapshot.rakeback_earned,
                    periodId
                );
                playersWithRakeback++;
                totalDisbursed += snapshot.rakeback_earned;
            } catch (err) {
                console.error(`Failed rakeback for player ${snapshot.player_id}:`, err);
            }
        }

        // 4. Finalize period
        await supabase.rpc('finalize_settlement_period', { p_period_id: periodId });

        return { agentsPaid, playersWithRakeback, totalDisbursed };
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // REPORTING
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get club settlement report
     */
    async getClubReport(clubId: string, periodId?: string): Promise<ClubSettlement | null> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return {
                id: 'cs_demo', periodId: periodId || 'period_current', clubId, clubName: 'Demo Club',
                totalRakeCollected: 35000, totalJackpotContributions: 1750, totalPromoCosts: 500,
                uniquePlayers: 89, totalHandsDealt: 3200, platformFee: 3500,
                agentCommissions: 10500, grossRevenue: 35000, netRevenue: 21000, status: 'pending',
            };
        }

        const { data, error } = await supabase
            .from('club_settlements')
            .select('*')
            .eq('club_id', clubId)
            .eq('period_id', periodId || (await this.getCurrentPeriod()).id)
            .single();

        if (error) return null;
        return this.mapClubSettlement(data);
    },

    /**
     * Get agent settlement report
     */
    async getAgentReport(agentId: string, periodId?: string): Promise<AgentSettlement | null> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return {
                id: 'as_demo', periodId: periodId || 'period_current', agentId, agentName: 'Demo Agent',
                totalRakeGenerated: 18000, commissionRate: 0.45, commissionEarned: 8100,
                creditExtended: 1500, creditRepaid: 1500, netSettlement: 8100,
                activePlayers: 32, status: 'pending',
            };
        }

        const { data, error } = await supabase
            .from('agent_settlements')
            .select('*')
            .eq('agent_id', agentId)
            .eq('period_id', periodId || (await this.getCurrentPeriod()).id)
            .single();

        if (error) return null;
        return this.mapAgentSettlement(data);
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────────

    mapPeriod(p: any): SettlementPeriod {
        return {
            id: p.id,
            periodNumber: p.period_number,
            year: p.year,
            startAt: p.start_at,
            endAt: p.end_at,
            status: p.status,
            totalRakeCollected: p.total_rake_collected || 0,
            totalBBJContributions: p.total_bbj_contributions || 0,
            totalPlayerWinnings: p.total_player_winnings || 0,
            totalPlayerLosses: p.total_player_losses || 0,
            totalHandsDealt: p.total_hands_dealt || 0,
            settledAt: p.settled_at,
            settledBy: p.settled_by,
        };
    },

    mapClubSettlement(s: any): ClubSettlement {
        return {
            id: s.id,
            periodId: s.period_id,
            clubId: s.club_id,
            clubName: s.club_name || 'Unknown Club',
            totalRakeCollected: s.total_rake_collected,
            totalJackpotContributions: s.total_jackpot_contributions,
            totalPromoCosts: s.total_promo_costs,
            uniquePlayers: s.unique_players,
            totalHandsDealt: s.total_hands_dealt,
            platformFee: s.platform_fee,
            agentCommissions: s.agent_commissions,
            grossRevenue: s.gross_revenue,
            netRevenue: s.net_revenue,
            status: s.status,
        };
    },

    mapAgentSettlement(s: any): AgentSettlement {
        return {
            id: s.id,
            periodId: s.period_id,
            agentId: s.agent_id,
            agentName: s.agent_name || 'Unknown Agent',
            totalRakeGenerated: s.total_rake_generated,
            commissionRate: s.commission_rate,
            commissionEarned: s.commission_earned,
            creditExtended: s.total_credit_extended || 0,
            creditRepaid: s.total_credit_repaid || 0,
            netSettlement: s.net_settlement,
            activePlayers: s.active_players || 0,
            status: s.status,
        };
    },
};

export default SettlementService;
