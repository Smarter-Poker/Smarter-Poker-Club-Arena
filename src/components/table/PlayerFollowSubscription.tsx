import { useEffect, useRef } from 'react';
import { subscribeTournamentStandings } from '../../services/tournamentStandingsUpdates';
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
  const latest = useRef(props);
  latest.current = props;
  const { target, accountId } = props;
  useEffect(() => {
    let disposed = false;
    let revision = 0;
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
    // tournament_players is deliberately excluded from WAL Realtime. The
    // existing engine tournament feed carries committed-hand and lifecycle
    // invalidations, reconnect and visibility recovery for every reader.
    let stop = () => {};
    try {
      stop = subscribeTournamentStandings(target.tournamentId, () => void refresh());
      void refresh();
    } catch (error) {
      unavailable(error);
    }
    return () => {
      disposed = true;
      revision++;
      stop();
    };
  }, [target.tournamentId, target.userId, accountId]);
  return null;
}
