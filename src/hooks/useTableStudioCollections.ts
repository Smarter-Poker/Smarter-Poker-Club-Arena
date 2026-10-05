import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { normalizeFaceDeckId } from '../lib/faceDeck';
import { reportError } from '../utils/errorReporter';

export interface TableStudioLoadout {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
  face_deck_id: string;
  /** Player-facing label stored inside the JSONB loadout cartridge. */
  name?: string;
  /** ISO timestamp used for honest "saved" context in the locker. */
  saved_at?: string;
}

type StoredCollections = {
  favorites: string[];
  loadouts: Array<TableStudioLoadout | null>;
};

type RevisionedCollections = {
  revision: number;
  collections: StoredCollections;
};

type CollectionMutation =
  | { kind: 'favorite'; key: string; enabled: boolean }
  | { kind: 'loadout'; slot: number; value: TableStudioLoadout | null };

type PendingCloudWrite = {
  owner: string;
  lifecycle: number;
  mutation: CollectionMutation;
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
    face_deck_id: normalizeFaceDeckId(row.face_deck_id),
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

function preferenceRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return null;
  return row as Record<string, unknown>;
}

function preferenceRevision(data: unknown): number | null {
  const revision = preferenceRow(data)?.revision;
  const numericRevision =
    typeof revision === 'string' && /^(0|[1-9]\d*)$/.test(revision) ? Number(revision) : revision;
  return typeof numericRevision === 'number' &&
    Number.isSafeInteger(numericRevision) &&
    numericRevision >= 0
    ? numericRevision
    : null;
}

function rpcCollections(data: unknown): StoredCollections | null {
  const value = preferenceRow(data);
  if (!value) return null;
  if (!Array.isArray(value.favorites) || !Array.isArray(value.loadouts)) return null;
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
  const [hydrationRevision, setHydrationRevision] = useState(0);
  const favoritesRef = useRef<string[]>([]);
  const loadoutsRef = useRef<Array<TableStudioLoadout | null>>(EMPTY_LOADOUTS);
  const activeOwnerRef = useRef(owner);
  const activeOwnerLifecycleRef = useRef(0);
  const ownerDataEpochRef = useRef(new Map<string, number>());
  const pendingCloudWritesRef = useRef<PendingCloudWrite[]>([]);
  const failedCloudWritesRef = useRef<PendingCloudWrite[]>([]);
  const cloudWriteOwnersRef = useRef(new Set<string>());
  const ownerRevisionFloorRef = useRef(new Map<string, number>());
  const deferredRealtimeRowsRef = useRef(new Map<string, RevisionedCollections>());

  const bumpOwnerDataEpoch = useCallback((epochOwner: string) => {
    const next = (ownerDataEpochRef.current.get(epochOwner) ?? 0) + 1;
    ownerDataEpochRef.current.set(epochOwner, next);
    return next;
  }, []);

  const clearOwnerEchoLedger = useCallback((echoOwner: string) => {
    deferredRealtimeRowsRef.current.delete(echoOwner);
  }, []);

  const advanceOwnerRevisionFloor = useCallback((revisionOwner: string, revision: number) => {
    const current = ownerRevisionFloorRef.current.get(revisionOwner) ?? -1;
    if (revision < current) return false;
    ownerRevisionFloorRef.current.set(revisionOwner, revision);
    return true;
  }, []);

  const ownerHasPendingWrite = useCallback(
    (writeOwner: string) => pendingCloudWritesRef.current.some((item) => item.owner === writeOwner),
    []
  );
  const ownerHasFailedWrite = useCallback(
    (writeOwner: string) => failedCloudWritesRef.current.some((item) => item.owner === writeOwner),
    []
  );
  const ownerHasUnsettledWrite = useCallback(
    (writeOwner: string) =>
      cloudWriteOwnersRef.current.has(writeOwner) ||
      pendingCloudWritesRef.current.some((item) => item.owner === writeOwner) ||
      failedCloudWritesRef.current.some((item) => item.owner === writeOwner),
    []
  );

  const activeLifecycleMatches = useCallback(
    (requestedOwner: string, lifecycle: number) =>
      activeOwnerRef.current === requestedOwner && activeOwnerLifecycleRef.current === lifecycle,
    []
  );

  const cacheForOwner = useCallback((cacheOwner: string, next: StoredCollections) => {
    writeJson(`table-studio-favorites:${cacheOwner}`, next.favorites);
    writeJson(`table-studio-loadouts:${cacheOwner}`, next.loadouts);
  }, []);

  const applyCollectionsForOwner = useCallback(
    (collectionOwner: string, next: StoredCollections) => {
      cacheForOwner(collectionOwner, next);
      if (activeOwnerRef.current !== collectionOwner) return;
      favoritesRef.current = next.favorites;
      loadoutsRef.current = next.loadouts;
      setFavorites(next.favorites);
      setLoadouts(next.loadouts);
    },
    [cacheForOwner]
  );

  const cache = useCallback(
    (next: StoredCollections) => cacheForOwner(owner, next),
    [cacheForOwner, owner]
  );

  const applyCollections = useCallback(
    (next: StoredCollections) => applyCollectionsForOwner(owner, next),
    [applyCollectionsForOwner, owner]
  );

  const applyDeferredRealtimeForOwner = useCallback(
    (deferredOwner: string) => {
      if (ownerHasUnsettledWrite(deferredOwner)) return false;
      const deferred = deferredRealtimeRowsRef.current.get(deferredOwner);
      if (!deferred) return false;
      if (deferred.revision <= (ownerRevisionFloorRef.current.get(deferredOwner) ?? -1)) {
        deferredRealtimeRowsRef.current.delete(deferredOwner);
        return false;
      }

      ownerRevisionFloorRef.current.set(deferredOwner, deferred.revision);
      clearOwnerEchoLedger(deferredOwner);
      bumpOwnerDataEpoch(deferredOwner);
      applyCollectionsForOwner(deferredOwner, deferred.collections);
      return true;
    },
    [applyCollectionsForOwner, bumpOwnerDataEpoch, clearOwnerEchoLedger, ownerHasUnsettledWrite]
  );

  // Rebind visible state before paint when authentication changes. The
  // passive cloud read may take seconds; no render or tap in that window may
  // derive from the previous account's favorites or loadouts.
  useLayoutEffect(() => {
    if (activeOwnerRef.current === owner) return;
    activeOwnerRef.current = owner;
    activeOwnerLifecycleRef.current += 1;

    const local = normalizeCollections(readJson(favoritesKey), readJson(loadoutsKey));
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
      setRealtimeState('local');
    } else {
      setSyncState(ownerHasFailedWrite(owner) ? 'error' : 'loading');
      setRealtimeState(isOpen ? 'connecting' : 'local');
    }
  }, [favoritesKey, isOpen, loadoutsKey, owner, ownerHasFailedWrite, recentKey, userId]);

  const flushCloudWrites = useCallback(
    (writeOwner: string) => {
      if (cloudWriteOwnersRef.current.has(writeOwner) || !ownerHasPendingWrite(writeOwner)) return;
      cloudWriteOwnersRef.current.add(writeOwner);
      const pumpLifecycle = activeOwnerLifecycleRef.current;
      if (activeLifecycleMatches(writeOwner, pumpLifecycle)) setSyncState('loading');

      void (async () => {
        let finalWriteLifecycle: number | null = null;
        while (true) {
          const queuedIndex = pendingCloudWritesRef.current.findIndex(
            (item) => item.owner === writeOwner
          );
          if (queuedIndex < 0) break;
          const [queued] = pendingCloudWritesRef.current.splice(queuedIndex, 1);
          if (!queued) continue;
          finalWriteLifecycle = queued.lifecycle;

          let data: unknown = null;
          let error: unknown = null;
          try {
            const result = await supabase.rpc('fn_mutate_table_studio_preferences', {
              p_expected_user_id: queued.owner,
              ...mutationRpcArgs(queued.mutation),
            });
            data = result.data;
            error = result.error;
          } catch (cause) {
            error = cause;
          }
          bumpOwnerDataEpoch(writeOwner);

          const rpcRevision = error ? null : preferenceRevision(data);
          const canonical = error ? null : rpcCollections(data);
          const rejectWrite = (syncFailure: unknown) => {
            // A failed earlier intent is an ordering barrier. Nothing newer
            // for this owner may reach the server first or a later retry could
            // replay the old choice over the new one. Move the failed write
            // and every later same-owner intent into one ordered retry queue;
            // other owners keep their independent pending pumps.
            const laterOwnerWrites = pendingCloudWritesRef.current.filter(
              (item) => item.owner === writeOwner
            );
            pendingCloudWritesRef.current = pendingCloudWritesRef.current.filter(
              (item) => item.owner !== writeOwner
            );
            failedCloudWritesRef.current.push(queued, ...laterOwnerWrites);
            reportError(syncFailure, 'TableStudio.Collections_sync_failed');
          };

          if (error) {
            rejectWrite(error);
            break;
          }
          if (rpcRevision === null) {
            rejectWrite(new Error('Table Studio mutation returned a missing or invalid revision'));
            break;
          }
          if (canonical === null) {
            rejectWrite(new Error('Table Studio mutation returned invalid canonical collections'));
            break;
          }
          const currentRevision = ownerRevisionFloorRef.current.get(writeOwner) ?? -1;
          if (
            rpcRevision <= currentRevision ||
            !advanceOwnerRevisionFloor(writeOwner, rpcRevision)
          ) {
            rejectWrite(new Error('Table Studio mutation returned an older revision'));
            break;
          }

          if (!ownerHasPendingWrite(writeOwner) && !ownerHasFailedWrite(writeOwner)) {
            if (activeLifecycleMatches(writeOwner, queued.lifecycle)) {
              applyCollectionsForOwner(writeOwner, canonical);
            } else {
              cacheForOwner(writeOwner, canonical);
              if (activeOwnerRef.current === writeOwner) {
                setHydrationRevision((revision) => revision + 1);
              }
            }
          }
        }

        cloudWriteOwnersRef.current.delete(writeOwner);
        applyDeferredRealtimeForOwner(writeOwner);
        if (activeOwnerRef.current === writeOwner && writeOwner !== 'guest') {
          if (
            finalWriteLifecycle !== null &&
            activeLifecycleMatches(writeOwner, finalWriteLifecycle)
          ) {
            setSyncState(ownerHasFailedWrite(writeOwner) ? 'error' : 'synced');
          } else {
            // A -> B -> A: the old lifecycle may update only its cache. A fresh
            // owner-bound read decides what the newly active lifecycle shows.
            setHydrationRevision((revision) => revision + 1);
          }
        }

        // A tap can land between the final queue check and deleting this
        // owner's pump token. Restart only that owner; other accounts already
        // have independent pumps and never wait behind this RPC.
        if (ownerHasPendingWrite(writeOwner)) flushCloudWrites(writeOwner);
      })();
    },
    [
      activeLifecycleMatches,
      advanceOwnerRevisionFloor,
      applyDeferredRealtimeForOwner,
      applyCollectionsForOwner,
      bumpOwnerDataEpoch,
      cacheForOwner,
      ownerHasFailedWrite,
      ownerHasPendingWrite,
    ]
  );

  const persistMutation = useCallback(
    (mutation: CollectionMutation, next: StoredCollections) => {
      cache(next);
      if (!userId) return;
      bumpOwnerDataEpoch(userId);
      const queued: PendingCloudWrite = {
        owner: userId,
        lifecycle: activeOwnerLifecycleRef.current,
        mutation,
      };
      if (ownerHasFailedWrite(userId)) {
        // The failed queue is the owner-specific retry log. Appending here
        // preserves tap order and prevents this newer intent from being sent
        // ahead of the failed predecessor.
        failedCloudWritesRef.current.push(queued);
        if (activeOwnerRef.current === userId) setSyncState('error');
        return;
      }
      pendingCloudWritesRef.current.push(queued);
      flushCloudWrites(userId);
    },
    [bumpOwnerDataEpoch, cache, flushCloudWrites, ownerHasFailedWrite, userId]
  );

  useEffect(() => {
    if (!isOpen) return undefined;
    const requestedOwner = owner;
    const requestedLifecycle = activeOwnerLifecycleRef.current;
    const local = normalizeCollections(readJson(favoritesKey), readJson(loadoutsKey));
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
    if (ownerHasFailedWrite(requestedOwner)) {
      setSyncState('error');
      return () => {
        mounted = false;
      };
    }
    if (ownerHasUnsettledWrite(requestedOwner)) {
      setSyncState('loading');
      return () => {
        mounted = false;
      };
    }

    const requestedDataEpoch = ownerDataEpochRef.current.get(requestedOwner) ?? 0;
    const requestIsCurrent = () =>
      mounted && activeLifecycleMatches(requestedOwner, requestedLifecycle);
    const responseIsFresh = () =>
      requestIsCurrent() &&
      (ownerDataEpochRef.current.get(requestedOwner) ?? 0) === requestedDataEpoch &&
      !ownerHasUnsettledWrite(requestedOwner);

    setSyncState('loading');
    void (async () => {
      const { data, error } = await supabase
        .from('user_table_studio_preferences')
        .select('favorites, loadouts, revision')
        .eq('user_id', userId)
        .maybeSingle();
      if (!responseIsFresh()) return;
      if (error) {
        setSyncState('error');
        reportError(error, 'TableStudio.Collections_load_failed');
        return;
      }
      // Any enqueue, settlement, retry, or accepted realtime row that happened
      // after this SELECT began owns freshness. This also closes A -> B -> A:
      // the owner string may match again, but the lifecycle and epoch do not.
      if (!data) {
        // Existing users already have device-local collections. Seed their
        // first cloud row without replacing a row another device may create
        // between this read and the write.
        if (local.favorites.length || local.loadouts.some(Boolean)) {
          const seeded = await supabase.rpc('fn_seed_table_studio_preferences', {
            p_expected_user_id: userId,
            p_favorites: local.favorites,
            p_loadouts: local.loadouts,
          });
          if (!responseIsFresh()) return;
          if (seeded.error) {
            setSyncState('error');
            reportError(seeded.error, 'TableStudio.Collections_seed_failed');
            return;
          }
          const seededRevision = preferenceRevision(seeded.data);
          const seededCollections = rpcCollections(seeded.data);
          if (seededRevision === null || seededCollections === null) {
            setSyncState('error');
            reportError(
              new Error('Table Studio seed returned an invalid canonical receipt'),
              'TableStudio.Collections_seed_failed'
            );
            return;
          }
          if (!advanceOwnerRevisionFloor(requestedOwner, seededRevision)) {
            setSyncState('error');
            reportError(
              new Error('Table Studio seed returned an older revision'),
              'TableStudio.Collections_seed_failed'
            );
            return;
          }
          bumpOwnerDataEpoch(requestedOwner);
          clearOwnerEchoLedger(requestedOwner);
          applyCollectionsForOwner(requestedOwner, seededCollections);
        } else {
          bumpOwnerDataEpoch(requestedOwner);
          clearOwnerEchoLedger(requestedOwner);
        }
        if (requestIsCurrent()) setSyncState('synced');
        return;
      }
      const cloudRevision = preferenceRevision(data);
      const cloud = rpcCollections(data);
      if (cloudRevision === null || cloud === null) {
        setSyncState('error');
        reportError(
          new Error('Table Studio collection row returned an invalid canonical receipt'),
          'TableStudio.Collections_load_failed'
        );
        return;
      }
      if (!advanceOwnerRevisionFloor(requestedOwner, cloudRevision)) {
        if (requestIsCurrent()) setSyncState('synced');
        return;
      }
      bumpOwnerDataEpoch(requestedOwner);
      clearOwnerEchoLedger(requestedOwner);
      applyCollectionsForOwner(requestedOwner, cloud);
      if (requestIsCurrent()) setSyncState('synced');
    })();

    return () => {
      mounted = false;
    };
  }, [
    activeLifecycleMatches,
    advanceOwnerRevisionFloor,
    applyCollectionsForOwner,
    bumpOwnerDataEpoch,
    clearOwnerEchoLedger,
    favoritesKey,
    hydrationRevision,
    isOpen,
    loadoutsKey,
    owner,
    ownerHasFailedWrite,
    ownerHasUnsettledWrite,
    recentKey,
    userId,
  ]);

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
    const realtimeOwner = userId;
    const realtimeLifecycle = activeOwnerLifecycleRef.current;
    const realtimeIsCurrent = () =>
      mounted && activeLifecycleMatches(realtimeOwner, realtimeLifecycle);
    setRealtimeState('connecting');
    const reconcileAfterRecovery = async () => {
      const requestedDataEpoch = ownerDataEpochRef.current.get(realtimeOwner) ?? 0;
      const { data, error } = await supabase
        .from('user_table_studio_preferences')
        .select('favorites, loadouts, revision')
        .eq('user_id', realtimeOwner)
        .maybeSingle();
      const responseIsFresh =
        realtimeIsCurrent() &&
        (ownerDataEpochRef.current.get(realtimeOwner) ?? 0) === requestedDataEpoch &&
        !ownerHasUnsettledWrite(realtimeOwner);
      if (!responseIsFresh) return;
      if (error) {
        setRealtimeState('error');
        setSyncState('error');
        reportError(error, 'TableStudio.Collections_reconcile_failed');
        return;
      }
      if (data && (ownerDataEpochRef.current.get(realtimeOwner) ?? 0) === requestedDataEpoch) {
        const cloudRevision = preferenceRevision(data);
        const cloud = rpcCollections(data);
        if (cloudRevision === null || cloud === null) {
          setRealtimeState('error');
          setSyncState('error');
          reportError(
            new Error('Table Studio reconciliation returned an invalid canonical receipt'),
            'TableStudio.Collections_reconcile_failed'
          );
          return;
        }
        if (!advanceOwnerRevisionFloor(realtimeOwner, cloudRevision)) {
          setSyncState('synced');
          return;
        }
        bumpOwnerDataEpoch(realtimeOwner);
        clearOwnerEchoLedger(realtimeOwner);
        applyCollectionsForOwner(realtimeOwner, cloud);
        setSyncState('synced');
      }
    };
    const channel = supabase
      .channel(`table-studio-preferences:${realtimeOwner}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'user_table_studio_preferences',
          filter: `user_id=eq.${realtimeOwner}`,
        },
        (payload) => {
          if (!realtimeIsCurrent()) return;
          if ((payload as { eventType?: string }).eventType === 'DELETE') return;
          const row = (payload.new && typeof payload.new === 'object' ? payload.new : null) as {
            favorites?: unknown;
            loadouts?: unknown;
            revision?: unknown;
          } | null;
          const next = rpcCollections(row);
          const rowRevision = preferenceRevision(row);
          if (rowRevision === null || next === null) {
            setRealtimeState('error');
            setSyncState('error');
            reportError(
              new Error('Table Studio realtime row returned an invalid canonical receipt'),
              'TableStudio.Collections_realtime_failed'
            );
            return;
          }
          const revisionFloor = ownerRevisionFloorRef.current.get(realtimeOwner) ?? -1;
          if (rowRevision <= revisionFloor) return;
          if (ownerHasUnsettledWrite(realtimeOwner)) {
            const deferred = deferredRealtimeRowsRef.current.get(realtimeOwner);
            if (!deferred || rowRevision > deferred.revision) {
              deferredRealtimeRowsRef.current.set(realtimeOwner, {
                revision: rowRevision,
                collections: next,
              });
              // A deferred authoritative row also invalidates any SELECT
              // already in flight for this owner. The row is applied after
              // the ordered writer settles, never over a pending local tap.
              bumpOwnerDataEpoch(realtimeOwner);
            }
            return;
          }

          ownerRevisionFloorRef.current.set(realtimeOwner, rowRevision);
          clearOwnerEchoLedger(realtimeOwner);
          bumpOwnerDataEpoch(realtimeOwner);
          applyCollectionsForOwner(realtimeOwner, next);
          setSyncState('synced');
        }
      )
      .subscribe((status) => {
        if (!realtimeIsCurrent()) return;
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
  }, [
    activeLifecycleMatches,
    advanceOwnerRevisionFloor,
    applyCollectionsForOwner,
    bumpOwnerDataEpoch,
    clearOwnerEchoLedger,
    isOpen,
    ownerHasUnsettledWrite,
    realtimeRevision,
    userId,
  ]);

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
      const normalized = normalizeLoadout(value);
      if (!normalized) return;
      const mutation: CollectionMutation = { kind: 'loadout', slot, value: normalized };
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
    const retryOwner = userId;
    const retryLifecycle = activeOwnerLifecycleRef.current;
    const retryDataEpoch = ownerDataEpochRef.current.get(retryOwner) ?? 0;
    setRealtimeRevision((revision) => revision + 1);
    setSyncState('loading');
    void (async () => {
      const { data, error } = await supabase
        .from('user_table_studio_preferences')
        .select('favorites, loadouts, revision')
        .eq('user_id', retryOwner)
        .maybeSingle();
      if (!activeLifecycleMatches(retryOwner, retryLifecycle)) return;
      if ((ownerDataEpochRef.current.get(retryOwner) ?? 0) !== retryDataEpoch) {
        if (ownerHasFailedWrite(retryOwner)) setSyncState('error');
        return;
      }
      if (error) {
        setSyncState('error');
        reportError(error, 'TableStudio.Collections_retry_load_failed');
        return;
      }

      let cloud = normalizeCollections([], []);
      if (data) {
        const cloudRevision = preferenceRevision(data);
        const canonical = rpcCollections(data);
        if (cloudRevision === null || canonical === null) {
          setSyncState('error');
          reportError(
            new Error('Table Studio retry returned an invalid canonical receipt'),
            'TableStudio.Collections_retry_load_failed'
          );
          return;
        }
        if (!advanceOwnerRevisionFloor(retryOwner, cloudRevision)) {
          setSyncState(ownerHasFailedWrite(retryOwner) ? 'error' : 'synced');
          return;
        }
        cloud = canonical;
      }

      const failed = failedCloudWritesRef.current.filter((item) => item.owner === retryOwner);
      failedCloudWritesRef.current = failedCloudWritesRef.current.filter(
        (item) => item.owner !== retryOwner
      );
      const merged = failed.reduce((current, item) => applyMutation(current, item.mutation), cloud);
      bumpOwnerDataEpoch(retryOwner);
      clearOwnerEchoLedger(retryOwner);
      applyCollectionsForOwner(retryOwner, merged);

      if (failed.length === 0) {
        setSyncState('synced');
        return;
      }
      pendingCloudWritesRef.current.push(
        ...failed.map((item) => ({ ...item, lifecycle: retryLifecycle }))
      );
      flushCloudWrites(retryOwner);
    })();
  }, [
    activeLifecycleMatches,
    advanceOwnerRevisionFloor,
    applyCollectionsForOwner,
    bumpOwnerDataEpoch,
    clearOwnerEchoLedger,
    flushCloudWrites,
    ownerHasFailedWrite,
    userId,
  ]);

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
