import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface TableStudioLoadout {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
  /** Player-facing label stored inside the JSONB loadout cartridge. */
  name?: string;
  /** ISO timestamp used for honest "saved" context in the locker. */
  saved_at?: string;
}

type StoredCollections = {
  favorites: string[];
  loadouts: Array<TableStudioLoadout | null>;
};

type CollectionMutation =
  | { kind: 'favorite'; key: string; enabled: boolean }
  | { kind: 'loadout'; slot: number; value: TableStudioLoadout | null };

type PendingCloudWrite = {
  owner: string;
  mutation: CollectionMutation;
  signature: string;
};

const EMPTY_LOADOUTS: Array<TableStudioLoadout | null> = [null, null, null];

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function normalizeLoadout(value: unknown): TableStudioLoadout | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<TableStudioLoadout>;
  const complete = ['theme_id', 'table_id', 'button_id', 'background_id', 'cards_id'].every(
    (field) => typeof row[field as keyof TableStudioLoadout] === 'string'
  );
  if (!complete) return null;
  const name =
    typeof row.name === 'string' ? row.name.trim().replace(/\s+/g, ' ').slice(0, 32) : '';
  const savedAt =
    typeof row.saved_at === 'string' && Number.isFinite(Date.parse(row.saved_at))
      ? row.saved_at
      : undefined;
  return {
    theme_id: row.theme_id as string,
    table_id: row.table_id as string,
    button_id: row.button_id as string,
    background_id: row.background_id as string,
    cards_id: row.cards_id as string,
    ...(name ? { name } : {}),
    ...(savedAt ? { saved_at: savedAt } : {}),
  };
}

function normalizeCollections(favorites: unknown, loadouts: unknown): StoredCollections {
  const safeFavorites = Array.isArray(favorites)
    ? [...new Set(favorites.filter((item): item is string => typeof item === 'string'))].slice(
        0,
        100
      )
    : [];
  const rawLoadouts = Array.isArray(loadouts) ? loadouts : [];
  return {
    favorites: safeFavorites,
    loadouts: [0, 1, 2].map((slot) => normalizeLoadout(rawLoadouts[slot])),
  };
}

function collectionSignature(value: StoredCollections): string {
  return JSON.stringify(value);
}

function applyMutation(value: StoredCollections, mutation: CollectionMutation): StoredCollections {
  if (mutation.kind === 'favorite') {
    const favorites = mutation.enabled
      ? [mutation.key, ...value.favorites.filter((item) => item !== mutation.key)].slice(0, 100)
      : value.favorites.filter((item) => item !== mutation.key);
    return { favorites, loadouts: value.loadouts };
  }
  const loadouts = [...value.loadouts];
  loadouts[mutation.slot] = mutation.value;
  return { favorites: value.favorites, loadouts };
}

function mutationRpcArgs(mutation: CollectionMutation) {
  return mutation.kind === 'favorite'
    ? {
        p_favorite_key: mutation.key,
        p_favorite_enabled: mutation.enabled,
        p_loadout_slot: null,
        p_loadout: null,
      }
    : {
        p_favorite_key: null,
        p_favorite_enabled: null,
        p_loadout_slot: mutation.slot,
        p_loadout: mutation.value,
      };
}

function rpcCollections(data: unknown): StoredCollections | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  const value = row as { favorites?: unknown; loadouts?: unknown };
  if (!('favorites' in value) || !('loadouts' in value)) return null;
  return normalizeCollections(value.favorites, value.loadouts);
}

export function useTableStudioCollections(isOpen: boolean, userId: string) {
  const owner = userId || 'guest';
  const favoritesKey = `table-studio-favorites:${owner}`;
  const loadoutsKey = `table-studio-loadouts:${owner}`;
  const recentKey = `table-studio-recent:${owner}`;
  const [favorites, setFavorites] = useState<string[]>([]);
  const [loadouts, setLoadouts] = useState<Array<TableStudioLoadout | null>>(EMPTY_LOADOUTS);
  const [recent, setRecent] = useState<string[]>([]);
  const [syncState, setSyncState] = useState<'local' | 'loading' | 'synced' | 'error'>('local');
  const [realtimeState, setRealtimeState] = useState<'local' | 'connecting' | 'live' | 'error'>(
    'local'
  );
  const [realtimeRevision, setRealtimeRevision] = useState(0);
  const favoritesRef = useRef<string[]>([]);
  const loadoutsRef = useRef<Array<TableStudioLoadout | null>>(EMPTY_LOADOUTS);
  const activeOwnerRef = useRef(userId);
  const localMutationRevisionRef = useRef(0);
  const pendingCloudWritesRef = useRef<PendingCloudWrite[]>([]);
  const failedCloudWritesRef = useRef<PendingCloudWrite[]>([]);
  const cloudWriteInFlightRef = useRef(false);
  const staleLocalEchoesRef = useRef<string[]>([]);
  const latestLocalSignatureRef = useRef<string | null>(null);
  activeOwnerRef.current = userId;

  const cache = useCallback(
    (next: StoredCollections) => {
      writeJson(favoritesKey, next.favorites);
      writeJson(loadoutsKey, next.loadouts);
    },
    [favoritesKey, loadoutsKey]
  );

  const applyCollections = useCallback(
    (next: StoredCollections) => {
      favoritesRef.current = next.favorites;
      loadoutsRef.current = next.loadouts;
      setFavorites(next.favorites);
      setLoadouts(next.loadouts);
      cache(next);
    },
    [cache]
  );

  const flushCloudWrites = useCallback(() => {
    if (cloudWriteInFlightRef.current || pendingCloudWritesRef.current.length === 0) return;
    cloudWriteInFlightRef.current = true;
    setSyncState('loading');
    void (async () => {
      while (pendingCloudWritesRef.current.length > 0) {
        const queued = pendingCloudWritesRef.current.shift();
        if (!queued) continue;
        const { data, error } = await supabase.rpc(
          'fn_mutate_table_studio_preferences',
          mutationRpcArgs(queued.mutation)
        );
        if (error) {
          failedCloudWritesRef.current.push(queued);
          reportError(error, 'TableStudio.Collections_sync_failed');
          continue;
        }

        if (pendingCloudWritesRef.current.length > 0) {
          staleLocalEchoesRef.current = [
            ...staleLocalEchoesRef.current.filter((item) => item !== queued.signature),
            queued.signature,
          ].slice(-8);
        } else {
          latestLocalSignatureRef.current = queued.signature;
        }

        const canonical = rpcCollections(data);
        if (
          canonical &&
          pendingCloudWritesRef.current.length === 0 &&
          failedCloudWritesRef.current.length === 0 &&
          activeOwnerRef.current === queued.owner
        ) {
          latestLocalSignatureRef.current = collectionSignature(canonical);
          applyCollections(canonical);
        }
      }
      cloudWriteInFlightRef.current = false;
      const activeOwner = activeOwnerRef.current;
      const failed = failedCloudWritesRef.current.some((item) => item.owner === activeOwner);
      if (activeOwner) setSyncState(failed ? 'error' : 'synced');
      // A tap can land between the final length check and the in-flight flag
      // being cleared. Flush once more so no mutation waits for another tap.
      if (pendingCloudWritesRef.current.length > 0) flushCloudWrites();
    })();
  }, [applyCollections]);

  const persistMutation = useCallback(
    (mutation: CollectionMutation, next: StoredCollections) => {
      cache(next);
      if (!userId) return;
      localMutationRevisionRef.current += 1;
      pendingCloudWritesRef.current.push({
        owner: userId,
        mutation,
        signature: collectionSignature(next),
      });
      flushCloudWrites();
    },
    [cache, flushCloudWrites, userId]
  );

  useEffect(() => {
    if (!isOpen) return undefined;
    const local = normalizeCollections(readJson(favoritesKey), readJson(loadoutsKey));
    const hydrationRevision = localMutationRevisionRef.current;
    favoritesRef.current = local.favorites;
    loadoutsRef.current = local.loadouts;
    setFavorites(local.favorites);
    setLoadouts(local.loadouts);
    const savedRecent = readJson(recentKey);
    setRecent(
      Array.isArray(savedRecent)
        ? savedRecent.filter((item): item is string => typeof item === 'string').slice(0, 12)
        : []
    );

    if (!userId) {
      setSyncState('local');
      return undefined;
    }

    let mounted = true;
    setSyncState('loading');
    void (async () => {
      const { data, error } = await supabase
        .from('user_table_studio_preferences')
        .select('favorites, loadouts')
        .eq('user_id', userId)
        .maybeSingle();
      if (!mounted) return;
      if (error) {
        setSyncState('error');
        reportError(error, 'TableStudio.Collections_load_failed');
        return;
      }
      // A tap made while this request was in flight is newer than its
      // response. The queued writer owns reconciliation from here; applying
      // this response would visibly undo the player's just-made change.
      if (localMutationRevisionRef.current !== hydrationRevision) return;
      if (!data) {
        // Existing users already have device-local collections. Seed their
        // first cloud row without replacing a row another device may create
        // between this read and the write.
        if (local.favorites.length || local.loadouts.some(Boolean)) {
          const seeded = await supabase.rpc('fn_seed_table_studio_preferences', {
            p_favorites: local.favorites,
            p_loadouts: local.loadouts,
          });
          if (!mounted) return;
          if (seeded.error) {
            setSyncState('error');
            reportError(seeded.error, 'TableStudio.Collections_seed_failed');
            return;
          }
          applyCollections(rpcCollections(seeded.data) ?? local);
        }
        setSyncState('synced');
        return;
      }
      const cloud = normalizeCollections(data.favorites, data.loadouts);
      applyCollections(cloud);
      setSyncState('synced');
    })();

    return () => {
      mounted = false;
    };
  }, [applyCollections, favoritesKey, isOpen, loadoutsKey, recentKey, userId]);

  // Realtime owns a separate lifecycle from hydration so Retry Sync can
  // reconnect a failed channel without re-reading an older cloud snapshot over
  // a newer device-local tap.
  useEffect(() => {
    if (!isOpen || !userId) {
      setRealtimeState('local');
      return undefined;
    }
    let mounted = true;
    let everLive = false;
    setRealtimeState('connecting');
    const reconcileAfterRecovery = async () => {
      const { data, error } = await supabase
        .from('user_table_studio_preferences')
        .select('favorites, loadouts')
        .eq('user_id', userId)
        .maybeSingle();
      if (!mounted) return;
      if (error) {
        setRealtimeState('error');
        setSyncState('error');
        reportError(error, 'TableStudio.Collections_reconcile_failed');
        return;
      }
      if (
        data &&
        !cloudWriteInFlightRef.current &&
        pendingCloudWritesRef.current.length === 0 &&
        failedCloudWritesRef.current.length === 0
      ) {
        applyCollections(normalizeCollections(data.favorites, data.loadouts));
        setSyncState('synced');
      }
    };
    const channel = supabase
      .channel(`table-studio-preferences:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_table_studio_preferences',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (!mounted || !payload.new || typeof payload.new !== 'object') return;
          const row = payload.new as { favorites?: unknown; loadouts?: unknown };
          const next = normalizeCollections(row.favorites, row.loadouts);
          const signature = collectionSignature(next);
          // Local taps are the newest intent while the ordered writer is
          // active. Realtime can deliver the first write after a second tap;
          // accepting it here visibly rolls the locker back for a moment.
          if (
            cloudWriteInFlightRef.current ||
            pendingCloudWritesRef.current.length > 0 ||
            failedCloudWritesRef.current.length > 0
          )
            return;
          if (staleLocalEchoesRef.current.includes(signature)) {
            staleLocalEchoesRef.current = staleLocalEchoesRef.current.filter(
              (item) => item !== signature
            );
            return;
          }
          if (signature === latestLocalSignatureRef.current) {
            setSyncState('synced');
            return;
          }
          applyCollections(next);
          setSyncState('synced');
        }
      )
      .subscribe((status) => {
        if (!mounted) return;
        if (status === 'SUBSCRIBED') {
          setRealtimeState('live');
          if (everLive) void reconcileAfterRecovery();
          everLive = true;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeState('error');
          reportError(
            new Error(`Table Studio collection channel ${status.toLowerCase()}`),
            'TableStudio.Collections_realtime_failed'
          );
        }
      });

    return () => {
      mounted = false;
      void supabase.removeChannel(channel);
    };
  }, [applyCollections, isOpen, realtimeRevision, userId]);

  const toggleFavorite = useCallback(
    (key: string) => {
      const mutation: CollectionMutation = {
        kind: 'favorite',
        key,
        enabled: !favoritesRef.current.includes(key),
      };
      const next = applyMutation(
        { favorites: favoritesRef.current, loadouts: loadoutsRef.current },
        mutation
      );
      applyCollections(next);
      persistMutation(mutation, next);
    },
    [applyCollections, persistMutation]
  );

  const saveLoadout = useCallback(
    (slot: number, value: TableStudioLoadout) => {
      if (slot < 0 || slot > 2) return;
      const mutation: CollectionMutation = { kind: 'loadout', slot, value };
      const next = applyMutation(
        { favorites: favoritesRef.current, loadouts: loadoutsRef.current },
        mutation
      );
      applyCollections(next);
      persistMutation(mutation, next);
    },
    [applyCollections, persistMutation]
  );

  const renameLoadout = useCallback(
    (slot: number, name: string) => {
      const current = loadoutsRef.current[slot];
      if (!current) return;
      const cleanName = name.trim().replace(/\s+/g, ' ').slice(0, 32) || `Look ${slot + 1}`;
      if (current.name === cleanName) return;
      const mutation: CollectionMutation = {
        kind: 'loadout',
        slot,
        value: { ...current, name: cleanName },
      };
      const next = applyMutation(
        { favorites: favoritesRef.current, loadouts: loadoutsRef.current },
        mutation
      );
      applyCollections(next);
      persistMutation(mutation, next);
    },
    [applyCollections, persistMutation]
  );

  const clearLoadout = useCallback(
    (slot: number) => {
      if (!loadoutsRef.current[slot]) return;
      const mutation: CollectionMutation = { kind: 'loadout', slot, value: null };
      const next = applyMutation(
        { favorites: favoritesRef.current, loadouts: loadoutsRef.current },
        mutation
      );
      applyCollections(next);
      persistMutation(mutation, next);
    },
    [applyCollections, persistMutation]
  );

  const retrySync = useCallback(() => {
    if (!userId) return;
    setRealtimeRevision((revision) => revision + 1);
    setSyncState('loading');
    void (async () => {
      const { data, error } = await supabase
        .from('user_table_studio_preferences')
        .select('favorites, loadouts')
        .eq('user_id', userId)
        .maybeSingle();
      if (error) {
        setSyncState('error');
        reportError(error, 'TableStudio.Collections_retry_load_failed');
        return;
      }

      const failed = failedCloudWritesRef.current.filter((item) => item.owner === userId);
      failedCloudWritesRef.current = failedCloudWritesRef.current.filter(
        (item) => item.owner !== userId
      );
      const cloud = data
        ? normalizeCollections(data.favorites, data.loadouts)
        : normalizeCollections([], []);
      const merged = failed.reduce((current, item) => applyMutation(current, item.mutation), cloud);
      applyCollections(merged);

      if (failed.length === 0) {
        setSyncState('synced');
        return;
      }
      pendingCloudWritesRef.current.push(...failed);
      flushCloudWrites();
    })();
  }, [applyCollections, flushCloudWrites, userId]);

  const rememberRecent = useCallback(
    (key: string) => {
      setRecent((current) => {
        const next = [key, ...current.filter((item) => item !== key)].slice(0, 12);
        writeJson(recentKey, next);
        return next;
      });
    },
    [recentKey]
  );

  return useMemo(
    () => ({
      favorites,
      loadouts,
      recent,
      syncState,
      realtimeState,
      toggleFavorite,
      saveLoadout,
      renameLoadout,
      clearLoadout,
      retrySync,
      rememberRecent,
    }),
    [
      clearLoadout,
      favorites,
      loadouts,
      recent,
      realtimeState,
      rememberRecent,
      renameLoadout,
      retrySync,
      saveLoadout,
      syncState,
      toggleFavorite,
    ]
  );
}
