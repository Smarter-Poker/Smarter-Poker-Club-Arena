import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { PLAYER_NAME_COLUMNS, playerDisplayName } from '../utils/playerDisplayName';
import { reportError } from '../utils/errorReporter';

/** Explain a committed move to everyone still watching its source table. */
export function useSeatMoveAnnouncement({
  tableId,
  event,
  players,
  announce,
}: {
  tableId: string | undefined;
  event: Record<string, unknown> | null;
  players: readonly ({ id: string; name: string } | null)[];
  announce: (message: string, id: string) => void;
}) {
  const state = useRef({ tableId, names: new Map<string, string>(), seen: new Set<string>() });
  if (state.current.tableId !== tableId)
    state.current = { tableId, names: new Map(), seen: new Set() };
  for (const player of players) if (player?.name) state.current.names.set(player.id, player.name);
  const announceRef = useRef(announce);
  announceRef.current = announce;
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const data = (event?.data ?? event) as Record<string, unknown> | null;
    if (
      String(event?.type).toUpperCase() !== 'SEAT_MOVED' ||
      !tableId ||
      data?.table_id !== tableId ||
      typeof data.user_id !== 'string' ||
      typeof data.to_table_id !== 'string' ||
      !data.to_table_id ||
      data.to_table_id === tableId ||
      event?.replayed === true ||
      data.replayed === true
    )
      return;
    const scope = state.current;
    const id = `seat-move:${data.user_id}:${data.to_table_id}:${data.timestamp ?? ''}`;
    if (scope.seen.has(id)) return;
    scope.seen.add(id);
    if (scope.seen.size > 64) scope.seen.delete(scope.seen.values().next().value!);
    const cachedName = scope.names.get(data.user_id);
    void (async () => {
      let name = cachedName;
      let destination = data.reason === 'must_move' ? 'The Main Game' : 'Another Table';
      try {
        const [table, profile] = await Promise.all([
          supabase.from('tables').select('name').eq('id', data.to_table_id).maybeSingle(),
          cachedName
            ? Promise.resolve(null)
            : supabase
                .from('profiles')
                .select(PLAYER_NAME_COLUMNS)
                .eq('id', data.user_id)
                .maybeSingle(),
        ]);
        if (table.error) reportError(table.error, 'useSeatMoveAnnouncement.destination');
        if (profile?.error) reportError(profile.error, 'useSeatMoveAnnouncement.player');
        if (!profile?.error && profile?.data) name = playerDisplayName(profile.data);
        if (!table.error && table.data?.name) {
          const label = String(table.data.name).trim();
          destination = /\bmain(?:\s*\d+)?\b/i.test(label) ? 'The Main Game' : label || destination;
        }
      } catch (error) {
        reportError(error, 'useSeatMoveAnnouncement.read');
      }
      if (mounted.current && state.current === scope)
        announceRef.current(`${name || 'A Player'} Was Moved To ${destination}`, id);
    })();
  }, [tableId, event]);
}
