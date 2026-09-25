import { useCallback, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { useMasterBusChannel } from './useMasterBusChannel';

export type ManagementRealtimeStatus = 'connecting' | 'live' | 'degraded';

interface ManagementEventRow {
  sequence?: number;
  event_type?: string;
  scope_kind?: 'club' | 'union';
  scope_id?: string;
  club_id?: string;
  entity_type?: string;
  entity_id?: string;
}

/**
 * Page-scoped realtime invalidation for Table Management. The event contains no
 * private game state; each signal causes the existing authoritative reads to run.
 */
export function useGameManagementRealtime({
  scope,
  scopeId,
  enabled,
  onResync,
}: {
  scope: 'club' | 'union';
  scopeId: string;
  enabled: boolean;
  onResync: () => void;
}): ManagementRealtimeStatus {
  const [status, setStatus] = useState<ManagementRealtimeStatus>('connecting');

  const onPayload = useCallback(
    (change: { new?: ManagementEventRow }) => {
      const event = change.new;
      /* An event ARRIVING is the only thing that proves this feed delivers.
         Anything before the first one is a hope, so the status below is only
         promoted here. A scope mismatch still counts: the row reached us. */
      setStatus('live');
      if (!event || event.scope_kind !== scope || event.scope_id !== scopeId) return;
      switch (event.event_type) {
        case 'ticker_settings_changed':
          masterBus.emit('TICKER_SETTINGS_CHANGED', { scope, scopeId });
          break;
        case 'club_identity_changed':
          if (event.club_id) masterBus.emit('CLUB_UPDATED', { clubId: event.club_id });
          break;
        case 'announcement_changed':
          if (event.club_id)
            masterBus.emit('ANNOUNCEMENT_CHANGED', {
              clubId: event.club_id,
              action: 'created',
            });
          break;
        case 'management_access_changed':
          masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED', {
            scope,
            scopeId,
            clubId: event.club_id,
          });
          break;
        default:
          if (event.entity_type === 'table') {
            masterBus.emit('TABLE_UPDATED', { tableId: event.entity_id || '' });
          } else {
            masterBus.emit('TOURNAMENT_UPDATED', { tournamentId: event.entity_id || '' });
          }
      }
    },
    [scope, scopeId]
  );

  useMasterBusChannel({
    channelName: enabled ? `game-management:${scope}:${scopeId}` : null,
    table: 'game_management_events',
    filter: enabled ? `scope_id=eq.${scopeId}` : null,
    event: 'INSERT',
    enabled,
    onPayload,
    onSubscriptionStatus: (next) => {
      if (next === 'SUBSCRIBED') {
        /* SUBSCRIBED IS A TRANSPORT FACT, NOT A DELIVERY FACT. This used to set
           'live' here, and the page painted a green "Live" badge. But
           game_management_events is NOT in the supabase_realtime publication
           (1,027,487 writes over 3.1M rows; it is one of the eleven the
           2026-09-06 trim keeps out), so this channel joins, reports SUBSCRIBED
           and then receives nothing, for ever - and the operator was told the
           feed was live the whole time.

           Joining no longer promotes the status. Only an arriving row does, in
           onPayload above. That is honest while the table is unpublished, and
           it repairs itself the moment a real delivery path exists: the first
           event flips it to 'live' with no further change here.

           The resync stays: it is the authoritative read this page is built on,
           and it is the reason the page has correct data at all right now. */
        onResync();
        setStatus((prev) => (prev === 'live' ? 'live' : 'connecting'));
      } else if (next === 'CHANNEL_ERROR' || next === 'TIMED_OUT' || next === 'CLOSED') {
        setStatus('degraded');
      } else {
        setStatus((prev) => (prev === 'live' ? 'live' : 'connecting'));
      }
    },
    onSubscriptionError: () => setStatus('degraded'),
  });

  return status;
}

export default useGameManagementRealtime;
