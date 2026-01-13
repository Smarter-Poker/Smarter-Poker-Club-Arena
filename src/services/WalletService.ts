/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 💰 WALLET SERVICE — Complete Triple-Wallet System
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

import { supabase, isDemoMode } from '../lib/supabase';

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
    category: 'mint' | 'transfer' | 'buyin' | 'cashout' | 'rake' | 'commission' | 'promo' | 'settlement';
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
// DEMO DATA
// ═══════════════════════════════════════════════════════════════════════════════

const DEMO_WALLETS: Map<string, WalletBalance[]> = new Map([
    ['user_1', [
        { userId: 'user_1', walletType: 'BUSINESS', balance: 50000, lockedBalance: 0, availableBalance: 50000, lastUpdated: new Date().toISOString() },
        { userId: 'user_1', walletType: 'PLAYER', balance: 10000, lockedBalance: 2500, availableBalance: 7500, lastUpdated: new Date().toISOString() },
        { userId: 'user_1', walletType: 'PROMO', balance: 5000, lockedBalance: 0, availableBalance: 5000, lastUpdated: new Date().toISOString() },
    ]],
]);

const DEMO_TRANSACTIONS: TransactionRecord[] = [
    { id: 't1', userId: 'user_1', walletType: 'PLAYER', amount: 10000, type: 'credit', category: 'mint', description: 'Initial chip purchase', createdAt: '2026-01-10T10:00:00Z' },
    { id: 't2', userId: 'user_1', walletType: 'PLAYER', amount: 2500, type: 'debit', category: 'buyin', description: 'Table buy-in NL200', relatedEntityId: 'table_1', createdAt: '2026-01-12T14:30:00Z' },
    { id: 't3', userId: 'user_1', walletType: 'BUSINESS', amount: 1200, type: 'credit', category: 'commission', description: 'Weekly commission payout', createdAt: '2026-01-13T00:00:00Z' },
];

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
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            return DEMO_WALLETS.get(userId) || [
                { userId, walletType: 'BUSINESS', balance: 0, lockedBalance: 0, availableBalance: 0, lastUpdated: new Date().toISOString() },
                { userId, walletType: 'PLAYER', balance: 0, lockedBalance: 0, availableBalance: 0, lastUpdated: new Date().toISOString() },
                { userId, walletType: 'PROMO', balance: 0, lockedBalance: 0, availableBalance: 0, lastUpdated: new Date().toISOString() },
            ];
        }

        const { data, error } = await supabase
            .from('wallets')
            .select('*')
            .eq('user_id', userId);

        if (error) throw error;
        return data.map(w => ({
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
        const wallet = balances.find(b => b.walletType === walletType);
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
     * Mint chips using diamonds (Club Owner Only)
     * 75% Cheaper Law: 38 Diamonds = 100 Chips
     */
    async mintChips(clubId: string, chipAmount: number): Promise<ChipMintResult> {
        // Calculate diamond cost
        const diamondCost = Math.ceil((chipAmount / 100) * 38);

        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 500));
            return {
                success: true,
                chipsAdded: chipAmount,
                diamondsSpent: diamondCost,
                newBalance: 60000 + chipAmount, // Mock
            };
        }

        const { data, error } = await supabase.rpc('mint_club_chips', {
            p_club_id: clubId,
            p_chips: chipAmount,
            p_diamonds: diamondCost,
        });

        if (error) throw error;
        return {
            success: true,
            chipsAdded: chipAmount,
            diamondsSpent: diamondCost,
            newBalance: data.new_balance,
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

        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            // Update demo data
            const wallets = DEMO_WALLETS.get(userId);
            if (wallets) {
                const from = wallets.find(w => w.walletType === request.fromWallet);
                const to = wallets.find(w => w.walletType === request.toWallet);
                if (from && to && from.availableBalance >= request.amount) {
                    from.balance -= request.amount;
                    from.availableBalance -= request.amount;
                    to.balance += request.amount;
                    to.availableBalance += request.amount;
                    return true;
                }
            }
            throw new Error('Insufficient balance');
        }

        const { error } = await supabase.rpc('wallet_internal_transfer', {
            p_user_id: userId,
            p_from_wallet: request.fromWallet,
            p_to_wallet: request.toWallet,
            p_amount: request.amount,
            p_note: request.note || null,
        });

        if (error) throw error;
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

        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 400));
            return true;
        }

        const { error } = await supabase.rpc('wallet_user_transfer', {
            p_from_user_id: fromUserId,
            p_to_user_id: toUserId,
            p_amount: amount,
            p_from_wallet: fromWallet,
            p_to_wallet: toWallet,
        });

        if (error) throw error;
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

        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        const { error } = await supabase.rpc('distribute_promo_chips', {
            p_agent_id: agentId,
            p_player_id: playerId,
            p_amount: amount,
        });

        if (error) throw error;
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
            } catch {
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
     */
    async lockForBuyIn(userId: string, tableId: string, amount: number): Promise<boolean> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            const wallets = DEMO_WALLETS.get(userId);
            if (wallets) {
                const player = wallets.find(w => w.walletType === 'PLAYER');
                if (player && player.availableBalance >= amount) {
                    player.lockedBalance += amount;
                    player.availableBalance -= amount;
                    return true;
                }
            }
            throw new Error('Insufficient available balance');
        }

        const { error } = await supabase.rpc('lock_chips_for_table', {
            p_user_id: userId,
            p_table_id: tableId,
            p_amount: amount,
        });

        if (error) throw error;
        return true;
    },

    /**
     * Unlock chips on cash-out from table
     */
    async unlockFromTable(userId: string, tableId: string, amount: number): Promise<boolean> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 200));
            const wallets = DEMO_WALLETS.get(userId);
            if (wallets) {
                const player = wallets.find(w => w.walletType === 'PLAYER');
                if (player) {
                    player.lockedBalance = Math.max(0, player.lockedBalance - amount);
                    player.availableBalance += amount;
                    return true;
                }
            }
            return false;
        }

        const { error } = await supabase.rpc('unlock_chips_from_table', {
            p_user_id: userId,
            p_table_id: tableId,
            p_amount: amount,
        });

        if (error) throw error;
        return true;
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
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            let filtered = DEMO_TRANSACTIONS.filter(t => t.userId === userId);
            if (options?.walletType) {
                filtered = filtered.filter(t => t.walletType === options.walletType);
            }
            if (options?.category) {
                filtered = filtered.filter(t => t.category === options.category);
            }
            return filtered.slice(options?.offset || 0, (options?.offset || 0) + (options?.limit || 50));
        }

        let query = supabase
            .from('wallet_transactions')
            .select('*')
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

        return data.map(t => ({
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
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        const { error } = await supabase.rpc('credit_agent_commission', {
            p_agent_id: agentId,
            p_amount: amount,
            p_period_id: periodId,
        });

        if (error) throw error;
        return true;
    },

    /**
     * Process rakeback to player's wallet
     */
    async creditRakeback(playerId: string, amount: number, periodId: string): Promise<boolean> {
        if (isDemoMode) {
            await new Promise(r => setTimeout(r, 300));
            return true;
        }

        const { error } = await supabase.rpc('credit_player_rakeback', {
            p_player_id: playerId,
            p_amount: amount,
            p_period_id: periodId,
        });

        if (error) throw error;
        return true;
    },
};

export default WalletService;
