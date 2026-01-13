import { supabase } from '../lib/supabase';

/**
 * 💳 CREDIT SERVICE
 * Manages Credit Lines, Pre-Paid Status, and Debt Calculation.
 * 
 * LOGIC:
 * Debt = Credit Line - Current Balance
 * Invoice Generation: Sunday 11:59:59 PM
 */
export const CreditService = {

    /**
     * SET CREDIT LINE
     * Authority: Club Owner -> Agent -> Sub-Agent
     */
    async setCreditLine(agentId: string, limit: number, isPrepaid: boolean) {
        const { data, error } = await supabase
            .from('agents')
            .update({
                credit_limit: limit,
                is_prepaid: isPrepaid
            })
            .eq('id', agentId);

        if (error) throw error;
        return data;
    },

    /**
     * CALCULATE SUNDAY DEBT
     * Returns amount owed. If Balance >= Limit, debt is 0.
     */
    async calculateDebt(agentId: string) {
        const { data: agent, error } = await supabase
            .from('agents')
            .select('credit_limit, agent_wallet_balance, is_prepaid')
            .eq('id', agentId)
            .single();

        if (error) throw error;

        if (agent.is_prepaid) return 0;

        // Debt = Limit - Balance
        // Example: 10,000 Limit - 2,500 Balance = 7,500 Owed
        const debt = agent.credit_limit - agent.agent_wallet_balance;

        return debt > 0 ? debt : 0;
    },

    /**
     * GENERATE INVOICE (Sunday Trigger)
     * Creates a settlement record in PENDING state.
     */
    async generateSundayInvoice(agentId: string) {
        const debt = await this.calculateDebt(agentId);
        if (debt <= 0) return null;

        const { data, error } = await supabase
            .from('settlements')
            .insert({
                entity_id: agentId,
                entity_type: 'AGENT',
                debt_owed: debt,
                status: 'PENDING',
                period_start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), // Last week
                period_end: new Date().toISOString()
            });

        if (error) throw error;
        return data;
    }
};
