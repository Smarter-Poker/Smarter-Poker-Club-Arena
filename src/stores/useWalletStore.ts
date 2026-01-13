/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Wallet Store (Zustand)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Global state for the Triple-Wallet system (Business, Player, Promo)
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ═══════════════════════════════════════════════════════════════════════════════
// 📦 TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type WalletType = 'BUSINESS' | 'PLAYER' | 'PROMO';

export interface WalletBalance {
    type: WalletType;
    available: number;
    locked: number;
    pending: number;
    total: number;
}

export interface WalletTransaction {
    id: string;
    walletType: WalletType;
    amount: number;
    direction: 'credit' | 'debit';
    category: 'buy_in' | 'cash_out' | 'transfer' | 'mint' | 'commission' | 'rakeback' | 'promo';
    description: string;
    timestamp: string;
    reference?: string;
}

interface WalletState {
    // Wallet balances
    balances: {
        BUSINESS: WalletBalance;
        PLAYER: WalletBalance;
        PROMO: WalletBalance;
    };
    isLoadingWallet: boolean;

    // Diamond balance
    diamonds: number;
    isLoadingDiamonds: boolean;

    // Transaction history
    transactions: WalletTransaction[];
    isLoadingTransactions: boolean;

    // Pending operations
    pendingBuyIn: number | null;
    pendingTableId: string | null;

    // Actions
    loadBalances: (userId: string) => Promise<void>;
    loadDiamonds: (userId: string) => Promise<void>;
    loadTransactions: (userId: string, limit?: number) => Promise<void>;
    refreshAll: (userId: string) => Promise<void>;

    // Wallet operations
    lockForBuyIn: (amount: number, tableId: string) => Promise<boolean>;
    unlockFromTable: (amount: number, tableId: string) => Promise<boolean>;
    internalTransfer: (fromWallet: WalletType, toWallet: WalletType, amount: number) => Promise<boolean>;
    mintChips: (diamonds: number) => Promise<{ chips: number; success: boolean }>;

    reset: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📐 CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

// The 38/100 Diamond-to-Chip Law
const DIAMOND_TO_CHIP_RATE = 100 / 38; // ~2.63 chips per diamond

const createEmptyBalance = (type: WalletType): WalletBalance => ({
    type,
    available: 0,
    locked: 0,
    pending: 0,
    total: 0,
});

const initialState = {
    balances: {
        BUSINESS: createEmptyBalance('BUSINESS'),
        PLAYER: createEmptyBalance('PLAYER'),
        PROMO: createEmptyBalance('PROMO'),
    },
    isLoadingWallet: false,
    diamonds: 0,
    isLoadingDiamonds: false,
    transactions: [] as WalletTransaction[],
    isLoadingTransactions: false,
    pendingBuyIn: null as number | null,
    pendingTableId: null as string | null,
};

// ═══════════════════════════════════════════════════════════════════════════════
// 🏪 STORE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

export const useWalletStore = create<WalletState>()(
    persist(
        (set, get) => ({
            ...initialState,

            loadBalances: async (userId: string) => {
                set({ isLoadingWallet: true });
                try {
                    // In production, this calls WalletService.getBalances(userId)
                    // For demo, use mock data
                    const mockBalances = {
                        BUSINESS: { type: 'BUSINESS' as const, available: 5420.50, locked: 0, pending: 1200, total: 6620.50 },
                        PLAYER: { type: 'PLAYER' as const, available: 10000, locked: 500, pending: 0, total: 10500 },
                        PROMO: { type: 'PROMO' as const, available: 250, locked: 0, pending: 0, total: 250 },
                    };
                    set({ balances: mockBalances });
                } catch (error) {
                    console.error('🔴 Load balances failed:', error);
                } finally {
                    set({ isLoadingWallet: false });
                }
            },

            loadDiamonds: async (userId: string) => {
                set({ isLoadingDiamonds: true });
                try {
                    // Mock diamond balance
                    set({ diamonds: 1250 });
                } catch (error) {
                    console.error('🔴 Load diamonds failed:', error);
                } finally {
                    set({ isLoadingDiamonds: false });
                }
            },

            loadTransactions: async (userId: string, limit = 50) => {
                set({ isLoadingTransactions: true });
                try {
                    // Mock transactions
                    const mockTx: WalletTransaction[] = [
                        {
                            id: 'tx1',
                            walletType: 'PLAYER',
                            amount: 500,
                            direction: 'debit',
                            category: 'buy_in',
                            description: 'Table Buy-in: NL100 Ring Game',
                            timestamp: new Date().toISOString(),
                            reference: 'table_123',
                        },
                        {
                            id: 'tx2',
                            walletType: 'BUSINESS',
                            amount: 1200,
                            direction: 'credit',
                            category: 'commission',
                            description: 'Weekly Commission Payout',
                            timestamp: new Date(Date.now() - 86400000).toISOString(),
                        },
                    ];
                    set({ transactions: mockTx });
                } catch (error) {
                    console.error('🔴 Load transactions failed:', error);
                } finally {
                    set({ isLoadingTransactions: false });
                }
            },

            refreshAll: async (userId: string) => {
                await Promise.all([
                    get().loadBalances(userId),
                    get().loadDiamonds(userId),
                    get().loadTransactions(userId),
                ]);
            },

            lockForBuyIn: async (amount: number, tableId: string) => {
                const { balances } = get();
                if (balances.PLAYER.available < amount) {
                    console.error('❌ Insufficient balance for buy-in');
                    return false;
                }

                set({
                    pendingBuyIn: amount,
                    pendingTableId: tableId,
                    balances: {
                        ...balances,
                        PLAYER: {
                            ...balances.PLAYER,
                            available: balances.PLAYER.available - amount,
                            locked: balances.PLAYER.locked + amount,
                        },
                    },
                });

                // In production: await WalletService.lockForBuyIn(...)
                return true;
            },

            unlockFromTable: async (amount: number, tableId: string) => {
                const { balances, pendingTableId } = get();
                if (pendingTableId !== tableId) {
                    console.warn('⚠️ Table ID mismatch for unlock');
                }

                set({
                    pendingBuyIn: null,
                    pendingTableId: null,
                    balances: {
                        ...balances,
                        PLAYER: {
                            ...balances.PLAYER,
                            available: balances.PLAYER.available + amount,
                            locked: Math.max(0, balances.PLAYER.locked - amount),
                        },
                    },
                });

                // In production: await WalletService.unlockFromTable(...)
                return true;
            },

            internalTransfer: async (fromWallet: WalletType, toWallet: WalletType, amount: number) => {
                const { balances } = get();
                if (balances[fromWallet].available < amount) {
                    console.error('❌ Insufficient balance for transfer');
                    return false;
                }

                set({
                    balances: {
                        ...balances,
                        [fromWallet]: {
                            ...balances[fromWallet],
                            available: balances[fromWallet].available - amount,
                            total: balances[fromWallet].total - amount,
                        },
                        [toWallet]: {
                            ...balances[toWallet],
                            available: balances[toWallet].available + amount,
                            total: balances[toWallet].total + amount,
                        },
                    },
                });

                // In production: await WalletService.internalTransfer(...)
                return true;
            },

            mintChips: async (diamonds: number) => {
                const { diamonds: currentDiamonds, balances } = get();
                if (currentDiamonds < diamonds) {
                    console.error('❌ Insufficient diamonds for minting');
                    return { chips: 0, success: false };
                }

                // Apply the 38/100 Law: 38 diamonds = 100 chips
                const chips = Math.floor(diamonds * DIAMOND_TO_CHIP_RATE);

                set({
                    diamonds: currentDiamonds - diamonds,
                    balances: {
                        ...balances,
                        PLAYER: {
                            ...balances.PLAYER,
                            available: balances.PLAYER.available + chips,
                            total: balances.PLAYER.total + chips,
                        },
                    },
                });

                // In production: await WalletService.mintChips(...)
                return { chips, success: true };
            },

            reset: () => {
                set(initialState);
            },
        }),
        {
            name: 'wallet-store',
            partialize: () => ({}), // Don't persist wallet data for security
        }
    )
);

// ═══════════════════════════════════════════════════════════════════════════════
// 📐 HELPER HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

export function useTotalBalance() {
    const balances = useWalletStore((s) => s.balances);
    return balances.BUSINESS.total + balances.PLAYER.total + balances.PROMO.total;
}

export function useAvailableChips() {
    const balances = useWalletStore((s) => s.balances);
    return balances.PLAYER.available;
}

export function useCanBuyIn(amount: number) {
    const balances = useWalletStore((s) => s.balances);
    return balances.PLAYER.available >= amount;
}
