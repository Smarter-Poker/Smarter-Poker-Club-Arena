import { supabase } from '../../lib/supabase';
import { WalletService } from '../../services/WalletService';
import { CommissionService } from '../../services/CommissionService';
import { RakeService } from '../../services/RakeService';
import { retryAsync } from '../../utils/retryAsync';
import { reportError } from '../../utils/errorReporter';

export interface HandContext {
  tableId: string;
  handId: string;
  clubId: string;
  totalPot: number;
  smallBlind?: number;
  bigBlind: number; // For scaling caps
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
    // 1. CALCULATE RAKE & BBJ using RakeService (Single Source of Truth)
    // LAW: 10% Rate | Tier-based Cap | BBJ from chart (LOCKED)

    const sb = ctx.smallBlind ?? ctx.bigBlind / 2;
    const rakeResult = RakeService.calculateRake(ctx.totalPot, ctx.bigBlind, true, sb);

    const rakePercent = rakeResult.rakePercent;
    const rakeCap = rakeResult.rakeCap;
    const grossRake = rakeResult.cappedRake;

    // 2. BBJ DROP from RakeService
    const bbjDrop = rakeResult.bbjDrop;

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
      attribution,
    };
  }

  // INTERNAL: Move the actual chips in DB
  private static async executePotDeductions(ctx: HandContext, rake: number, bbj: number) {
    // 1. Move Rake to Club's Pending Rake Wallet (held by Union)
    // 2. Move BBJ to Union BBJ Pool

    // Using RPC for atomicity
    const { error } = await retryAsync(
      () =>
        supabase.rpc('execute_pot_drops', {
          p_hand_id: ctx.handId,
          p_club_id: ctx.clubId,
          p_rake_amount: rake,
          p_bbj_amount: bbj,
        }),
      3
    );

    if (error) {
      reportError(error, 'RakeWaterfallEngine.CRITICAL_pot_deduction_failure');
      throw new Error(`Failed to execute pot drops for hand ${ctx.handId}: ${error.message}`);
    }

    // Log rake + BBJ deductions to wallet_transactions for audit trail
    // Rake goes to union/club owner depending on union membership
    const { data: club } = await supabase
      .from('clubs')
      .select('owner_id, union_id')
      .eq('id', ctx.clubId)
      .maybeSingle();

    if (club) {
      let rakeRecipientId = club.owner_id;
      if (club.union_id) {
        const { data: union } = await supabase
          .from('unions')
          .select('owner_id')
          .eq('id', club.union_id)
          .maybeSingle();
        if (union?.owner_id) rakeRecipientId = union.owner_id;
      }

      if (rakeRecipientId && rake > 0) {
        await WalletService.logTransaction(
          rakeRecipientId,
          'PLAYER',
          Math.trunc(rake * 100) / 100,
          'credit',
          'rake',
          `Hand rake collected`,
          ctx.tableId,
          ctx.handId
        );
      }
    }
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
  }
}
