/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Wallet Store (Zustand)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Global state for the Triple-Wallet system (Business, Player, Promo)
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { supabase } from '../lib/supabase';
import { WalletService } from '../services/WalletService';
import { DiamondService } from '../services/DiamondService';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// MODULE-LEVEL CIRCUIT BREAKERS — prevent repeated Sentry floods on persistent RLS errors
// Each breaker trips after 3 failures and resets after 5 min cooldown.
// ═══════════════════════════════════════════════════════════════════════════════
function makeCircuitBreaker(cooldownMs = 5 * 60_000) {
  let failures = 0,
    trippedAt = 0;
  return {
    isOpen(): boolean {
      if (failures < 3) return false;
      if (Date.now() - trippedAt > cooldownMs) {
        failures = 0;
        trippedAt = 0;
        return false;
      }
      return true;
    },
    trip(): void {
      failures++;
      if (failures >= 3 && trippedAt === 0) trippedAt = Date.now();
    },
  };
}
const _txBreaker = makeCircuitBreaker();
const _balanceBreaker = makeCircuitBreaker();
const _diamondBreaker = makeCircuitBreaker();

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
  // Mutex flag: prevents concurrent lock/unlock/transfer from racing
  _operationInFlight: boolean;

  // Actions
  loadBalances: (userId: string) => Promise<void>;
  loadDiamonds: (userId: string) => Promise<void>;
  loadTransactions: (userId: string, limit?: number) => Promise<void>;
  refreshAll: (userId: string) => Promise<void>;

  // Wallet operations
  lockForBuyIn: (userId: string, amount: number, tableId: string) => Promise<boolean>;
  internalTransfer: (
    userId: string,
    fromWallet: WalletType,
    toWallet: WalletType,
    amount: number
  ) => Promise<boolean>;
  mintChips: (
    clubId: string,
    chips: number
  ) => Promise<{ chips: number; success: boolean; error?: string }>;

  reset: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 📐 CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

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
  _operationInFlight: false,
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
          const walletBalances = await WalletService.getBalances(userId);
          const balances = {
            BUSINESS: createEmptyBalance('BUSINESS'),
            PLAYER: createEmptyBalance('PLAYER'),
            PROMO: createEmptyBalance('PROMO'),
          };

          for (const wallet of walletBalances) {
            const type = wallet.walletType as WalletType;
            if (type in balances) {
              balances[type] = {
                type,
                available: wallet.availableBalance,
                locked: wallet.lockedBalance,
                pending: 0,
                total: wallet.balance,
              };
            }
          }

          set({ balances });
        } catch (error) {
          if (!_balanceBreaker.isOpen()) {
            _balanceBreaker.trip();
            reportError(error, 'useWalletStore.Load_balances_failed');
          }
        } finally {
          set({ isLoadingWallet: false });
        }
      },

      loadDiamonds: async (userId: string) => {
        set({ isLoadingDiamonds: true });
        try {
          // Load diamonds via centralized DiamondService (profiles.diamonds source-of-truth)
          const wallet = await DiamondService.getBalance(userId);
          set({ diamonds: wallet.balance || 0 });
        } catch (error) {
          if (!_diamondBreaker.isOpen()) {
            _diamondBreaker.trip();
            reportError(error, 'useWalletStore.Load_diamonds_failed');
          }
          set({ diamonds: 0 });
        } finally {
          set({ isLoadingDiamonds: false });
        }
      },

      loadTransactions: async (userId: string, limit = 25) => {
        set({ isLoadingTransactions: true });
        try {
          const txHistory = await WalletService.getTransactionHistory(userId, { limit });
          const transactions: WalletTransaction[] = txHistory.map((tx) => ({
            id: tx.id,
            walletType: tx.walletType as WalletType,
            amount: tx.amount,
            direction: tx.type as 'credit' | 'debit',
            category: tx.category as WalletTransaction['category'],
            description: tx.description,
            timestamp: tx.createdAt,
            reference: tx.relatedEntityId,
          }));
          set({ transactions });
        } catch (error) {
          if (!_txBreaker.isOpen()) {
            _txBreaker.trip();
            reportError(error, 'useWalletStore.Load_transactions_failed');
          }
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

      lockForBuyIn: async (userId: string, amount: number, tableId: string) => {
        // Mutex: prevent concurrent wallet operations from racing
        if (get()._operationInFlight) {
          console.warn('[Store] Wallet operation already in flight, skipping lockForBuyIn');
          return false;
        }

        const { balances } = get();
        if (balances.PLAYER.available < amount) {
          reportError(
            new Error('[Store] Insufficient balance for buy-in'),
            'useWalletStore.Insufficient_balance_for_buyin'
          );
          return false;
        }

        // Deep copy for safe rollback
        const previousBalances = JSON.parse(JSON.stringify(balances));

        // Optimistic update + acquire mutex
        set({
          _operationInFlight: true,
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

        try {
          await WalletService.lockForBuyIn(userId, tableId, amount);
          set({ _operationInFlight: false });
          return true;
        } catch (error) {
          // Revert on failure using deep-copied state + release mutex
          set({
            _operationInFlight: false,
            pendingBuyIn: null,
            pendingTableId: null,
            balances: previousBalances,
          });
          reportError(error, 'useWalletStore.Lock_for_buyin_failed');
          return false;
        }
      },

      internalTransfer: async (
        userId: string,
        fromWallet: WalletType,
        toWallet: WalletType,
        amount: number
      ) => {
        // Mutex: prevent concurrent wallet operations from racing
        if (get()._operationInFlight) {
          console.warn('[Store] Wallet operation already in flight, skipping internalTransfer');
          return false;
        }

        const { balances } = get();
        if (balances[fromWallet].available < amount) {
          reportError(
            new Error('[Store] Insufficient balance for transfer'),
            'useWalletStore.Insufficient_balance_for_transfer'
          );
          return false;
        }

        // Deep copy for safe rollback (shallow spread shares nested object refs)
        const previousBalances = JSON.parse(JSON.stringify(balances));
        set({
          _operationInFlight: true,
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

        try {
          await WalletService.internalTransfer(userId, {
            fromWallet,
            toWallet,
            amount,
          });
          set({ _operationInFlight: false });
          return true;
        } catch (error) {
          // Revert on failure + release mutex
          set({ _operationInFlight: false, balances: previousBalances });
          reportError(error, 'useWalletStore.Internal_transfer_failed');
          return false;
        }
      },

      mintChips: async (clubId: string, chips: number) => {
        try {
          const result = await WalletService.mintChips(clubId, chips);
          if (result.success) {
            // Refresh balances after minting
            return { chips: result.chipsAdded, success: true };
          }
          return { chips: 0, success: false, error: result.error };
        } catch (error) {
          reportError(error, 'useWalletStore.Mint_chips_failed');
          // Surface the reason to the caller. Swallowing it turned
          // "Minting is locked for clubs in a union" into "please try again",
          // which is advice that can never succeed.
          return {
            chips: 0,
            success: false,
            error: error instanceof Error ? error.message : undefined,
          };
        }
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
