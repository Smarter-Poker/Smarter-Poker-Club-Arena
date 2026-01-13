import { supabase } from '../lib/supabase';

/**
 * 📊 COMMISSION SERVICE
 * Handles Hierarchical Rate Setting & Profit Calculations.
 * 
 * HIERARCHY:
 * Club -> Agent (Max 70%)
 * Agent -> Sub-Agent (Max 60%)
 * Agent -> Player (Max 50%)
 */
export const CommissionService = {

    /**
     * SET COMMISSION RATE
     * Validates caps and permissions.
     */
    async setRate(clubId: string, agentId: string, targetRole: 'AGENT' | 'SUB_AGENT' | 'PLAYER', rate: number) {
        // 1. Validate Caps
        if (targetRole === 'AGENT' && rate > 0.70) throw new Error("Agent Rate capped at 70%");
        if (targetRole === 'SUB_AGENT' && rate > 0.60) throw new Error("Sub-Agent Rate capped at 60%");
        if (targetRole === 'PLAYER' && rate > 0.50) throw new Error("Player Rakeback capped at 50%");

        // 2. Upsert Permission
        const { data, error } = await supabase
            .from('commission_structures')
            .upsert({
                club_id: clubId,
                agent_id: agentId,
                target_role: targetRole,
                rate: rate
            });

        if (error) throw error;
        return data;
    },

    /**
     * CALCULATE SPREAD (PROFIT)
     * Returns: { myRate, downlineRate, profitMargin }
     */
    async calculateSpread(agentId: string) {
        // This is a complex query usually handled by a Database View.
        // Simplifying for Service Logic:

        // 1. Get My Rate (from Upline)
        // 2. Get Downline Rates (Average or Specific)
        // 3. Margin = MyRate - DownlineRate

        // Placeholder logic until View is built
        return {
            grossCommission: 0.70,
            payoutsToDownline: 0.30,
            netMargin: 0.40
        };
    }
};
