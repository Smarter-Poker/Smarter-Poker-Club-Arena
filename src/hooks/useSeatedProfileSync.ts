import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { reportError } from '../utils/errorReporter';
import { masterBus } from '../core/MasterBus';
import { supabase } from '../lib/supabase';
import { useMasterBusBroadcastChannel } from './useMasterBusBroadcastChannel';
import { TABLE_AVATAR_COLUMN, tableAvatarFromProfileRow } from '../lib/tableAvatar';

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
  const rawFrame = row.equipped_frame;
  const rawAura = row.equipped_aura;
  return {
    userId,
    // The ONE column a seat shows, named by src/lib/tableAvatar.ts and read
    // by the engine through its byte-identical mirror. Never `avatar_url`.
    avatar: tableAvatarFromProfileRow(row),
    frame: typeof rawFrame === 'string' && rawFrame ? rawFrame : null,
    aura: typeof rawAura === 'string' && rawAura ? rawAura : null,
  };
}

/**
 * Cosmetic edits use a private named signal, independent of the unpublished
 * profiles table. A signal carries only identity; the seated projection is
 * always read through the player's authenticated RLS permissions. All game
 * formats share this hook. No hand, action, timer or chip update is polled.
 */
export function useSeatedProfileSync(
  tableId: string | null | undefined,
  seatedUserIds: readonly (string | null | undefined)[],
  onChange: (change: SeatedProfileChange) => void
): SeatedProfileSyncHandle {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pendingMutationsRef = useRef(new Map<string, Set<string>>());
  const [state, setState] = useState<SeatedProfileSyncState>('local');
  const refreshRef = useRef<(() => void) | null>(null);
  const channelLive = useRef(false);
  useEffect(() => {
    channelLive.current = false;
    pendingMutationsRef.current.clear();
  }, [tableId]);
  const retry = useCallback(() => refreshRef.current?.(), []);
  const idKey = useMemo(() => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return [
      ...new Set(
        seatedUserIds.filter((id): id is string => typeof id === 'string' && uuid.test(id))
      ),
    ]
      .sort()
      .join(',');
  }, [seatedUserIds]);

  useEffect(() => {
    if (!tableId || !idKey) {
      setState('local');
      return;
    }
    const safeIds = idKey.split(',');
    for (const player of pendingMutationsRef.current.keys()) {
      if (!safeIds.includes(player)) pendingMutationsRef.current.delete(player);
    }
    let alive = true;
    let reading = false;
    let pendingRead = false;
    let mutationRevision = 0;
    let controller: AbortController | undefined;
    setState('connecting');
    const deliver = (change: SeatedProfileChange | null) => {
      if (!alive || !change || !safeIds.includes(change.userId)) return;
      try {
        onChangeRef.current(change);
      } catch (error) {
        reportError(error, 'useSeatedProfileSync.onChange');
      }
    };
    const reconcile = async () => {
      if (!alive || document.visibilityState === 'hidden') return;
      if (reading) {
        pendingRead = true;
        return;
      }
      reading = true;
      controller = new AbortController();
      const request = controller;
      const startedAtRevision = mutationRevision;
      const deadline = setTimeout(() => request.abort(), 15_000);
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select(`id, ${TABLE_AVATAR_COLUMN}, equipped_frame, equipped_aura`)
          .in('id', safeIds)
          .abortSignal(request.signal);
        if (!alive) return;
        if (request.signal.aborted) throw new Error('The seated appearance read timed out');
        if (startedAtRevision !== mutationRevision) {
          pendingRead = true;
          return;
        }
        if (error) throw error;
        if (!Array.isArray(data) || safeIds.some((id) => !data.some((row) => row.id === id)))
          throw new Error('The seated appearance could not be read');
        for (const row of data) {
          const change = toProfileChange(row as Record<string, unknown>);
          if (change && pendingMutationsRef.current.get(change.userId)?.size) continue;
          deliver(change);
        }
        if (channelLive.current) setState('live');
      } catch (error) {
        if (alive) {
          setState('error');
          reportError(error, 'useSeatedProfileSync.reconcile');
        }
      } finally {
        clearTimeout(deadline);
        reading = false;
        if (alive && pendingRead) {
          pendingRead = false;
          void reconcile();
        }
      }
    };
    refreshRef.current = () => void reconcile();
    const mutationOff = masterBus.subscribe('CUSTOMIZATION_MUTATION_STATE', (event) => {
      if (event.payload.kind !== 'player-appearance') return;
      const playerId = event.payload.scope;
      if (!safeIds.includes(playerId)) return;
      mutationRevision += 1;
      if (event.payload.state === 'pending') {
        const pending = pendingMutationsRef.current.get(playerId) ?? new Set<string>();
        pending.add(event.payload.mutationId);
        pendingMutationsRef.current.set(playerId, pending);
      } else if (event.payload.state !== 'rolling-back') {
        const pending = pendingMutationsRef.current.get(playerId);
        pending?.delete(event.payload.mutationId);
        if (pending?.size === 0) pendingMutationsRef.current.delete(playerId);
        void reconcile();
      }
    });
    const appearanceOff = masterBus.subscribe('PLAYER_APPEARANCE_CHANGED', (event) => {
      const { userId, avatar, frame, aura } = event.payload;
      deliver({ userId, avatar, frame, aura });
    });
    const onVisible = () => {
      if (document.visibilityState !== 'hidden') void reconcile();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    void reconcile();
    return () => {
      alive = false;
      controller?.abort();
      refreshRef.current = null;
      mutationOff();
      appearanceOff();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [tableId, idKey]);

  useMasterBusBroadcastChannel({
    channelName: tableId && idKey ? `table-appearance:${tableId}` : null,
    event: 'appearance_changed',
    private: true,
    onPayload: (message) => {
      const row = (message as { payload?: { user_id?: unknown } })?.payload;
      if (typeof row?.user_id === 'string' && idKey.split(',').includes(row.user_id)) retry();
    },
    onSubscriptionStatus: (status) => {
      channelLive.current = status === 'SUBSCRIBED';
      if (channelLive.current) retry();
      else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) setState('error');
    },
    onSubscriptionError: () => {
      channelLive.current = false;
      setState('error');
    },
  });
  return { state, retry };
}

export default useSeatedProfileSync;
