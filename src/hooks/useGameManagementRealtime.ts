import { useCallback, useRef, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { useVisibleRead } from './useVisibleRead';
import { useAuthUser } from './useAuthUser';

export type ManagementRealtimeStatus = 'connecting' | 'current' | 'degraded';

interface ManagementEventRow {
  sequence?: number | string;
  event_type?: string;
  scope_kind?: 'club' | 'union';
  scope_id?: string;
  club_id?: string;
  entity_type?: string;
  entity_id?: string;
}

/**
 * Read the compact, indexed management feed only while the board is visible.
 * Its table is deliberately unpublished: a WAL subscription joins successfully
 * but cannot deliver. This read scales with open boards, not every live game.
 * Named invalidations retain the board's targeted/coalesced authoritative reads.
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
  const { user } = useAuthUser();
  const seen = useRef(new Set<string>());
  const needsResync = useRef(true);

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

  useVisibleRead({
    scopeKey: `management:${scope}:${scopeId}:${user?.id}`,
    enabled: enabled && Boolean(scopeId && user?.id),
    // Match the existing board refresh budget. Gameplay remains on its socket.
    intervalMs: 20_000,
    onReset: () => {
      seen.current.clear();
      needsResync.current = true;
      setStatus('connecting');
    },
    read: async (signal) => {
      const query = supabase
        .from('game_management_events')
        .select('sequence, event_type, scope_kind, scope_id, club_id, entity_type, entity_id')
        .eq('scope_kind', scope)
        .eq('scope_id', scopeId)
        .order('sequence', { ascending: false })
        .limit(128);
      const { data, error } = await query.abortSignal(signal);
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('The management feed could not be read');
      for (const row of data) {
        if (
          !/^[0-9]+$/.test(String(row.sequence)) ||
          (typeof row.sequence === 'number' && !Number.isSafeInteger(row.sequence))
        ) {
          throw new Error('The management feed returned an invalid sequence');
        }
      }
      return data as ManagementEventRow[];
    },
    onData: (rows, reason) => {
      // Sequence allocation is not commit order. Re-read a bounded overlap so
      // a lower-numbered transaction committing late is still observed.
      const fresh = rows.filter((row) => !seen.current.has(String(row.sequence)));
      seen.current = new Set(rows.map((row) => String(row.sequence)));
      if (needsResync.current || reason === 'visible' || rows.length === 0) {
        needsResync.current = false;
        onResync();
      } else if (rows.length === 128) {
        // Older commits can fall outside this bounded window. The authoritative
        // board/access snapshot covers them without an unbounded event catch-up.
        // Keep named content notifications for panels already open on the board.
        for (const row of [...fresh].reverse()) {
          if (
            row.event_type &&
            [
              'ticker_settings_changed',
              'club_identity_changed',
              'announcement_changed',
              'management_access_changed',
            ].includes(row.event_type)
          ) {
            onPayload({ new: row });
          }
        }
        onResync();
      } else {
        for (const row of [...fresh].reverse()) onPayload({ new: row });
      }
      setStatus('current');
    },
    onError: (error) => {
      reportError(error, 'useGameManagementRealtime.read');
      needsResync.current = true;
      setStatus('degraded');
    },
  });

  return status;
}

export default useGameManagementRealtime;
