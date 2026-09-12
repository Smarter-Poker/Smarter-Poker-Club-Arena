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

/**
 * THE WORDS `wallet_transactions.category` ACTUALLY ACCEPTS (2026-09-12).
 *
 * This list is the `wallet_transactions_category_check` vocabulary, and it is
 * the one the database enforces - not a convenient shorthand for it. A word
 * that is not on this list is not a category the wallet can record; the insert
 * raises 23514 and takes its whole transaction with it.
 *
 * It is spelled out here because the wrong spelling has now cost us twice:
 *
 *   - `HydraService.seatHorse` logged a horse buy-in as `'buy_in'` while the
 *     constraint has only ever known `'buyin'`. 8,535 rejected writes between
 *     2026-04-01 and 2026-04-14, every one of them filed unresolved in
 *     `horse_bug_reports`. That call was a duplicate of the `'buyin'` receipt
 *     written correctly two lines above it, so no money was lost - the
 *     constraint is the only reason 2,016,133.30 chips of second debit
 *     receipts did not land. The call site was deleted on 2026-04-13 and
 *     `seatHorse` itself on 2026-09-02.
 *   - `fn_payout_leaderboard` credited winners as `'leaderboard_payout'`,
 *     which the constraint did not know. That one DID roll back money:
 *     migration 20260903225331 records that zero leaderboard batches had ever
 *     been paid.
 *
 * Same defect, five months apart, because nothing tied a category word in the
 * source to the constraint that has to accept it. The law test
 * `tests/a-wallet-category-is-a-word-the-constraint-knows.law.test.ts` ties
 * them now: it reads the constraint out of the migration and fails if this
 * list drifts from it, or if any source file hands the wallet a word that is
 * not on it.
 */
export const WALLET_TRANSACTION_CATEGORIES = [
  'buyin',
  'cashout',
  'promo',
  'rake',
  'transfer',
  'tournament_buyin',
  'tournament_winnings',
  'tournament_cashout',
  'horse_refill',
  'deposit',
  'withdrawal',
  'refund',
  'bbj',
  'bonus',
  'mint',
  'settlement',
  'commission',
  'INSURANCE',
  'prize',
  'rebuy',
  'addon',
  'funding',
  'promotion',
  'rakeback',
  'bounty',
  'addon_refund',
  'bounty_own',
  'prize_reversal',
  'leaderboard_payout',
] as const;

export type WalletTransactionCategory = (typeof WALLET_TRANSACTION_CATEGORIES)[number];

export interface WalletTransaction {
  id: string;
  walletType: WalletType;
  amount: number;
  direction: 'credit' | 'debit';
  category: WalletTransactionCategory;
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
  loadBalances: (userId: string, opts?: { force?: boolean }) => Promise<void>;
  loadDiamonds: (userId: string, opts?: { force?: boolean }) => Promise<void>;
  /** Whose balances these are. Guards cross-user bleed on a shared device. */
  _balancesUserId: string | null;
  /**
   * DIAMONDS GET THEIR OWN CLOCK 2026-08-28. `loadDiamonds` was gated on
   * `_balancesAt`, a stamp only `loadBalances` ever writes — and `refreshAll`
   * fires both concurrently, so diamonds permanently inherited the balances'
   * freshness window and any non-forced refresh inside it was a silent no-op.
   * The header's diamond count could then sit stale indefinitely while chips
   * updated beside it.
   */
  _diamondsUserId: string | null;
  _diamondsAt: number;
  /** When the balances were last successfully loaded (ms epoch). */
  _balancesAt: number;
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
  _balancesUserId: null as string | null,
  _balancesAt: 0,
  _diamondsUserId: null as string | null,
  _diamondsAt: 0,
};

/**
 * ALWAYS-ON WALLET (Dan 2026-08-24, top priority): "I NEVER WANT ANY WALLETS,
 * TABLES, OR ANYTHING TO HAVE TO RELOAD OR RE-SYNC ANY TIME YOU CHANGE PAGES."
 *
 * A balance that was correct 20 seconds ago is still correct now, and every
 * real change already arrives by other means: the atomic_* RPCs emit
 * BALANCE_UPDATED on the MasterBus, PostgresSyncHooks pushes wallet row changes,
 * and useGlobalBalanceSync (mounted in App.tsx) refetches on both. So a mount is
 * NOT evidence that the number is stale - it is just a component appearing.
 *
 * Within this window a mount-time load is a no-op and the store serves what it
 * already has, so navigating between Home, Cashier and Wallet never re-fetches
 * and never shows a skeleton. `force: true` is available for the paths that
 * genuinely need to re-read (an explicit refresh, a completed transfer).
 */
const BALANCE_FRESH_MS = 30_000;

/**
 * ───────────────────────────────────────────────────────────────────────────
 * IN-FLIGHT COALESCING — one network round trip per (action, user), not N
 * ───────────────────────────────────────────────────────────────────────────
 * BALANCE_FRESH_MS above is a freshness check on a stamp that is only written
 * AFTER the request comes back. That makes it useless in the case that
 * actually hurts: several components mounting in the same tick. Every one of
 * them reads the same stale stamp, every one decides it must fetch, and they
 * all fetch. The guard only ever caught the SECOND page view.
 *
 * Measured on production 2026-08-28, opening one tournament page:
 *
 *     wallet_transactions   20 calls   slowest 2,879 ms
 *     profiles              11 calls   slowest 1,976 ms
 *     club_members           8 calls   slowest 2,298 ms
 *     agents                 6 calls   slowest 2,607 ms
 *     /auth/v1/user          7 calls
 *     ------------------------------------------------
 *     85 Supabase round trips, last one landing at 8.6 s
 *
 * The wallet numbers are this bug almost exactly: `DiamondService.getBalance`
 * issues one `profiles` read and TWO `wallet_transactions` reads per call, so
 * seven concurrent callers produce 7 profiles + 14 wallet_transactions, and
 * `loadTransactions` — which had no freshness guard at all — adds the rest.
 * The per-request timings say the same thing from the other side: each group
 * ran `130, 129, 1680, 1773, 1872, 1988` ms, a fast pair and then a ladder
 * climbing ~100 ms a step, which is queueing behind saturation rather than
 * slow SQL. Nothing was polling: ten idle seconds afterwards fired zero
 * requests. It is all mount cost.
 *
 * So the fix is not caching harder, it is not starting the duplicate request.
 * The first caller runs; everyone arriving while it is still in the air gets
 * the SAME promise and the same answer.
 *
 * `finally` clears the entry on both paths deliberately. Leaving a rejected
 * promise in the map would cache the failure and every later caller would
 * inherit it — the wallet would then stay broken for the whole session
 * instead of retrying on the next mount.
 */
// Balance invalidations need a trailing snapshot if an older read is already
// running. The record also owns publication, so reset or another account can
// retire it without letting a late response repopulate the store.
let _balanceLoad: {
  userId: string;
  refreshAgain: boolean;
  promise: Promise<void>;
} | null = null;

const _inFlight = new Map<string, Promise<void>>();

function coalesce(key: string, run: () => Promise<void>): Promise<void> {
  const existing = _inFlight.get(key);
  if (existing) return existing;
  const started = run().finally(() => {
    _inFlight.delete(key);
  });
  _inFlight.set(key, started);
  return started;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🏪 STORE IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════

export const useWalletStore = create<WalletState>()(
  persist(
    (set, get) => ({
      ...initialState,

      loadBalances: async (userId: string, opts?: { force?: boolean }) => {
        const st = get();
        if (_balanceLoad?.userId === userId) {
          if (opts?.force) _balanceLoad.refreshAgain = true;
          return _balanceLoad.promise;
        }
        // This store displays one account. Any other account's pending read
        // loses ownership even when this account can be served from cache.
        _balanceLoad = null;
        if (
          !opts?.force &&
          st._balancesUserId === userId &&
          Date.now() - st._balancesAt < BALANCE_FRESH_MS
        ) {
          if (st.isLoadingWallet) set({ isLoadingWallet: false });
          return;
        }

        const load = { userId, refreshAgain: false, promise: Promise.resolve() };
        _balanceLoad = load;
        const haveBalancesForThisUser = st._balancesUserId === userId && st._balancesAt > 0;
        if (!haveBalancesForThisUser) set({ isLoadingWallet: true });
        load.promise = (async () => {
          try {
            do {
              load.refreshAgain = false;
              try {
                const walletBalances = await WalletService.getBalances(userId);
                if (_balanceLoad !== load) return;
                if (load.refreshAgain) continue;
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
                set({ balances, _balancesUserId: userId, _balancesAt: Date.now() });
              } catch (error) {
                if (!_balanceBreaker.isOpen()) {
                  _balanceBreaker.trip();
                  reportError(error, 'useWalletStore.Load_balances_failed');
                }
                // An unreadable snapshot leaves the last known balance intact.
              }
            } while (_balanceLoad === load && load.refreshAgain);
          } finally {
            if (_balanceLoad === load) {
              _balanceLoad = null;
              set({ isLoadingWallet: false });
            }
          }
        })();
        return load.promise;
      },

      loadDiamonds: async (userId: string, opts?: { force?: boolean }) => {
        const st = get();
        // Diamonds' OWN freshness stamp — see the _diamondsAt note on the
        // state shape for why reading the balances' stamp made this a no-op.
        if (
          !opts?.force &&
          st._diamondsUserId === userId &&
          Date.now() - st._diamondsAt < BALANCE_FRESH_MS
        ) {
          return;
        }

        return coalesce(`diamonds:${userId}`, async () => {
          if (!(st._diamondsUserId === userId && st._diamondsAt > 0)) {
            set({ isLoadingDiamonds: true });
          }
          try {
            // Load diamonds via centralized DiamondService (profiles.diamonds source-of-truth)
            const wallet = await DiamondService.getBalance(userId);
            set({
              diamonds: wallet.balance || 0,
              _diamondsUserId: userId,
              _diamondsAt: Date.now(),
            });
          } catch (error) {
            if (!_diamondBreaker.isOpen()) {
              _diamondBreaker.trip();
              reportError(error, 'useWalletStore.Load_diamonds_failed');
            }
            // 2026-08-24: this used to `set({ diamonds: 0 })`. A failed fetch is
            // not evidence the player has no diamonds - it wiped a perfectly good
            // cached value and showed zero, which reads as "your diamonds are
            // gone". Keep the last known value; the next successful load or a
            // BALANCE_UPDATED will correct it.
          } finally {
            set({ isLoadingDiamonds: false });
          }
        });
      },

      loadTransactions: async (userId: string, limit = 25) => {
        return coalesce(`transactions:${userId}:${limit}`, async () => {
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
        });
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
        _balanceLoad = null;
        set(initialState);
      },
    }),
    {
      name: 'wallet-store',
      /**
       * ALWAYS-ON (Dan, 2026-08-24). This was `() => ({})` - nothing at all was
       * persisted - so every hard reload, PWA cold start and iOS tab reclaim put
       * the wallet back to 0 and made the player watch it re-populate.
       *
       * This DOES reverse the previous note ("Don't persist wallet data for
       * security"), so the reasoning is spelled out rather than assumed:
       *
       *   - What is stored is the player's OWN balance, which is rendered to
       *     them on the next frame anyway, and the Supabase session JWT already
       *     lives in this same localStorage under `smarter-poker-auth`. The
       *     integer is strictly less sensitive than the token beside it.
       *   - The real risk is CROSS-USER BLEED on a shared device, and that is
       *     handled rather than avoided: `_balancesUserId` is persisted with the
       *     numbers and every read path treats a mismatch as stale and refetches,
       *     `_balancesAt` bounds how long a rehydrated value is trusted, and
       *     `reset()` runs on sign-out via MasterBus and clears all of it.
       *
       * `transactions` stays UNPERSISTED on purpose: a ledger is genuinely
       * sensitive, it is large, and no surface needs it instantly on boot.
       */
      partialize: (state) => ({
        balances: state.balances,
        diamonds: state.diamonds,
        _balancesUserId: state._balancesUserId,
        _balancesAt: state._balancesAt,
      }),
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
