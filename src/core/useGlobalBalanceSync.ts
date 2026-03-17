import { useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from './MasterBus';
import { useUserStore } from '../stores/useUserStore';
import { WalletService } from '../services/WalletService';

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
        const balance = await WalletService.getPlayerBalance(user.id);
        useUserStore.getState().updateTotalChips(Number(balance));
      } catch (err) {
        console.error('[GlobalBalanceSync] Failed to fetch atomic ledger balance:', err);
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
    const channel = supabase
      .channel(`wallet_sync_${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wallets',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          fetchTrueBalance();
        }
      )
      .subscribe();

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
      supabase.removeChannel(channel);
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
