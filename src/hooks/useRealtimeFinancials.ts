import { useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from './useAuthUser';

/**
 * Scopes realtime financial listeners (wallets, chip_ledger) exclusively
 * to components that need them (Cashier, Player Wallet).
 * Eliminates redundant global realtime subscriptions to optimize Supabase billing.
 */
export function useRealtimeFinancials() {
  const { user } = useAuthUser();
  const userId = user?.id;

  useEffect(() => {
    if (!userId || userId === 'guest') return;

    // Use a deterministic channel name scoped to the user's financial session
    const channelName = `scoped_financials:${userId}`;
    const channel = supabase.channel(channelName);

    channel
      // 1. Wallets (Financial integrity)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'wallets', filter: `user_id=eq.${userId}` },
        (payload) => {
          console.debug('[RealtimeFinancials] External Wallet mutation detected:', payload);
          masterBus.emit('BALANCE_UPDATED', { source: 'postgres_sync' });
          const w = payload.new as any;
          masterBus.emit('WALLET_REFRESHED', {
            walletType: w.wallet_type || 'PLAYER',
            available: (w.balance || 0) - (w.locked_balance || 0),
            total: w.balance || 0,
          });
        }
      )
      // 2. Chip Ledger (incoming)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chip_ledger',
          filter: `to_entity_id=eq.${userId}`,
        },
        (payload) => {
          console.debug('[RealtimeFinancials] New ledger entry (incoming):', payload);
          masterBus.emit('BALANCE_UPDATED', { source: 'chip_ledger_realtime' });
          (masterBus as any).emit('TRANSACTION_LOGGED', { entry: payload.new, direction: 'in' });
        }
      )
      // 3. Chip Ledger (outgoing)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'chip_ledger',
          filter: `performed_by=eq.${userId}`,
        },
        (payload) => {
          console.debug('[RealtimeFinancials] New ledger entry (outgoing):', payload);
          masterBus.emit('BALANCE_UPDATED', { source: 'chip_ledger_realtime' });
          (masterBus as any).emit('TRANSACTION_LOGGED', { entry: payload.new, direction: 'out' });
        }
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.info(`[RealtimeFinancials] ✅ Hook Active for user ${userId}.`);
        } else if (status === 'CHANNEL_ERROR') {
          console.debug(`[RealtimeFinancials] ❌ Channel error:`, err);
        }
      });

    return () => {
      console.info(`[RealtimeFinancials] Cleaning up listeners for user ${userId}.`);
      channel.unsubscribe();
      supabase.removeChannel(channel);
    };
  }, [userId]);
}
