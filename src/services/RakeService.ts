import { supabase } from '../lib/supabase';

/**
 * 💰 RAKE SERVICE
 * Handles Rake Attribution and BBJ Collection.
 * 
 * CORE LAWS:
 * 1. Rake is taken from Pot.
 * 2. Rake is split EVENLY among DEALTI-IN players.
 * 3. Sitting Out = ZERO Credit.
 */
export const RakeService = {

    /**
     * DISTRIBUTE RAKE CREDIT
     * Called at the end of every hand.
     */
    async distributeHandRake(tableId: string, handId: string, totalRake: number, players: any[]) {
        // 1. Filter Active Players
        const activePlayers = players.filter(p => !p.isSittingOut && p.hasCards);

        if (activePlayers.length === 0) return;

        // 2. Calculate Split
        const creditPerPlayer = totalRake / activePlayers.length;

        // 3. Prepare Bulk Insert/Update
        // In a real implementation, we would write to a 'rake_credits' table
        // For now, we log the attribution logic

        const attributionData = activePlayers.map(p => ({
            user_id: p.userId,
            table_id: tableId,
            hand_id: handId,
            rake_credit: creditPerPlayer
        }));

        // Example DB Call (Pseudo-code until daily_rake_stats table exists)
        // await supabase.from('daily_rake_stats').upsert(attributionData);

        return {
            totalRake,
            playerCount: activePlayers.length,
            creditPerPlayer,
            attributedTo: activePlayers.map(p => p.userId)
        };
    },

    /**
     * CALCULATE TOURNAMENT RAKE
     * Law: Flat 10% on Buy-in.
     */
    calculateTournamentRake(buyIn: number) {
        const rake = buyIn * 0.10;
        const contribution = buyIn - rake;

        return {
            rake,
            prizePoolContribution: contribution
        };
    }
};
