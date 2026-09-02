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
        setStatus('live');
        onResync();
      } else if (next === 'CHANNEL_ERROR' || next === 'TIMED_OUT' || next === 'CLOSED') {
        setStatus('degraded');
      } else {
        setStatus('connecting');
      }
    },
    onSubscriptionError: () => setStatus('degraded'),
  });

  return status;
}

export default useGameManagementRealtime;
