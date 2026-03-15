/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WALLET SERVICE — Complete Triple-Wallet System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Core financial operations for Club Arena.
 * Implements the Triple-Wallet architecture:
 * - BUSINESS Wallet: Commissions, settlements, withdrawals
 * - PLAYER Wallet: Table buy-ins, gameplay chips
 * - PROMO Wallet: Bonuses, giveaways, leaderboard rewards
 *
 * 75% Cheaper Law: 38 Diamonds = 100 Chips
 */

import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';
import { masterBus } from '../core/MasterBus';
import { FinancialAlertService } from './FinancialAlertService';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type WalletType = 'BUSINESS' | 'PLAYER' | 'PROMO';

export interface WalletBalance {
  userId: string;
  walletType: WalletType;
  balance: number;
  lockedBalance: number; // Chips currently at tables
  availableBalance: number;
  lastUpdated: string;
}

export interface TransferRequest {
  fromWallet: WalletType;
  toWallet: WalletType;
  amount: number;
  note?: string;
}

export interface TransactionRecord {
  id: string;
  userId: string;
  walletType: WalletType;
  amount: number;
  type: 'credit' | 'debit';
  category:
    | 'mint'
    | 'transfer'
    | 'buyin'
    | 'cashout'
    | 'rake'
    | 'commission'
    | 'promo'
    | 'settlement';
  description: string;
  relatedEntityId?: string;
  createdAt: string;
}

export interface ChipMintResult {
  success: boolean;
  chipsAdded: number;
  diamondsSpent: number;
  newBalance: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const WalletService = {
  // ─────────────────────────────────────────────────────────────────────────────
  // BALANCE QUERIES
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all wallet balances for a user
   */
  async getBalances(userId: string): Promise<WalletBalance[]> {
    const { data, error } = await supabase
      .from('wallets')
      .select('user_id, wallet_type, balance, locked_balance, updated_at')
      .eq('user_id', userId);

    if (error) throw error;
    return (data || []).map((w) => ({
      userId: w.user_id,
      walletType: w.wallet_type as WalletType,
      balance: w.balance,
      lockedBalance: w.locked_balance,
      availableBalance: w.balance - w.locked_balance,
      lastUpdated: w.updated_at,
    }));
  },

  /**
   * Get specific wallet balance
   */
  async getWalletBalance(userId: string, walletType: WalletType): Promise<WalletBalance> {
    const balances = await this.getBalances(userId);
    const wallet = balances.find((b) => b.walletType === walletType);
    if (!wallet) throw new Error(`Wallet ${walletType} not found for user ${userId}`);
    return wallet;
  },

  /**
   * Get total available chips across all wallets
   */
  async getTotalAvailable(userId: string): Promise<number> {
    const balances = await this.getBalances(userId);
    return balances.reduce((sum, w) => sum + w.availableBalance, 0);
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // CHIP MINTING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Mint chips using diamonds.
   *
   * MINTING RULES:
   * - If the club belongs to a Union, ONLY the Union owner can mint chips.
   *   The club's mint functionality is LOCKED once they join a union.
   *   All chips must originate from the Union level and flow down.
   * - If the club is standalone (no union affiliation), the club owner can mint directly.
   *
   * 75% Cheaper Law: 38 Diamonds = 100 Chips
   */
  async mintChips(
    clubId: string,
    chipAmount: number,
    requestingUserId?: string
  ): Promise<ChipMintResult> {
    // 1. Check if club belongs to a union
    const { data: club } = await supabase
      .from('clubs')
      .select('id, name, owner_id, union_id')
      .eq('id', clubId)
      .maybeSingle();

    if (!club) throw new Error('Club not found');

    // 2. If club is in a union, minting must go through the union owner
    if (club.union_id) {
      const { data: union } = await supabase
        .from('unions')
        .select('id, owner_id, name')
        .eq('id', club.union_id)
        .maybeSingle();

      if (!union) throw new Error('Union not found');

      // Only the union owner can mint — club owners cannot mint when in a union
      if (requestingUserId && requestingUserId !== union.owner_id) {
        throw new Error(
          `Minting is locked for clubs in a union. Only the Union owner (${union.name}) can mint chips. ` +
            `Contact your union owner for chip allocation.`
        );
      }
    }

    // 3. Calculate diamond cost
    const diamondCost = Math.ceil((chipAmount / 100) * 38);

    const { data, error } = await retryAsync(async () => {
      const res = await supabase.rpc('mint_club_chips', {
        p_club_id: clubId,
        p_chips: chipAmount,
        p_diamonds: diamondCost,
      });
      return res;
    });

    if (error) throw error;

    // 4. Determine who receives the minted chips
    const mintRecipientId = club.union_id
      ? (await supabase.from('unions').select('owner_id').eq('id', club.union_id).maybeSingle())
          .data?.owner_id
      : club.owner_id;

    // 5. Log mint transaction with full audit trail
    if (mintRecipientId) {
      await this.logTransaction(
        mintRecipientId,
        'PLAYER',
        chipAmount,
        'credit',
        'mint',
        club.union_id
          ? `Union mint: ${chipAmount} chips for ${club.name} (${diamondCost} diamonds spent)`
          : `Club mint: ${chipAmount} chips (${diamondCost} diamonds spent) — standalone club`,
        undefined,
        undefined,
        clubId
      );
    }

    // Emit bus event so other pages (CashierPage, ClubFinancials) refresh instantly
    masterBus.emit('BALANCE_UPDATED', {
      source: 'mint',
      userId: mintRecipientId || clubId,
      amount: chipAmount,
    });

    return {
      success: true,
      chipsAdded: chipAmount,
      diamondsSpent: diamondCost,
      newBalance: data?.new_balance || 0,
    };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSFERS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Transfer funds between wallets (same user)
   */
  async internalTransfer(userId: string, request: TransferRequest): Promise<boolean> {
    if (request.amount <= 0) throw new Error('Transfer amount must be positive');
    if (request.fromWallet === request.toWallet) throw new Error('Cannot transfer to same wallet');

    const { error } = await retryAsync(async () => {
      const res = await supabase.rpc('wallet_internal_transfer', {
        p_user_id: userId,
        p_from_wallet: request.fromWallet,
        p_to_wallet: request.toWallet,
        p_amount: request.amount,
        p_note: request.note || null,
      });
      return res;
    });

    if (error) throw error;

    // Log both sides of the transfer
    const desc = request.note || `Transfer ${request.fromWallet} → ${request.toWallet}`;
    await this.logTransaction(
      userId,
      request.fromWallet,
      request.amount,
      'debit',
      'transfer',
      desc
    );
    await this.logTransaction(userId, request.toWallet, request.amount, 'credit', 'transfer', desc);

    // Emit bus event so UI (header balances, cashier) updates immediately
    masterBus.emit('BALANCE_UPDATED', { source: 'internal_transfer', userId });

    return true;
  },

  /**
   * Agent self-transfer: Business → Player (to play at tables)
   */
  async agentSelfTransfer(agentId: string, amount: number): Promise<boolean> {
    return this.internalTransfer(agentId, {
      fromWallet: 'BUSINESS',
      toWallet: 'PLAYER',
      amount,
      note: 'Agent self-transfer for gameplay',
    });
  },

  /**
   * Transfer chips to another user
   */
  async transferToUser(
    fromUserId: string,
    toUserId: string,
    amount: number,
    fromWallet: WalletType = 'PLAYER',
    toWallet: WalletType = 'PLAYER'
  ): Promise<boolean> {
    if (amount <= 0) throw new Error('Transfer amount must be positive');

    const { error } = await retryAsync(async () => {
      const res = await supabase.rpc('wallet_user_transfer', {
        p_from_user_id: fromUserId,
        p_to_user_id: toUserId,
        p_amount: amount,
        p_from_wallet: fromWallet,
        p_to_wallet: toWallet,
      });
      return res;
    });

    if (error) throw error;

    // Log both sides of the user-to-user transfer
    await this.logTransaction(
      fromUserId,
      fromWallet,
      amount,
      'debit',
      'transfer',
      `Sent ${amount} chips to user`,
      undefined,
      undefined,
      toUserId
    );
    await this.logTransaction(
      toUserId,
      toWallet,
      amount,
      'credit',
      'transfer',
      `Received ${amount} chips from user`,
      undefined,
      undefined,
      fromUserId
    );

    // Emit bus events for both users so their UIs update immediately
    masterBus.emit('BALANCE_UPDATED', { source: 'transfer_sent', userId: fromUserId });
    masterBus.emit('BALANCE_UPDATED', { source: 'transfer_received', userId: toUserId });

    return true;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // PROMO DISTRIBUTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Distribute promo chips to a player
   */
  async distributePromo(agentId: string, playerId: string, amount: number): Promise<boolean> {
    if (amount <= 0) throw new Error('Amount must be positive');

    const { error } = await retryAsync(
      () =>
        supabase.rpc('distribute_promo_chips', {
          p_agent_id: agentId,
          p_player_id: playerId,
          p_amount: amount,
        }),
      3
    );

    if (error) throw error;

    masterBus.emit('BALANCE_UPDATED', { source: 'promo', userId: playerId });

    return true;
  },

  /**
   * Bulk promo distribution (leaderboard rewards, etc.)
   */
  async bulkDistributePromo(
    agentId: string,
    distributions: Array<{ playerId: string; amount: number }>
  ): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const dist of distributions) {
      try {
        await this.distributePromo(agentId, dist.playerId, dist.amount);
        success++;
      } catch (err) {
        console.error(`[WalletService] distributePromo failed for player ${dist.playerId}:`, err);
        failed++;
      }
    }

    return { success, failed };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TABLE OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Lock chips for table buy-in
   * Deducts from Player Wallet (wallets table) using atomic RPC
   * Chip flow: Union → Club Bank → Agent Wallet → Player Wallet → Table Buy-in
   */
  async lockForBuyIn(userId: string, tableId: string, amount: number): Promise<boolean> {
    // Atomically deduct from Player Wallet AND LOG using SECURITY DEFINER RPC.
    // The RPC returns false if insufficient balance —- no separate pre-check needed.
    // (Removing the pre-check eliminates a TOCTOU race condition where two concurrent
    // buy-ins could both pass the SELECT check but one would fail the deduct.)
    const { data: deductResult, error: deductError } = await retryAsync(async () => {
      const res = await supabase.rpc('atomic_deduct_wallet_and_log', {
        p_user_id: userId,
        p_amount: amount,
        p_category: 'buyin',
        p_description: 'Cash game buy-in at table',
        p_table_id: tableId,
        p_hand_id: null,
        p_related_entity_id: null,
      });
      return res;
    });

    if (deductError) {
      console.error(
        '[WalletService] atomic_deduct_wallet_and_log RPC failed:',
        deductError.message
      );
      throw new Error(`Buy-in failed: ${deductError.message}`);
    }

    if (deductResult === false) {
      throw new Error('Insufficient chips in Player Wallet for buy-in');
    }

    // Emit bus event so CashierPage/PlayerWalletPage refresh balances
    masterBus.emit('BALANCE_UPDATED', { source: 'buyin', userId, tableId });

    console.debug(
      `[WalletService] Buy-in: ${amount} chips deducted from Player Wallet for user ${userId} and logged`
    );
    return true;
  },

  /**
   * Credit chips on cash-out from table
   * Credits to Player Wallet (wallets table) using atomic RPC
   */
  async unlockFromTable(userId: string, tableId: string, amount: number): Promise<boolean> {
    // Credit to Player Wallet AND LOG using SECURITY DEFINER RPC
    const { error: creditError } = await retryAsync(async () => {
      const res = await supabase.rpc('atomic_credit_wallet_and_log', {
        p_user_id: userId,
        p_amount: amount,
        p_category: 'cashout',
        p_description: 'Cash game cash-out from table',
        p_table_id: tableId,
        p_hand_id: null,
        p_related_entity_id: null,
      });
      return res;
    });

    if (creditError) {
      console.error(
        '[WalletService] atomic_credit_wallet_and_log RPC failed:',
        creditError.message
      );
      throw new Error(`Cash-out failed: ${creditError.message}`);
    }

    // Emit bus event so CashierPage/PlayerWalletPage refresh balances
    masterBus.emit('BALANCE_UPDATED', { source: 'cashout', userId, tableId });

    console.debug(
      `[WalletService] Cash-out: ${amount} chips credited to Player Wallet for user ${userId} and logged`
    );
    return true;
  },

  /**
   * Log a wallet transaction for audit trail
   * All chip movements are recorded as currency-grade transactions
   */
  async logTransaction(
    userId: string,
    walletType: string,
    amount: number,
    type: 'credit' | 'debit',
    category: string,
    description: string,
    tableId?: string,
    handId?: string,
    relatedEntityId?: string
  ): Promise<void> {
    try {
      // Use SECURITY DEFINER RPC to bypass RLS on wallet_transactions
      const { error } = await retryAsync(
        () =>
          supabase.rpc('log_wallet_transaction', {
            p_user_id: userId,
            p_wallet_type: walletType,
            p_amount: amount,
            p_type: type,
            p_category: category,
            p_description: description,
            p_table_id: tableId || null,
            p_hand_id: handId || null,
            p_related_entity_id: relatedEntityId || null,
          }),
        3
      );
      if (error) {
        console.error('[WalletService] Transaction log RPC failed:', error.message);
        // PARTIAL FAILURE RECOVERY: financial op succeeded but audit trail failed
        // Fire a critical alert so ops can manually reconcile
        FinancialAlertService.logCritical(
          'WalletService.logTransaction',
          'Transaction log failed after successful financial operation — audit trail gap',
          { userId, walletType, amount, type, category, description, rpcError: error.message }
        );
      }
    } catch (err: unknown) {
      console.error('[WalletService] Transaction log error:', err);
      FinancialAlertService.logCritical(
        'WalletService.logTransaction',
        'Transaction log threw exception — audit trail gap',
        { userId, walletType, amount, type, category, error: String(err) }
      );
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // TRANSACTION HISTORY
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get transaction history for a user
   */
  async getTransactionHistory(
    userId: string,
    options?: {
      walletType?: WalletType;
      category?: TransactionRecord['category'];
      limit?: number;
      offset?: number;
    }
  ): Promise<TransactionRecord[]> {
    let query = supabase
      .from('wallet_transactions')
      .select(
        'id, user_id, wallet_type, amount, type, category, description, related_entity_id, created_at'
      )
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(options?.limit || 50);

    if (options?.walletType) {
      query = query.eq('wallet_type', options.walletType);
    }
    if (options?.category) {
      query = query.eq('category', options.category);
    }
    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 50) - 1);
    }

    const { data, error } = await query;
    if (error) throw error;

    return data.map((t) => ({
      id: t.id,
      userId: t.user_id,
      walletType: t.wallet_type as WalletType,
      amount: t.amount,
      type: t.type,
      category: t.category,
      description: t.description,
      relatedEntityId: t.related_entity_id,
      createdAt: t.created_at,
    }));
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SETTLEMENT OPERATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Credit commission to agent's business wallet
   */
  async creditCommission(agentId: string, amount: number, periodId: string): Promise<boolean> {
    const { error } = await retryAsync(
      () =>
        supabase.rpc('credit_agent_commission', {
          p_agent_id: agentId,
          p_amount: amount,
          p_period_id: periodId,
        }),
      3
    );

    if (error) throw error;
    masterBus.emit('BALANCE_UPDATED', { source: 'commission', userId: agentId, amount });
    return true;
  },

  /**
   * Process rakeback to player's wallet
   */
  async creditRakeback(playerId: string, amount: number, periodId: string): Promise<boolean> {
    const { error } = await retryAsync(
      () =>
        supabase.rpc('credit_player_rakeback', {
          p_player_id: playerId,
          p_amount: amount,
          p_period_id: periodId,
        }),
      3
    );

    if (error) throw error;
    masterBus.emit('BALANCE_UPDATED', { source: 'rakeback', userId: playerId, amount });
    return true;
  },

  /**
   * Process dealer tip from player's table stack
   */
  async processDealerTip(userId: string, tableId: string, amount: number): Promise<boolean> {
    if (amount <= 0) throw new Error('Tip amount must be positive');

    // Attempt atomic RPC first: UPDATE ... SET amount = amount - $1 WHERE amount >= $1
    const { error: rpcError } = await retryAsync(
      () =>
        supabase.rpc('deduct_table_chip_lock', {
          p_user_id: userId,
          p_table_id: tableId,
          p_amount: amount,
        }),
      3
    );

    if (rpcError) {
      console.error('[WalletService] deduct_table_chip_lock RPC failed:', rpcError.message);
      throw new Error(`Failed to deduct dealer tip: ${rpcError.message}`);
    }

    // Record tip transaction
    await this.logTransaction(
      userId,
      'PLAYER',
      amount,
      'debit',
      'TIP',
      'Dealer tip at table',
      tableId
    );

    return true;
  },

  /**
   * Process insurance purchase from player's table stack
   */
  async processInsurance(
    userId: string,
    tableId: string,
    handId: string,
    premium: number
  ): Promise<boolean> {
    if (premium <= 0) throw new Error('Insurance premium must be positive');

    // Atomic conditional update — deducts only if sufficient balance exists.
    const { error } = await retryAsync(
      () =>
        supabase.rpc('deduct_table_chip_lock', {
          p_user_id: userId,
          p_table_id: tableId,
          p_amount: premium,
        }),
      3
    );

    if (error) {
      console.error('[WalletService] deduct_table_chip_lock RPC failed:', error.message);
      throw new Error(`Failed to deduct insurance premium: ${error.message}`);
    }

    // Record insurance transaction
    await this.logTransaction(
      userId,
      'PLAYER',
      premium,
      'debit',
      'INSURANCE',
      'Insurance premium',
      tableId,
      handId
    );

    return true;
  },
};

export default WalletService;
