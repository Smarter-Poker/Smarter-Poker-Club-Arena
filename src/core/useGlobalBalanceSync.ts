import { useEffect } from 'react';

import { masterBus } from './MasterBus';
import { useUserStore } from '../stores/useUserStore';
import { useWalletStore } from '../stores/useWalletStore';
import { WalletService } from '../services/WalletService';
import { reportError } from '../utils/errorReporter';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Global Balance Sync ♠
 * ═══════════════════════════════════════════════════════════════════════════════
 * This hook acts as the immutable bridge between the MasterBus `BALANCE_UPDATED`
 * emissions (triggered by atomic PostgreSQL RPCs) and the frontend Zustand store.
 *
 * Since atomic operations update the DB but bypass the frontend state, this listener
 * guarantees that whenever the ledger mutates, the exact correct balance is fetched
 * and populated directly into `useUserStore.getState().updateTotalChips(newValue)`.
 */
export function useGlobalBalanceSync() {
  const user = useUserStore((state) => state.user);

  useEffect(() => {
    if (!user?.id) return;

    let active = true;
    let latestRead = 0;
    const ownsAccount = () => active && useUserStore.getState().user?.id === user.id;

    const fetchTrueBalance = async (force = false) => {
      if (!ownsAccount()) return;
      const read = ++latestRead;
      // This owner remains mounted on table routes with no visible header.
      // The store coalesces overlapping reads and retains known values on error.
      void useWalletStore.getState().loadBalances(user.id, { force });
      try {
        /* A READ THAT NEVER HAPPENED IS NOT A BALANCE OF ZERO (2026-08-27).
           This used getPlayerBalance, whose own docstring says it "collapses
           every failure - RPC error, RLS denial, an unresolvable club id, a
           dropped connection - into the number 0". It then wrote that 0 into
           useUserStore.totalChips, which is the GLOBAL chip figure the whole
           app renders: one refused read blanked a funded player's balance
           everywhere at once.

           It matters more now that readPlayerBalance no longer falls back to
           the retired wallet pool: an unreachable RPC used to answer with a
           stale number and now honestly answers null.

           Same rule useWalletStore.loadBalances already follows - "a transient
           network failure must not replace a good number with zeros on
           screen": on unknown we leave the last known good value in place. */
        const r = await WalletService.readPlayerBalance(user.id);
        // A newer refresh or identity change retires this response. Check the
        // store too: an account can change before React cleans up this effect.
        if (!ownsAccount() || read !== latestRead) return;
        if (r.balance !== null) {
          useUserStore.getState().updateTotalChips(Number(r.balance));
        }
      } catch (err) {
        reportError(err, 'useGlobalBalanceSync.Failed_to_fetch_atomic_ledger_balance');
      }
    };

    // Sub to local intra-app balance updates (debounced to collapse rapid-fire emissions
    // from bulk operations like BBJ payout or settlement into a single Supabase fetch)
    const unsubscribeLocal = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      (event) => {
        const eventUserId = event?.payload?.userId;
        if (typeof eventUserId === 'string' && eventUserId !== user.id) return;
        fetchTrueBalance(true);
      },
      200
    );

    // PostgresSyncHooks carries this account's existing club_members stream.
    // A real chip/promo/locked balance change or subscription recovery emits
    // BALANCE_UPDATED; unchanged activity counters do not refetch wallets.

    // Initial fetch on mount to guarantee parity
    fetchTrueBalance();

    // Sub to reconnect events — re-fetch balance when coming back online
    const unsubscribeReconnect = masterBus.subscribeDebounced(
      'CONNECTION_RESTORED',
      () => {
        fetchTrueBalance(true);
      },
      500
    );

    return () => {
      active = false;
      unsubscribeLocal();
      unsubscribeReconnect();
    };
  }, [user?.id]);
}

/**
 * Headless component that mounts the global balance sync hook.
 * Attach this high up in the App tree (e.g. inside App.tsx or inside AuthGuard)
 */
export function GlobalBalanceSync() {
  useGlobalBalanceSync();
  return null;
}
