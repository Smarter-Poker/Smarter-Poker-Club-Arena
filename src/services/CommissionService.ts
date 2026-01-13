/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 📊 COMMISSION SERVICE — Hierarchical Commission System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles cascading commission calculations across the agent hierarchy.
 *
 * HIERARCHY CAPS:
 * - Club → Agent: Max 70%
 * - Agent → Sub-Agent: Max 60%
 * - Agent → Player (Rakeback): Max 50%
 *
 * FLOW:
 * 1. Hand completes → Rake calculated
 * 2. Rake attributed to dealt-in players
 * 3. Commission cascades up the agent tree
 * 4. Rakeback flows down to players
 * 5. Net margins queued for Monday settlement
 */

import { supabase, isDemoMode } from '../lib/supabase';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type CommissionTargetRole = 'AGENT' | 'SUB_AGENT' | 'PLAYER';

export interface CommissionRate {
    id: string;
    clubId: string;
    agentId: string;
    targetRole: CommissionTargetRole;
    rate: number; // 0.00 - 1.00
    effectiveDate: string;
    createdBy: string;
}

export interface CommissionSpread {
    agentId: string;
    grossCommissionRate: number; // Rate I receive from upline
    payoutToDownlines: number; // Sum of what I pay downlines
    netMargin: number; // What I keep
    downlineBreakdown: Array<{
        entityId: string;
        entityType: 'agent' | 'player';
        name: string;
        rate: number;
        rakeGenerated: number;
        commissionPaid: number;
    }>;
}

export interface RakeAttribution {
    handId: string;
    playerId: string;
    rakeAmount: number;
    agentId?: string;
    timestamp: string;
}

export interface CommissionPayout {
    agentId: string;
    periodId: string;
    grossRake: number;
    commissionEarned: number;
    paidToDownlines: number;
    netPayout: number;
    status: 'pending' | 'approved' | 'paid';
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const RATE_CAPS: Record<CommissionTargetRole, number> = {
    AGENT: 0.70,
    SUB_AGENT: 0.60,
    PLAYER: 0.50,
};

// ═══════════════════════════════════════════════════════════════════════════════
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_RATES: CommissionRate[] = [
    { id: 'cr1', clubId: 'club_1', agentId: 'agent_1', targetRole: 'AGENT', rate: 0.50, effectiveDate: '2026-01-01', createdBy: 'owner_1' },
    { id: 'cr2', clubId: 'club_1', agentId: 'agent_1', targetRole: 'PLAYER', rate: 0.25, effectiveDate: '2026-01-01', createdBy: 'agent_1' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const CommissionService = {
    // ─────────────────────────────────────────────────────────────────────────────
    // RATE MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Set commission rate with cap validation
     */
    async setRate(
        clubId: string,
        agentId: string,
        targetRole: CommissionTargetRole,
        rate: number,
        setBy: string
    ): Promise<CommissionRate> {
        // Validate cap
        const cap = RATE_CAPS[targetRole];
        if (rate > cap) {
            throw new Error(`${targetRole} rate capped at ${cap * 100}%. Requested: ${rate * 100}%`);
        }
        if (rate < 0) {
            throw new Error('Rate cannot be negative');
        }

        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            const newRate: CommissionRate = {
                id: `cr_${Date.now()}`,
                clubId,
                agentId,
                targetRole,
                rate,
                effectiveDate: new Date().toISOString(),
                createdBy: setBy,
            };
            DEMO_RATES.push(newRate);
            return newRate;
        }

        const { data, error } = await supabase
            .from('commission_structures')
            .upsert({
                club_id: clubId,
                agent_id: agentId,
                target_role: targetRole,
                rate,
                effective_date: new Date().toISOString(),
                created_by: setBy,
            }, { onConflict: 'club_id,agent_id,target_role' })
            .select()
            .single();

        if (error) throw error;
        return {
            id: data.id,
            clubId: data.club_id,
            agentId: data.agent_id,
            targetRole: data.target_role,
            rate: data.rate,
            effectiveDate: data.effective_date,
            createdBy: data.created_by,
        };
    },

    /**
     * Get all rates for an agent
     */
    async getRates(agentId: string): Promise<CommissionRate[]> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            return DEMO_RATES.filter(r => r.agentId === agentId);
        }

        const { data, error } = await supabase
            .from('commission_structures')
            .select('*')
            .eq('agent_id', agentId);

        if (error) throw error;
        return data.map(r => ({
            id: r.id,
            clubId: r.club_id,
            agentId: r.agent_id,
            targetRole: r.target_role,
            rate: r.rate,
            effectiveDate: r.effective_date,
            createdBy: r.created_by,
        }));
    },

    /**
     * Get rate for a specific target
     */
    async getRate(agentId: string, targetRole: CommissionTargetRole): Promise<number> {
        const rates = await this.getRates(agentId);
        const rate = rates.find(r => r.targetRole === targetRole);
        return rate?.rate ?? 0;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // SPREAD CALCULATIONS
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Calculate commission spread for an agent
     * Shows gross, payouts, and net margin
     */
    async calculateSpread(agentId: string, periodId?: string): Promise<CommissionSpread> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 400));
            return {
                agentId,
                grossCommissionRate: 0.50,
                payoutToDownlines: 0.25,
                netMargin: 0.25,
                downlineBreakdown: [
                    { entityId: 'player_1', entityType: 'player', name: 'Player One', rate: 0.25, rakeGenerated: 1000, commissionPaid: 250 },
                    { entityId: 'player_2', entityType: 'player', name: 'Player Two', rate: 0.25, rakeGenerated: 800, commissionPaid: 200 },
                    { entityId: 'sub_agent_1', entityType: 'agent', name: 'Sub Agent', rate: 0.30, rakeGenerated: 2000, commissionPaid: 600 },
                ],
            };
        }

        const { data, error } = await supabase.rpc('calculate_agent_spread', {
            p_agent_id: agentId,
            p_period_id: periodId || null,
        });

        if (error) throw error;
        return data;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // RAKE ATTRIBUTION
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Attribute rake to players after hand completion
     * Called by RakeService after pot drops
     */
    async attributeRake(handId: string, attributions: RakeAttribution[]): Promise<void> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            return;
        }

        const records = attributions.map(a => ({
            hand_id: handId,
            player_id: a.playerId,
            rake_amount: a.rakeAmount,
            agent_id: a.agentId || null,
            created_at: new Date().toISOString(),
        }));

        const { error } = await supabase
            .from('rake_attributions')
            .insert(records);

        if (error) throw error;
    },

    /**
     * Get player's total rake contribution
     */
    async getPlayerRakeTotal(playerId: string, periodId?: string): Promise<number> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            return 1250.50; // Mock
        }

        const { data, error } = await supabase.rpc('get_player_rake_total', {
            p_player_id: playerId,
            p_period_id: periodId || null,
        });

        if (error) throw error;
        return data;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // CASCADING COMMISSION CALCULATION
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Calculate cascading commissions for a hand
     * Walks up the agent tree, calculating each level's share
     */
    async calculateCascadingCommission(
        rakeAmount: number,
        playerId: string
    ): Promise<Array<{ agentId: string; amount: number; level: number }>> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            // Mock cascade: Player → Agent → Club
            return [
                { agentId: 'agent_1', amount: rakeAmount * 0.25, level: 1 },
                { agentId: 'owner_1', amount: rakeAmount * 0.25, level: 2 },
            ];
        }

        const { data, error } = await supabase.rpc('calculate_cascading_commission', {
            p_rake_amount: rakeAmount,
            p_player_id: playerId,
        });

        if (error) throw error;
        return data;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // SETTLEMENT INTEGRATION
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Generate commission payouts for a settlement period
     */
    async generatePeriodPayouts(periodId: string): Promise<CommissionPayout[]> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 500));
            return [
                { agentId: 'agent_1', periodId, grossRake: 5000, commissionEarned: 2500, paidToDownlines: 1250, netPayout: 1250, status: 'pending' },
                { agentId: 'agent_2', periodId, grossRake: 3000, commissionEarned: 1500, paidToDownlines: 750, netPayout: 750, status: 'pending' },
            ];
        }

        const { data, error } = await supabase.rpc('generate_period_commissions', {
            p_period_id: periodId,
        });

        if (error) throw error;
        return data;
    },

    /**
     * Approve commission payout
     */
    async approvePayout(payoutId: string, approvedBy: string): Promise<boolean> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        const { error } = await supabase
            .from('commission_payouts')
            .update({
                status: 'approved',
                approved_by: approvedBy,
                approved_at: new Date().toISOString(),
            })
            .eq('id', payoutId);

        if (error) throw error;
        return true;
    },

    /**
     * Execute commission payout (credit to wallet)
     */
    async executePayout(payoutId: string): Promise<boolean> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 500));
            return true;
        }

        const { error } = await supabase.rpc('execute_commission_payout', {
            p_payout_id: payoutId,
        });

        if (error) throw error;
        return true;
    },

    // ─────────────────────────────────────────────────────────────────────────────
    // REPORTING
    // ─────────────────────────────────────────────────────────────────────────────

    /**
     * Get agent's commission history
     */
    async getCommissionHistory(
        agentId: string,
        limit: number = 10
    ): Promise<CommissionPayout[]> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return [
                { agentId, periodId: 'period_1', grossRake: 5000, commissionEarned: 2500, paidToDownlines: 1250, netPayout: 1250, status: 'paid' },
                { agentId, periodId: 'period_2', grossRake: 4500, commissionEarned: 2250, paidToDownlines: 1125, netPayout: 1125, status: 'paid' },
            ];
        }

        const { data, error } = await supabase
            .from('commission_payouts')
            .select('*')
            .eq('agent_id', agentId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return data.map(p => ({
            agentId: p.agent_id,
            periodId: p.period_id,
            grossRake: p.gross_rake,
            commissionEarned: p.commission_earned,
            paidToDownlines: p.paid_to_downlines,
            netPayout: p.net_payout,
            status: p.status,
        }));
    },
};

export default CommissionService;
