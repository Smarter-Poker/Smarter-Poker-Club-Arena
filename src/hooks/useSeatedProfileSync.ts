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
 * One channel per table, with one `id=eq.` binding for each player currently
 * seated, resubscribed only when that set genuinely changes. This replaces the
 * old TableWebSocket listener that subscribed to ALL profile updates on the
 * platform once for every open table. Four-table mode now receives at most the
 * rows for its own rosters, while still using only one channel per table.
 *
 * Realtime delivers RAW COLUMN NAMES. `arena_avatar_url` does not arrive as
 * `avatar_url` here, however many `select('avatar_url:arena_avatar_url')` calls
 * are in this codebase, because a select alias is a PostgREST feature and this
 * payload comes from replication.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reportError } from '../utils/errorReporter';
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';

export interface SeatedProfileChange {
  userId: string;
  /** `profiles.arena_avatar_url`. Undefined when the payload did not carry it. */
  avatar?: string;
  /** `profiles.equipped_frame`, normalised: null means "explicitly none". */
  frame?: string | null;
  /** `profiles.equipped_aura`, normalised: null means "explicitly none". */
  aura?: string | null;
}

export type SeatedProfileSyncState = 'local' | 'connecting' | 'live' | 'error';

export interface SeatedProfileSyncHandle {
  state: SeatedProfileSyncState;
  retry: () => void;
}

function toProfileChange(row: Record<string, unknown>): SeatedProfileChange | null {
  const userId = typeof row.id === 'string' ? row.id : '';
  if (!userId) return null;
  const rawAvatar = row.arena_avatar_url;
  const rawFrame = row.equipped_frame;
  const rawAura = row.equipped_aura;
  return {
    userId,
    avatar: typeof rawAvatar === 'string' && rawAvatar ? rawAvatar : undefined,
    frame: typeof rawFrame === 'string' && rawFrame ? rawFrame : null,
    aura: typeof rawAura === 'string' && rawAura ? rawAura : null,
  };
}

/** Short deterministic suffix so Realtime topics stay well below name limits. */
function hashRoster(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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
): SeatedProfileSyncHandle {
  /* The callback is read through a ref so a caller that re-creates it every
     render (which TablePage does, being one enormous component) does not tear
     down and rebuild a realtime subscription sixty times a second. */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pendingMutationsRef = useRef(new Map<string, Set<string>>());
  const [state, setState] = useState<SeatedProfileSyncState>(
    tableId && seatedUserIds.length ? 'connecting' : 'local'
  );
  const [retryRevision, setRetryRevision] = useState(0);
  const retry = useCallback(() => setRetryRevision((revision) => revision + 1), []);

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
    if (!tableId || !idKey) {
      setState('local');
      return undefined;
    }

    const ids = idKey.split(',');

    /* PostgREST `in` list syntax. The ids are uuids straight out of the seat
       roster and are matched against that shape before they are interpolated —
       anything else is dropped rather than concatenated into a filter string. */
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const safeIds = ids.filter((id) => UUID.test(id));
    if (safeIds.length === 0) {
      setState('local');
      return undefined;
    }

    let mounted = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setState('connecting');

    const deliver = (change: SeatedProfileChange | null) => {
      if (!change || !safeIds.includes(change.userId)) return;
      try {
        onChangeRef.current(change);
      } catch (err) {
        reportError(err, 'useSeatedProfileSync.onChange');
      }
    };

    // Realtime does not replay UPDATEs missed while a phone is asleep or a
    // connection is down. Re-read the small seated roster whenever the
    // channel becomes live, including its first subscription, so the engine
    // snapshot and every recovery converge on the same profile rows.
    const reconcile = async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, arena_avatar_url, equipped_frame, equipped_aura')
          .in('id', safeIds);
        if (!mounted) return;
        if (error) {
          setState('error');
          reportError(error, 'useSeatedProfileSync.reconcile');
          return;
        }
        for (const row of Array.isArray(data) ? data : []) {
          const change = toProfileChange(row as Record<string, unknown>);
          if (change && pendingMutationsRef.current.get(change.userId)?.size) continue;
          deliver(change);
        }
      } catch (error) {
        if (!mounted) return;
        setState('error');
        reportError(error, 'useSeatedProfileSync.reconcile');
      }
    };

    // Picker events are zero-latency and BroadcastChannel-backed, so the
    // current user's every open table (and every Club Arena tab) repaints in
    // the same frame as the choice.
    const mutationOff = masterBus.subscribe('CUSTOMIZATION_MUTATION_STATE', (event) => {
      if (event.payload.kind !== 'player-appearance') return;
      const playerId = event.payload.scope;
      if (!safeIds.includes(playerId)) return;
      if (event.payload.state === 'pending') {
        const pending = pendingMutationsRef.current.get(playerId) ?? new Set<string>();
        pending.add(event.payload.mutationId);
        pendingMutationsRef.current.set(playerId, pending);
      } else if (event.payload.state !== 'rolling-back') {
        const pending = pendingMutationsRef.current.get(playerId);
        pending?.delete(event.payload.mutationId);
        if (pending?.size === 0) pendingMutationsRef.current.delete(playerId);
      }
    });

    const appearanceOff = masterBus.subscribe('PLAYER_APPEARANCE_CHANGED', (event) => {
      const { userId, avatar, frame, aura } = event.payload;
      deliver({ userId, avatar, frame, aura });
    });

    // Database realtime is the durable cross-device reconciliation path for
    // this table's seated roster. Each binding is user-filtered; no global
    // profiles fan-out is allowed here.
    const channel = supabase.channel(`seated-profiles:${tableId}:${hashRoster(idKey)}`);
    for (const id of safeIds) {
      channel.on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'profiles',
          filter: `id=eq.${id}`,
        },
        (payload) => {
          const change = toProfileChange(payload.new as Record<string, unknown>);
          if (change && pendingMutationsRef.current.get(change.userId)?.size) return;
          deliver(change);
        }
      );
    }
    channel.subscribe((status, error) => {
      if (!mounted) return;
      if (status === 'SUBSCRIBED') {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        setState('live');
        void reconcile();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setState('error');
        reportError(
          error || new Error(`Seated profile channel ${status}`),
          'useSeatedProfileSync.channel'
        );
        // Supabase normally reconnects its channel. This bounded client retry
        // also heals environments where the channel remains closed forever.
        if (!retryTimer) retryTimer = setTimeout(retry, 2_000);
      }
    });

    return () => {
      mounted = false;
      if (retryTimer) clearTimeout(retryTimer);
      mutationOff();
      appearanceOff();
      void supabase.removeChannel(channel);
    };
  }, [tableId, idKey, retry, retryRevision]);

  return { state, retry };
}

export default useSeatedProfileSync;
