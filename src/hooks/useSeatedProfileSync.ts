/**
 * ♠ CLUB ARENA — useSeatedProfileSync
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PROBLEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A player who changed their avatar changed it on their own screen only.
 * Everybody else at the table kept seeing the old one until they reloaded.
 *
 * Their identity fields reach other clients exactly once, on the engine's
 * snapshot, and the engine only re-reads `profiles` inside `loadSeatedPlayers`
 * at the top of a deal. Between hands, on an idle table, and for the whole time
 * a short-handed table is waiting for players, nothing re-reads anything.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS MECHANISM AND NOT ANOTHER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three transports carry table data today and only one of them is right here.
 *
 *   The engine WebSocket (`/ws/table/:id`)  is authoritative but server-driven.
 *     Making it react to a client-side avatar change would mean a new engine
 *     endpoint and a new auth surface for a cosmetic.
 *
 *   The Supabase broadcast channel `table:${id}` is legacy. It has two
 *     competing listeners (TableWebSocket and RoomService) and its only
 *     remaining server producer is two `time_bank_activated` sends.
 *
 *   postgres_changes is the one the live per-player surfaces already use:
 *     `table_chat`, `club_chat`, `table_hole_cards`, `notifications`,
 *     `messages`, and PresenceIndicator's own `profiles` subscription. This
 *     hook is that pattern, applied to the seated roster.
 *
 * A NOTE ON THE PATTERN THAT LOOKS RIGHT AND IS NOT. `TablePage` already has a
 * `table-seats-live:${tableId}` subscription that merges into
 * `tableState.players`, and copying it would have been the obvious move.
 * `table_seats` IS NOT IN THE `supabase_realtime` PUBLICATION — checked against
 * production 2026-08-25: the publication carries 109 tables and that is not one
 * of them, so that handler has never received a row. `profiles` IS in it. This
 * hook is deliberately built on the table that actually replicates.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  SHAPE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One channel per table, filtered to the ids currently seated, resubscribed
 * only when that set genuinely changes. Nine `id=eq.` channels would also work
 * and would cost nine subscriptions per table per player — on MultiTablePage,
 * with four tables mounted, that is thirty-six.
 *
 * Realtime delivers RAW COLUMN NAMES. `arena_avatar_url` does not arrive as
 * `avatar_url` here, however many `select('avatar_url:arena_avatar_url')` calls
 * are in this codebase, because a select alias is a PostgREST feature and this
 * payload comes from replication.
 */

import { useEffect, useMemo, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface SeatedProfileChange {
  userId: string;
  /** `profiles.arena_avatar_url`. Undefined when the payload did not carry it. */
  avatar?: string;
  /** `profiles.equipped_frame`, normalised: null means "explicitly none". */
  frame: string | null;
  /** `profiles.equipped_aura`, normalised: null means "explicitly none". */
  aura: string | null;
}

/**
 * @param tableId       The table whose seats we are watching. Falsy disables.
 * @param seatedUserIds Every user id currently holding a seat, hero included.
 *                      Order does not matter; the hook sorts before comparing.
 * @param onChange      Called once per delivered UPDATE. Must be stable or
 *                      wrapped in useCallback by the caller, or held in a ref
 *                      as it is here.
 */
export function useSeatedProfileSync(
  tableId: string | null | undefined,
  seatedUserIds: readonly (string | null | undefined)[],
  onChange: (change: SeatedProfileChange) => void
): void {
  /* The callback is read through a ref so a caller that re-creates it every
     render (which TablePage does, being one enormous component) does not tear
     down and rebuild a realtime subscription sixty times a second. */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  /* A stable identity for the id SET. Sorted and joined so [a,b] and [b,a] are
     the same dependency, and deduped so a table mid-seat-change does not churn
     the channel. */
  const idKey = useMemo(() => {
    const unique = Array.from(
      new Set(seatedUserIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
    );
    unique.sort();
    return unique.join(',');
  }, [seatedUserIds]);

  useEffect(() => {
    if (!tableId || !idKey) return undefined;

    const ids = idKey.split(',');

    /* PostgREST `in` list syntax. The ids are uuids straight out of the seat
       roster and are matched against that shape before they are interpolated —
       anything else is dropped rather than concatenated into a filter string. */
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const safeIds = ids.filter((id) => UUID.test(id));
    if (safeIds.length === 0) return undefined;

    const channel = supabase
      .channel(`table-profiles-live:${tableId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=in.(${safeIds.join(',')})`,
        },
        (payload: { new?: Record<string, unknown> }) => {
          const row = payload?.new;
          const userId = typeof row?.['id'] === 'string' ? (row['id'] as string) : '';
          if (!userId) return;

          const rawAvatar = row?.['arena_avatar_url'];
          const rawFrame = row?.['equipped_frame'];
          const rawAura = row?.['equipped_aura'];

          try {
            onChangeRef.current({
              userId,
              /* Undefined, not '', when the column is absent or empty. The
                 merge treats undefined as "no news" and keeps whatever the
                 snapshot already put on the seat; '' would blank a face. */
              avatar: typeof rawAvatar === 'string' && rawAvatar ? rawAvatar : undefined,
              frame: typeof rawFrame === 'string' && rawFrame ? rawFrame : null,
              aura: typeof rawAura === 'string' && rawAura ? rawAura : null,
            });
          } catch (err) {
            reportError(err, 'useSeatedProfileSync.onChange');
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tableId, idKey]);
}

export default useSeatedProfileSync;
