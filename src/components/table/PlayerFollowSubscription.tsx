import { useEffect, useId, useRef } from 'react';
import { masterBus } from '../../core/MasterBus';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import type { FollowTournamentPlayer } from '../../utils/followTournamentPlayer';

export interface FollowDestination {
  id: string;
  name: string;
}
interface Props {
  target: FollowTournamentPlayer;
  tableId: string;
  accountId: string;
  onMove: (
    sourceId: string,
    target: FollowTournamentPlayer,
    table: FollowDestination,
    sourceSeated: boolean
  ) => void;
  onEnd: (sourceId: string, target: FollowTournamentPlayer) => void;
  onUnavailable: () => void;
}

/** Read on admission/reconnect and assignment events. No polling or game mutation. */
export default function PlayerFollowSubscription(props: Props) {
  const instance = useId();
  const latest = useRef(props);
  latest.current = props;
  const { target, accountId } = props;
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let signature = '';
    const channelKey = `player-follow-${instance.replace(/[^a-zA-Z0-9]/g, '')}`;
    const unavailable = (error: unknown) => {
      reportError(error, 'PlayerFollowSubscription');
      latest.current.onUnavailable();
    };
    const refresh = async () => {
      const request = ++revision;
      const current = () => !disposed && request === revision;
      try {
        const { data: player, error } = await supabase
          .from('tournament_players')
          .select('table_id,status')
          .eq('tournament_id', target.tournamentId)
          .eq('user_id', target.userId)
          .maybeSingle();
        if (!current()) return;
        if (error) {
          unavailable(error);
          return;
        }
        if (
          !player ||
          ['eliminated', 'finished', 'winner', 'unregistered'].includes(player.status)
        ) {
          latest.current.onEnd(latest.current.tableId, target);
          return;
        }
        signature = `${player.status}:${player.table_id || ''}`;
        // A balancer can clear the old assignment before publishing the new one.
        if (!player.table_id || player.table_id === latest.current.tableId) return;
        const { data: table, error: tableError } = await supabase
          .from('tables')
          .select('id,name,status,is_deleted')
          .eq('id', player.table_id)
          .eq('tournament_id', target.tournamentId)
          .maybeSingle();
        if (!current()) return;
        if (tableError) {
          unavailable(tableError);
          return;
        }
        if (!table || table.is_deleted || table.status === 'closed') {
          unavailable(new Error('Follow destination is not available'));
          return;
        }
        // Cold URLs arrive before the container's seat recovery. Verify the source
        // admission before replacing it so a real played seat is never mistaken
        // for an observer while that independent read is still in flight.
        const sourceId = latest.current.tableId;
        const { data: seat, error: seatError } = await supabase
          .from('table_seats')
          .select('id')
          .eq('table_id', sourceId)
          .eq('user_id', accountId)
          .is('left_at', null)
          .maybeSingle();
        if (!current() || latest.current.tableId !== sourceId) return;
        if (seatError) {
          unavailable(seatError);
          return;
        }
        latest.current.onMove(sourceId, target, { id: table.id, name: table.name }, !!seat);
      } catch (error) {
        if (current()) unavailable(error);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    try {
      masterBus
        .getOrCreateChannel(channelKey)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tournament_players',
            filter: `tournament_id=eq.${target.tournamentId}`,
          },
          (payload: {
            eventType: string;
            new?: Record<string, unknown>;
            old?: Record<string, unknown>;
          }) => {
            const row = payload.eventType === 'DELETE' ? payload.old : payload.new;
            if (row?.user_id !== target.userId) return;
            if (row.tournament_id && row.tournament_id !== target.tournamentId) return;
            const next = `${row.status}:${row.table_id || ''}`;
            if (payload.eventType !== 'DELETE' && next === signature) return;
            signature = next;
            void refresh();
          }
        )
        .subscribe((status: string, error?: Error) => {
          if (disposed) return;
          if (status === 'SUBSCRIBED') void refresh();
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT')
            unavailable(error || new Error(status));
        });
      void refresh();
    } catch (error) {
      unavailable(error);
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      revision++;
      document.removeEventListener('visibilitychange', onVisible);
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [target.tournamentId, target.userId, accountId, instance]);
  return null;
}
