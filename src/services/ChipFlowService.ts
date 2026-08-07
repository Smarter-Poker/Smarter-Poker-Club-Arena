/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP FLOW SERVICE — Hierarchical Chip Distribution
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Manages the complete chip flow hierarchy:
 *   Union Owner → Club → Agent → Player
 *
 * Every chip movement is logged as a wallet_transaction with full traceability.
 * Chips originate from the Union Owner and flow down through the hierarchy.
 *
 * KEY RULES:
 * - Club owners can send chips directly to any player
 * - Agents fund their players from their own PLAYER wallet
 * - Every single transfer is logged with sender, receiver, amount, and reason
 * - Exact cent precision: Math.trunc(value * 100) / 100
 * - No rounding anywhere — exact numbers only
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { FinancialAlertService } from './FinancialAlertService';
import { retryAsync } from '../utils/retryAsync';
import { QUERY_LIMITS } from '../lib/constants';
import { reportError } from '../utils/errorReporter';

// Exact cent precision — never round
const exact = (v: number): number => Math.trunc(v * 100) / 100;

/**
 * Log every chip movement to the immutable chip_ledger table.
 * This is append-only — no updates, no deletes. Every chip that moves gets recorded.
 */
async function logToLedger(entry: {
  performed_by: string;
  from_type: string;
  from_entity_id?: string;
  from_label?: string;
  to_type: string;
  to_entity_id?: string;
  to_label?: string;
  amount: number;
  category: string;
  description?: string;
  notes?: string;
  club_id?: string;
  union_id?: string;
  table_id?: string;
  hand_id?: string;
  tournament_id?: string;
}): Promise<void> {
  try {
    const { error } = await supabase.from('chip_ledger').insert(entry);
    if (error) {
      reportError(error, 'ChipFlowService.logToLedger', { category: entry.category });
      // Don't throw — ledger failure shouldn't block the transaction
      // But DO report it as a critical alert
      FinancialAlertService.logCritical(
        'ChipFlowService.ledger',
        `Ledger write failed for ${entry.category}: ${error.message}`,
        entry
      );
    }
  } catch (e) {
    reportError(e, 'ChipFlowService.logToLedger.exception');
  }
}

export interface ChipTransferResult {
  success: boolean;
  amount: number;
  fromBalance: number;
  toBalance: number;
  transactionIds: string[];
}

export const ChipFlowService = {
  // ─────────────────────────────────────────────────────────────────────────────
  // CORE TRANSFER: Any user → Any user (PLAYER wallet)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Transfer chips between two users with full audit trail.
   * Uses atomic RPCs for debit/credit to prevent race conditions.
   */
  async transfer(
    fromUserId: string,
    toUserId: string,
    amount: number,
    category: string,
    description: string,
    relatedEntityId?: string
  ): Promise<ChipTransferResult> {
    const amt = exact(amount);
    if (amt <= 0) throw new Error('Transfer amount must be positive');

    // RATE LIMIT: Max 10 transfers per user per 60 seconds
    const { data: recentTransfers } = await supabase
      .from('wallet_transactions')
      .select('id')
      .eq('user_id', fromUserId)
      .eq('category', 'transfer')
      .gte('created_at', new Date(Date.now() - 60_000).toISOString())
      .limit(11);

    if (recentTransfers && recentTransfers.length >= 10) {
      throw new Error(
        'Transfer rate limit exceeded — max 10 transfers per minute. Please wait and try again.'
      );
    }

    // LARGE TRANSACTION ALERT: Log warning for transfers ≥ 50,000 chips
    if (amt >= 50_000) {
      FinancialAlertService.logWarning(
        'ChipFlowService',
        `Large transfer: ${amt.toLocaleString()} chips from ${fromUserId.slice(0, 8)} to ${toUserId.slice(0, 8)}`,
        { fromUserId, toUserId, amount: amt, category, description }
      );
    }

    // 1. Execute atomic transfer & logging in a single Postgres transaction
    const { error: transferErr } = await retryAsync(
      () =>
        supabase.rpc('atomic_chip_transfer', {
          p_from_user_id: fromUserId,
          p_to_user_id: toUserId,
          p_amount: amt,
          p_category: category,
          p_description: description,
          p_related_entity_id: relatedEntityId || null,
        }),
      3
    );

    if (transferErr) {
      reportError(transferErr, 'ChipFlowService.transfer', { fromUserId, toUserId, amount: amt });
      throw new Error(`Transfer failed: ${transferErr.message}`);
    }

    // 4. LOG TO IMMUTABLE CHIP LEDGER
    // Determine wallet types from description (Agent → Player, Club → Agent, etc.)
    const isToAgent = description.toLowerCase().includes('agent');
    const isFromAgent = description.toLowerCase().includes('agent') && description.indexOf('→') > 0;
    await logToLedger({
      performed_by: fromUserId,
      from_type: isFromAgent ? 'agent_wallet' : 'player_wallet',
      from_entity_id: fromUserId,
      from_label: description.split('→')[0]?.trim() || `User ${fromUserId.slice(0, 8)}`,
      to_type: isToAgent && !isFromAgent ? 'agent_wallet' : 'player_wallet',
      to_entity_id: toUserId,
      to_label: description.split('→')[1]?.split(':')[0]?.trim() || `User ${toUserId.slice(0, 8)}`,
      amount: amt,
      category,
      description,
      club_id: relatedEntityId || undefined,
    });

    // 5. Emit bus events so CashierPage/PlayerWallet pages refresh for BOTH parties
    masterBus.emit('BALANCE_UPDATED', {
      source: 'chip_transfer',
      userId: fromUserId,
      amount: -amt,
    });
    masterBus.emit('BALANCE_UPDATED', { source: 'chip_transfer', userId: toUserId, amount: amt });
    // CASHIER_BALANCE_CHANGED: Specific event for MarketplacePage and cashier-aware components
    masterBus.emit('CASHIER_BALANCE_CHANGED', { clubId: relatedEntityId || '' });

    // 5. Get final balances
    const { data: fromWallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', fromUserId)
      .eq('wallet_type', 'PLAYER')
      .maybeSingle();

    const { data: toWallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', toUserId)
      .eq('wallet_type', 'PLAYER')
      .maybeSingle();

    return {
      success: true,
      amount: amt,
      fromBalance: fromWallet?.balance || 0,
      toBalance: toWallet?.balance || 0,
      transactionIds: [],
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // HIERARCHY TRANSFERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Union Owner → Club Owner
   * Chips originate from the union owner's wallet and flow to the club owner.
   * The union owner and club owner may be the same person (like KingFish).
   */
  async unionToClub(
    unionOwnerId: string,
    clubOwnerId: string,
    clubId: string,
    amount: number,
    clubName: string
  ): Promise<ChipTransferResult> {
    // If same person, log a single internal allocation note (no wallet movement needed)
    if (unionOwnerId === clubOwnerId) {
      await WalletService.logTransaction(
        unionOwnerId,
        'PLAYER',
        exact(amount),
        'credit',
        'transfer',
        `Union → Club ${clubName}: internal allocation (same owner)`,
        undefined,
        undefined,
        clubId
      );

      // Return real balance instead of zeros
      const { data: wallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', unionOwnerId)
        .eq('wallet_type', 'PLAYER')
        .maybeSingle();

      return {
        success: true,
        amount: exact(amount),
        fromBalance: wallet?.balance || 0,
        toBalance: wallet?.balance || 0,
        transactionIds: [],
      };
    }

    return this.transfer(
      unionOwnerId,
      clubOwnerId,
      amount,
      'transfer',
      `Union → Club ${clubName}: chip allocation`,
      clubId
    );
  },

  /**
   * Club Owner → Agent
   * Club owner funds an agent's PLAYER wallet for distribution to their players.
   */
  async clubToAgent(
    clubOwnerId: string,
    agentUserId: string,
    clubId: string,
    amount: number,
    agentName: string,
    clubName: string
  ): Promise<ChipTransferResult> {
    return this.transfer(
      clubOwnerId,
      agentUserId,
      amount,
      'transfer',
      `${clubName} → Agent ${agentName}: player funding allocation`,
      clubId
    );
  },

  /**
   * Agent → Player
   * Agent funds a player under them from their own PLAYER wallet.
   */
  async agentToPlayer(
    agentUserId: string,
    playerId: string,
    amount: number,
    agentName: string,
    playerName: string,
    clubName: string
  ): Promise<ChipTransferResult> {
    return this.transfer(
      agentUserId,
      playerId,
      amount,
      'transfer',
      `Agent ${agentName} → ${playerName}: player funding (${clubName})`,
      agentUserId
    );
  },

  /**
   * Club Owner → Player (direct)
   * Club owners can send chips directly to any player, bypassing agents.
   */
  async clubToPlayer(
    clubOwnerId: string,
    playerId: string,
    amount: number,
    playerName: string,
    clubName: string
  ): Promise<ChipTransferResult> {
    return this.transfer(
      clubOwnerId,
      playerId,
      amount,
      'transfer',
      `${clubName} Owner → ${playerName}: direct player funding`,
      clubOwnerId
    );
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // MINTING (System → Union Owner) — REMOVED
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // AUDIT M17: `mintToUnionOwner` is deleted. It was a browser-callable chip
  // mint in the most literal sense — it credited an arbitrary caller-supplied
  // amount to an arbitrary user id, under category 'mint', with no offsetting
  // debit and no authorization check of any kind. Nothing in the codebase called
  // it, and the underlying `atomic_credit_wallet_and_log` is refused by RLS from
  // a browser, so it never ran. Both of those are accidents, not safeguards.
  //
  // Minting is the origin point of every chip in the system, so it belongs
  // exactly where the rest of M17 puts money: behind a SECURITY DEFINER RPC that
  // enforces its own authorization (union owner, and locked at the club level
  // once a club joins a union) and records the mint in the immutable ledger as
  // part of the same transaction. `distribute_chips` and `mint_club_chips` are
  // already on the wallet guard's whitelist for that purpose.
  //
  // Deleting it is not a loss of function: there was no function, only a
  // loaded gun with the safety on.

  // ─────────────────────────────────────────────────────────────────────────────
  // BALANCE RESET (for re-initialization)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Reset a user's PLAYER wallet balance to 0 with audit trail.
   * Used when re-initializing the funding chain.
   */
  async resetBalance(
    userId: string,
    reason: string = 'Balance reset for proper funding chain'
  ): Promise<number> {
    const { data: wallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', userId)
      .eq('wallet_type', 'PLAYER')
      .maybeSingle();

    const currentBalance = wallet?.balance || 0;

    if (currentBalance > 0) {
      const { error: deductErr } = await retryAsync(
        () =>
          supabase.rpc('atomic_deduct_wallet_and_log', {
            p_user_id: userId,
            p_amount: currentBalance,
            p_category: 'settlement',
            p_description: reason,
            p_table_id: null,
            p_hand_id: null,
            p_related_entity_id: null,
          }),
        3
      );

      if (deductErr) {
        reportError(deductErr, 'ChipFlowService.resetBalance', { userId, currentBalance });
        throw new Error(`Balance reset failed: ${deductErr.message}`);
      }

      // Emit bus event so UI reflects the zeroed balance
      masterBus.emit('BALANCE_UPDATED', { source: 'balance_reset', userId });
    }

    return currentBalance;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // LEDGER QUERIES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get the complete chip flow trail for a user — every transaction that funded them.
   */
  async getChipTrail(userId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('wallet_transactions')
      .select(
        'id, user_id, wallet_type, amount, type, category, description, table_id, hand_id, related_entity_id, created_at'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(QUERY_LIMITS.LARGE);

    if (error) throw error;
    return data || [];
  },

  /**
   * Verify ledger integrity: total minted should equal total in circulation.
   */
  async verifyLedger(): Promise<{
    totalMinted: number;
    totalInWallets: number;
    totalInLockedBalance: number;
    difference: number;
    isBalanced: boolean;
  }> {
    // 1. First try the hardened RPC for massive tables
    const { data: rpcData, error: rpcError } = await supabase.rpc('verify_ledger_totals');

    if (!rpcError && rpcData) {
      const difference = exact(
        rpcData.total_minted - rpcData.total_in_wallets - rpcData.total_locked
      );
      return {
        totalMinted: exact(rpcData.total_minted),
        totalInWallets: exact(rpcData.total_in_wallets),
        totalInLockedBalance: exact(rpcData.total_locked),
        difference,
        isBalanced: Math.abs(difference) < 0.01,
      };
    }

    // RPC missing (not yet deployed) — fall through to paginated client-side aggregation
    if (rpcError) {
      console.debug('[ChipFlowService] verify_ledger_totals RPC not available — using fallback.');
    }

    // 2. Fallback to paginated client-side aggregation if RPC is missing
    //    Safety: cap at 10,000 pages (10M rows) to prevent infinite loops on massive tables
    const MAX_PAGES = 10_000;
    let totalMinted = 0;
    let hasMoreMints = true;
    let offsetMints = 0;
    let mintPages = 0;

    while (hasMoreMints && mintPages < MAX_PAGES) {
      mintPages++;
      const { data: mints, error } = await supabase
        .from('wallet_transactions')
        .select('amount')
        .eq('type', 'credit')
        .eq('category', 'mint')
        .range(offsetMints, offsetMints + 999);

      if (error || !mints) break;
      totalMinted += mints.reduce((s, t) => s + Number(t.amount), 0);

      if (mints.length < 1000) hasMoreMints = false;
      else offsetMints += 1000;
    }

    let totalInWallets = 0;
    let totalInLockedBalance = 0;
    let hasMoreWallets = true;
    let offsetWallets = 0;
    let walletPages = 0;

    while (hasMoreWallets && walletPages < MAX_PAGES) {
      walletPages++;
      const { data: wallets, error } = await supabase
        .from('wallets')
        .select('balance, locked_balance')
        .range(offsetWallets, offsetWallets + 999);

      if (error || !wallets) break;
      totalInWallets += wallets.reduce((s, w) => s + Number(w.balance || 0), 0);
      totalInLockedBalance += wallets.reduce((s, w) => s + Number(w.locked_balance || 0), 0);

      if (wallets.length < 1000) hasMoreWallets = false;
      else offsetWallets += 1000;
    }

    const difference = exact(totalMinted - totalInWallets - totalInLockedBalance);

    return {
      totalMinted: exact(totalMinted),
      totalInWallets: exact(totalInWallets),
      totalInLockedBalance: exact(totalInLockedBalance),
      difference,
      isBalanced: Math.abs(difference) < 0.01,
    };
  },

  /**
   * Run ledger reconciliation — verifies total minted equals total in circulation.
   * If imbalanced, fires a CRITICAL financial alert for ops investigation.
   * Designed to be called from a cron/edge function on a daily schedule.
   */
  async runReconciliation(): Promise<{
    isBalanced: boolean;
    difference: number;
  }> {
    const result = await this.verifyLedger();

    if (!result.isBalanced) {
      await FinancialAlertService.logCritical(
        'ChipFlowService.reconciliation',
        `Ledger imbalance detected: ${result.difference.toFixed(2)} chips unaccounted for`,
        {
          totalMinted: result.totalMinted,
          totalInWallets: result.totalInWallets,
          totalInLockedBalance: result.totalInLockedBalance,
          difference: result.difference,
        }
      );
    } else {
      console.debug(
        `[Reconciliation] ✅ Ledger balanced: ${result.totalMinted.toLocaleString()} minted, ` +
          `${result.totalInWallets.toLocaleString()} in wallets, ${result.totalInLockedBalance.toLocaleString()} locked`
      );
    }

    return { isBalanced: result.isBalanced, difference: result.difference };
  },
};

export default ChipFlowService;
