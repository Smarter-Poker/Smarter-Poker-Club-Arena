import { useEffect } from 'react';
import { engineChannelClient } from '../services/EngineStateClient';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from './useAuthUser';

/**
 * Scopes realtime financial listeners (wallets, chip_ledger) exclusively
 * to components that need them (Cashier, Player Wallet).
 *
 * Phase 2 (2026-05-18): Migrated from Supabase Realtime postgres_changes
 * to the Hetzner engine WebSocket FINANCIAL_UPDATE message, eliminating
 * all Supabase Realtime connections from this hook.
 *
 * The engine server sends FINANCIAL_UPDATE messages when:
 *   - A wallet row is updated (balance change)
 *   - A chip_ledger row is inserted (transaction in or out)
 *
 * Server-side contract (FINANCIAL_UPDATE message shape):
 *   { type: 'FINANCIAL_UPDATE', userId, walletType, available, total, ledgerEntry? }
 */
export function useRealtimeFinancials() {
  const { user } = useAuthUser();
  const userId = user?.id;

  useEffect(() => {
    if (!userId || userId === 'guest') return;

    console.info(`[RealtimeFinancials] Activating engine WS listener for user ${userId}`);

    const unsubscribe = engineChannelClient.onFinancialUpdate((msg) => {
      // Only process messages for this user
      if (msg.userId !== userId) return;

      console.debug('[RealtimeFinancials] Financial update received:', msg);

      if (msg.walletType === 'DIAMOND') {
        if (Number.isSafeInteger(msg.available) && msg.available >= 0) {
          masterBus.emit('DIAMOND_BALANCE_CHANGED', {
            newBalance: msg.available,
            delta: 0,
            source: 'engine_ws_financial_update',
          });
        }
        return;
      }
      masterBus.emit('BALANCE_UPDATED', { source: 'engine_ws_financial_update' });
      masterBus.emit('WALLET_REFRESHED', {
        // Cast: msg.walletType arrives as string from WebSocket JSON;
        // masterBus WALLET_REFRESHED payload requires the strict union type.
        walletType: msg.walletType as 'PLAYER' | 'BUSINESS' | 'PROMO',
        available: msg.available,
        total: msg.total,
      });

      // If a ledger entry is included, emit TRANSACTION_LOGGED
      if (msg.ledgerEntry) {
        const entry = msg.ledgerEntry as { direction?: string };
        (masterBus as unknown as { emit: (event: string, payload: unknown) => void }).emit(
          'TRANSACTION_LOGGED',
          { entry: msg.ledgerEntry, direction: entry.direction ?? 'in' }
        );
      }
    });

    // The push-only stream cannot replay changes missed before a socket opens.
    // Refresh on every connected transition, including the first open: the
    // page's initial read may predate it. Browser wake also resets retryCount,
    // so a recovering socket can legitimately arrive through "connecting".
    const unsubStatus = engineChannelClient.onStatusChange((status) => {
      if (status !== 'connected') return;
      console.info('[RealtimeFinancials] Channel connected - refetching balances');
      masterBus.emit('BALANCE_UPDATED', { source: 'engine_ws_reconnect_refetch' });
    });

    return () => {
      console.info(`[RealtimeFinancials] Removing engine WS listener for user ${userId}`);
      unsubscribe();
      unsubStatus();
    };
  }, [userId]);
}
