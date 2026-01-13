import { supabase } from '../lib/supabase';

/**
 * 💰 WALLET SERVICE
 * Core logic for Triple-Wallets and Diamond Economy.
 */
export const WalletService = {

    /**
     * MINT CHIPS (Club Owner Only)
     * 75% Cheaper Law: 38 Diamonds = 100 Chips
     */
    async mintChips(clubId: string, chipAmount: number) {
        // 1. Calculate Cost
        const diamondCost = Math.ceil((chipAmount / 100) * 38);

        // 2. Transaction: Deduct Diamonds, Add Chips
        const { data, error } = await supabase.rpc('mint_club_chips', {
            p_club_id: clubId,
            p_chips: chipAmount,
            p_diamonds: diamondCost
        });

        if (error) throw error;
        return data;
    },

    /**
     * AGENT: TRANSFER SPREAD
     * Move profit from Agent Wallet -> Player Wallet (to play)
     */
    async agentSelfTransfer(agentId: string, amount: number) {
        const { data, error } = await supabase.rpc('agent_wallet_transfer', {
            p_agent_id: agentId,
            p_amount: amount,
            p_source: 'AGENT',
            p_dest: 'PLAYER'
        });

        if (error) throw error;
        return data;
    },

    /**
     * AGENT: ISSUE PROMO
     * Move from Promo Wallet -> Player
     */
    async distributePromo(agentId: string, playerId: string, amount: number) {
        const { data, error } = await supabase.rpc('distribute_promo_chips', {
            p_agent_id: agentId,
            p_player_id: playerId,
            p_amount: amount
        });

        if (error) throw error;
        return data;
    }
};
