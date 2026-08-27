import { useEffect } from 'react';

import { masterBus } from './MasterBus';
import { useUserStore } from '../stores/useUserStore';
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

    const fetchTrueBalance = async () => {
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
      () => {
        fetchTrueBalance();
      },
      200
    );

    // Sub to remote Supabase DB changes for cross-tab or server-initiated updates
    // NOTE (2026-04-19): Direct wallets postgres_changes channel REMOVED — duplicate of
    // PostgresSyncHooks which already subscribes to wallets with user_id filter and emits
    // BALANCE_UPDATED on MasterBus. The subscribeDebounced listener above handles this.
    //
    // 2026-08-24: that note was WRONG when written, and is true only now.
    // PostgresSyncHooks did NOT carry a `wallets` listener — it had been moved
    // out to useRealtimeFinancials on the very same day, and that hook mounts on
    // exactly two pages (PlayerWalletPage, CashierPage). So this channel was
    // removed as a "duplicate" of something that did not exist, and on every
    // other page a server-initiated balance change produced no update at all.
    // The filtered listener now genuinely lives in PostgresSyncHooks
    // (`global_db_sync:<userId>`), so the sentence above finally describes
    // reality and this hook's debounced BALANCE_UPDATED subscriber is fed
    // everywhere rather than on two pages.

    // Initial fetch on mount to guarantee parity
    fetchTrueBalance();

    // Sub to reconnect events — re-fetch balance when coming back online
    const unsubscribeReconnect = masterBus.subscribeDebounced(
      'CONNECTION_RESTORED',
      () => {
        fetchTrueBalance();
      },
      500
    );

    return () => {
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
