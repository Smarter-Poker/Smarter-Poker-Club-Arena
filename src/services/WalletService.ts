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
import { resolveClubUUID } from '../utils/clubIdResolver';
import { retryAsync } from '../utils/retryAsync';
import { masterBus } from '../core/MasterBus';
import { FinancialAlertService } from './FinancialAlertService';
import { reportError } from '../utils/errorReporter';
import { useUserStore } from '../stores/useUserStore';

// ═══════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY (Audit finding M1)
// ═══════════════════════════════════════════════════════════════════════════════
//
// AUDIT M17: `newIdempotencyKey` is removed along with its one caller.
//
// It existed for M1: client money RPCs are wrapped in retryAsync, so a
// commit-then-timeout could re-apply a credit unless every retry of one logical
// operation shared a key. That reasoning was correct, and it is now moot from
// this side — the client no longer initiates a wallet credit at all. Both
// generic credit wrappers are revoked from `authenticated`, and every client
// feature that used to credit now calls a purpose-built SECURITY DEFINER
// function that owns its own idempotency key, derived from the thing being paid
// for (`bonus:<id>`, `cashout:<seat_id>`, `daily_bonus:<user>:<date>`).
//
// That is the stronger design regardless of grants: a key minted by the browser
// only de-duplicates retries the browser knows about, whereas a key derived
// from the underlying row de-duplicates against every path that could pay it,
// including the engine's.
//
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
  /** Reason for a failed mint, surfaced to the user instead of a generic retry. */
  error?: string;
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
    // Resolve the authenticated minter. Server-side authorization is enforced by
    // mint_club_chips (which now rejects a null minter), but we resolve it here so
    // the union-lock check below is never silently skipped when a caller omits the
    // id — previously callers that passed no requestingUserId bypassed the lock.
    let minterId = requestingUserId;
    if (!minterId) {
      const { data: authData } = await supabase.auth.getUser();
      minterId = authData?.user?.id;
    }
    if (!minterId) throw new Error('Authentication required to mint chips');

    // clubId from a route param may be an integer club_id; resolve to the uuid PK so
    // the lookup and the mint_club_chips RPC (uuid arg) don't reject it.
    const resolvedClubId = await resolveClubUUID(clubId);

    // 1. Check if club belongs to a union
    const { data: club } = await supabase
      .from('clubs')
      .select('id, name, owner_id, union_id')
      .eq('id', resolvedClubId)
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
      if (minterId !== union.owner_id) {
        throw new Error(
          `Minting is locked for clubs in a union. Only the Union owner (${union.name}) can mint chips. ` +
            `Contact your union owner for chip allocation.`
        );
      }
    }

    // 3. Calculate diamond cost
    const diamondCost = Math.ceil((chipAmount / 100) * 38);

    // Mint SERVER-SIDE via the World Hub API route. mint_club_chips is
    // service_role-only, so a direct browser supabase.rpc() returns 42501 -- that
    // was the dead "Mint" button this replaces. The route derives the minter from
    // the JWT (no client-supplied minter to spoof), enforces owner/union-admin
    // authorization, per-request + daily economy caps, settlement lock,
    // idempotency, and writes the chip_transactions mint row + audit log.
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Authentication required to mint chips');

    const mintResp = await fetch('/api/club-arena/mint-chips', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({
        clubId: resolvedClubId,
        amount: chipAmount,
        notes: club.union_id ? 'Union mint' : 'Standalone club mint',
      }),
    });
    const mintData = await mintResp
      .json()
      .catch(() => ({ success: false, error: `HTTP ${mintResp.status}` }));
    if (!mintData.success) {
      throw new Error(mintData.error || `Mint failed (HTTP ${mintResp.status})`);
    }

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
          : `Club mint: ${chipAmount} chips (${diamondCost} diamonds spent) - standalone club`,
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
      newBalance: mintData.treasuryAfter ?? 0,
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

    const desc = request.note || `Transfer ${request.fromWallet} → ${request.toWallet}`;
    // Atomic wallet-TYPE transfer for a single user via SECURITY DEFINER RPC.
    // fn_wallet_type_transfer moves chips between wallet types (BUSINESS/PLAYER/PROMO)
    // in ONE transaction, honoring the real from/to wallets — this replaces the old
    // atomic_deduct + atomic_credit pair which was hardcoded to PLAYER (cross-wallet
    // no-op, plus a deduct-then-credit chip-loss edge if the credit leg failed).
    const { data: transferRes, error } = await retryAsync(async () => {
      const res = await supabase.rpc('fn_wallet_type_transfer', {
        p_user_id: userId,
        p_from_wallet: request.fromWallet,
        p_to_wallet: request.toWallet,
        p_amount: request.amount,
        p_note: desc,
      });
      return res;
    });

    if (error) throw error;
    if (!transferRes?.success) {
      throw new Error(transferRes?.error || 'Insufficient balance for transfer');
    }

    // Log both sides of the transfer (RPCs already log, but this provides app-level audit trail)
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
        reportError(err, 'WalletService.bulkDistributePromo', { playerId: dist.playerId });
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
    // VALIDATION: Prevent negative/zero/non-integer amounts before RPC call
    if (!amount || amount <= 0 || !Number.isFinite(amount)) {
      throw new Error('Buy-in amount must be a positive number');
    }

    // Atomically deduct from Player Wallet AND LOG using SECURITY DEFINER RPC.
    // The RPC returns false if insufficient balance —- no separate pre-check needed.
    // (Removing the pre-check eliminates a TOCTOU race condition where two concurrent
    // buy-ins could both pass the SELECT check but one would fail the deduct.)
    // NOTE (Audit M1): buy-in DEDUCTION is engine-owned — atomic_deduct_wallet_and_log
    // is service-role only, so client-side idempotency belongs on the server buy-in
    // path (atomic_table_buyin), not here. The cash-out CREDIT path (unlockFromTable)
    // is the client-initiated money mover and is made idempotent below.
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
      reportError(deductError, 'WalletService.lockForBuyIn', { userId, tableId, amount });
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

  // AUDIT M17: `unlockFromTable` is deleted, not repaired.
  //
  // It was the client-initiated cash-out: it credited the PLAYER wallet with the
  // amount the player TYPED INTO THE CASHIER, through a generic credit RPC, with
  // no seat-stack decrement anywhere on the path. `useWalletStore` adjusted
  // `locked` optimistically in browser memory and reverted on throw, which is
  // presentation, not accounting. So the only thing standing between this
  // function and an unlimited chip mint was the RLS policy that refused the
  // credit — which is also why M1's idempotency fix for this exact call site
  // could never have taken effect.
  //
  // Table cash-out is engine-owned. `TablePage.handleWithdrawChips` calls
  // `GameServerAPI.removeChips` -> `atomic_table_withdraw`, which credits the
  // wallet and reduces the seat stack atomically, only between hands, using the
  // authoritative stack rather than a text box. Leaving a table entirely goes
  // through the engine's `markSeatAsLeft`, which credits the actual seat stack
  // and refuses to vacate the seat if the credit fails.
  //
  // The Cashier now routes the player to the table instead of moving money,
  // exactly as its 'buyin' branch already did for the same reason.

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
      // Also write to chip_ledger (immutable append-only audit trail)
      // Guard: chip_ledger has amount > 0 CHECK constraint — skip zero-amount entries
      const ledgerAmount = Math.abs(amount);
      if (ledgerAmount > 0) {
        supabase
          .from('chip_ledger')
          .insert({
            performed_by: userId,
            from_type:
              type === 'debit'
                ? 'player_wallet'
                : relatedEntityId
                  ? 'player_wallet'
                  : 'system_mint',
            from_entity_id: type === 'debit' ? userId : relatedEntityId,
            to_type:
              type === 'credit'
                ? 'player_wallet'
                : relatedEntityId
                  ? 'player_wallet'
                  : 'system_burn',
            to_entity_id: type === 'credit' ? userId : relatedEntityId,
            amount: ledgerAmount,
            category,
            description,
            table_id: tableId || undefined,
            hand_id: handId || undefined,
          })
          .then(({ error: ledgerErr }) => {
            if (ledgerErr) reportError(ledgerErr, 'WalletService.chip_ledger_write_failed');
          });
      }

      if (error) {
        reportError(error, 'WalletService.logTransaction', {
          userId,
          walletType,
          amount,
          type,
          category,
        });
        // PARTIAL FAILURE RECOVERY: financial op succeeded but audit trail failed
        // Fire a critical alert so ops can manually reconcile
        // FIX: await the async logCritical call to prevent unhandled rejections
        await FinancialAlertService.logCritical(
          'WalletService.logTransaction',
          'Transaction log failed after successful financial operation - audit trail gap',
          { userId, walletType, amount, type, category, description, rpcError: error.message }
        );
      }
    } catch (err: unknown) {
      reportError(err, 'WalletService.logTransaction.catch', {
        userId,
        walletType,
        amount,
        type,
        category,
      });
      // FIX: await the async logCritical call to prevent unhandled rejections
      await FinancialAlertService.logCritical(
        'WalletService.logTransaction',
        'Transaction log threw exception - audit trail gap',
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
          p_description: `Commission for period ${periodId}`,
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
          p_user_id: playerId,
          p_amount: amount,
          p_description: `Rakeback payout for period ${periodId}`,
        }),
      3
    );

    if (error) throw error;
    masterBus.emit('BALANCE_UPDATED', { source: 'rakeback', userId: playerId, amount });
    return true;
  },

  // NOTE: dealer tipping was REMOVED ENTIRELY on 2026-08-20, by product
  // decision — Smarter Poker does not have dealers to tip and will not be
  // adding the feature. Everything that implemented it is gone: this service's
  // processDealerTip, the TipDealer modal, GameServerAPI.tipDealer, the
  // POST /tipdealer route, the engine's tipDealer method, and both database
  // functions (atomic_table_dealer_tip and deduct_table_chip_lock).
  //
  // Kept as a note because the old path was actively dangerous and should not
  // be recreated from memory: it called deduct_table_chip_lock from the
  // browser, writing table_seats.stack while the authoritative engine held a
  // different figure in memory. The next settlement overwrote the DB from
  // memory, so the player's stack came back while clubs.chip_treasury kept the
  // tip — it MINTED chips. Verified against prod before removal: zero rows had
  // ever been written with category 'TIP', so nothing was lost.

  // NOTE: processInsurance was removed — insurance is settled server-side by the
  // authoritative engine (it called the non-existent deduct_table_chip_lock RPC
  // and had zero call sites in the client).

  // ─────────────────────────────────────────────────────────────────────────────
  // DIRECT WALLET READS (routed from bypassing queries)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get a specific wallet for a user (raw balance fields)
   */
  async getWallet(
    userId: string,
    walletType: WalletType
  ): Promise<{ balance: number; locked_balance: number } | null> {
    const { data, error } = await supabase
      .from('wallets')
      .select('balance, locked_balance')
      .eq('user_id', userId)
      .eq('wallet_type', walletType)
      .maybeSingle();
    if (error) {
      reportError(error, 'WalletService.getWallet', { userId, walletType });
      return null;
    }
    return data;
  },

  /**
   * Get all wallets for a user
   */
  async getWallets(
    userId: string
  ): Promise<Array<{ wallet_type: string; balance: number; locked_balance: number }>> {
    const { data, error } = await supabase
      .from('wallets')
      .select('wallet_type, balance, locked_balance')
      .eq('user_id', userId);
    if (error) {
      reportError(error, 'WalletService.getWallets', { userId });
      return [];
    }
    return data || [];
  },

  /**
   * Get player wallet balance (shorthand for the most common query)
   */
  async getPlayerBalance(
    userId: string,
    opts?: { clubId?: string | null; tableId?: string | null }
  ): Promise<number> {
    // UNION LAW (Dan 2026-08-20): under club-scoped chips a player spends the
    // chips of the club they entered through, not the global player wallet.
    // fn_player_spendable_balance resolves this with EXACTLY the same rule the
    // buy-in uses, so what we display can never disagree with what the
    // transaction will actually spend. Falls back to the global wallet when
    // club scoping is off or no club context resolves.
    try {
      const clubId = opts?.clubId ?? useUserStore.getState().currentClubId ?? null;
      const { data, error } = await supabase.rpc('fn_player_spendable_balance', {
        p_user_id: userId,
        p_club_id: clubId,
        p_table_id: opts?.tableId ?? null,
      });
      if (!error && data && typeof (data as any).balance !== 'undefined') {
        return Number((data as any).balance) || 0;
      }
    } catch {
      /* fall through to the legacy wallet read */
    }
    const wallet = await this.getWallet(userId, 'PLAYER');
    return wallet?.balance ?? 0;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // WALLET PROVISIONING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ensure wallets exist for a user. Creates zero-balance wallets idempotently.
   * Use this instead of direct .from('wallets').insert() to ensure consistent
   * schema and avoid race conditions.
   *
   * @param userId - User ID
   * @param walletTypes - Array of wallet types to ensure exist (default: all three)
   */
  async ensureWalletsExist(
    userId: string,
    walletTypes: WalletType[] = ['PLAYER', 'BUSINESS', 'PROMO']
  ): Promise<void> {
    for (const walletType of walletTypes) {
      const { error } = await supabase.from('wallets').upsert(
        {
          user_id: userId,
          wallet_type: walletType,
          balance: 0,
          locked_balance: 0,
        },
        { onConflict: 'user_id,wallet_type', ignoreDuplicates: true }
      );
      if (error) {
        reportError(error, 'WalletService.ensureWalletsExist', { userId, walletType });
      }
    }
  },
};

export default WalletService;
