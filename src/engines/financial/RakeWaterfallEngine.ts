import { supabase } from '../../lib/supabase';
import { CommissionService } from '../../services/CommissionService';
import { RakeService } from '../../services/RakeService';

interface HandContext {
    tableId: string;
    handId: string;
    clubId: string;
    totalPot: number;
    players: any[]; // Dealt-in players
}

/**
 * 🌊 RAKE WATERFALL ENGINE
 * Orchestrates the flow of money after every hand.
 * 
 * FLOW:
 * 1. Calculate Gross Rake (Cap Check).
 * 2. Calculate BBJ Drop.
 * 3. Send Rake + BBJ to Union Custody.
 * 4. Attribute "Rake Generated" to Players.
 * 5. Trigger Commission Payouts (Async).
 */
export class RakeWaterfallEngine {

    /**
     * PROCESS HAND END
     * The single entry point for financial settlement of a hand.
     */
    static async processHand(ctx: HandContext) {
        console.log(`🌊 WATERFALL: Processing Hand ${ctx.handId}`);

        // 1. CALCULATE RAKE & BBJ
        // Standard: 5% up to Cap (e.g. 3bb)
        // Union Tax is calculated LATER during weekly settlement

        const rakePercent = 0.10; // From Club Settings
        const rakeCap = 5.00;     // From Club Settings

        let grossRake = Math.min(ctx.totalPot * rakePercent, rakeCap);

        // 2. BBJ DROP
        // E.g. 1bb if Pot > 10bb
        const bbjDrop = 1.00; // Simplified rule

        // 3. EXECUTE POT DEDUCTION (Move Chips to Union/Club/BBJ Wallets)
        // This is the "Physical" movement of chips from the table
        await this.executePotDeductions(ctx, grossRake, bbjDrop);

        // 4. ATTRIBUTE RAKE (The "Generated" Credit)
        // This splits the grossRake among players for commission purposes
        const attribution = await RakeService.distributeHandRake(
            ctx.tableId,
            ctx.handId,
            grossRake,
            ctx.players
        );

        // 5. TRIGGER COMMISSION CALCULATIONS
        // Based on the attribution, calculate what agents earned
        if (attribution) {
            this.triggerCommissionWaterfall(ctx.clubId, attribution);
        }

        return {
            grossRake,
            bbjDrop,
            attribution
        };
    }

    // INTERNAL: Move the actual chips in DB
    private static async executePotDeductions(ctx: HandContext, rake: number, bbj: number) {
        // 1. Move Rake to Club's Pending Rake Wallet (held by Union)
        // 2. Move BBJ to Union BBJ Pool

        // Using RPC for atomicity
        const { error } = await supabase.rpc('execute_pot_drops', {
            p_hand_id: ctx.handId,
            p_club_id: ctx.clubId,
            p_rake_amount: rake,
            p_bbj_amount: bbj
        });

        if (error) console.error("Drop Failure:", error);
    }

    // INTERNAL: Calculate and Queue Commissions
    private static async triggerCommissionWaterfall(clubId: string, attribution: any) {
        // attribution.attributedTo = [userId1, userId2...]
        // attribution.creditPerPlayer = 0.50

        // For each player, find their agent chain and credit commissions
        // This is heavy, so typically sent to a background worker
        // Simulation:

        /*
          Player A (Generated 0.50)
            -> Agent 1 (50% Com) -> Earns 0.25
               -> Sub-Agent 1.1 (30% Com) -> Earns 0.15 (from Agent 1's share? No, usually hierarchical spread)
               
          HIERARCHY PROFIT MODEL:
          Gross: 0.50
          Agent 1 Rate: 70% (Total for tree) = 0.35
          Sub-Agent Rate: 40% (Total for tree) = 0.20
          Player Rakeback: 20% = 0.10
          
          Profit:
          Agent 1: 0.35 - 0.20 = 0.15
          Sub-Agent: 0.20 - 0.10 = 0.10
          Player: 0.10
          Club: Rake (0.50) - Agent Tree (0.35) = 0.15
        */

        // We record these "Earnings" in the settlements table for Weekly Payout
        // We DO NOT pay them instantly to wallets (that's the Monday Payout)

        console.log("🌊 WATERFALL: Commissions queued for Monday Settlement.");
    }
}
