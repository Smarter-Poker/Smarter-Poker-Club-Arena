import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface TableStudioLoadout {
  theme_id: string;
  table_id: string;
  button_id: string;
  background_id: string;
  cards_id: string;
}

type StoredCollections = {
  favorites: string[];
  loadouts: Array<TableStudioLoadout | null>;
};

type PendingCloudWrite = {
  owner: string;
  value: StoredCollections;
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

function isLoadout(value: unknown): value is TableStudioLoadout {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<TableStudioLoadout>;
  return ['theme_id', 'table_id', 'button_id', 'background_id', 'cards_id'].every(
    (field) => typeof row[field as keyof TableStudioLoadout] === 'string'
  );
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
    loadouts: [0, 1, 2].map((slot) => (isLoadout(rawLoadouts[slot]) ? rawLoadouts[slot] : null)),
  };
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
  const favoritesRef = useRef<string[]>([]);
  const loadoutsRef = useRef<Array<TableStudioLoadout | null>>(EMPTY_LOADOUTS);
  const activeOwnerRef = useRef(userId);
  const localMutationRevisionRef = useRef(0);
  const pendingCloudWriteRef = useRef<PendingCloudWrite | null>(null);
  const cloudWriteInFlightRef = useRef(false);
  activeOwnerRef.current = userId;

  const cache = useCallback(
    (next: StoredCollections) => {
      writeJson(favoritesKey, next.favorites);
      writeJson(loadoutsKey, next.loadouts);
    },
    [favoritesKey, loadoutsKey]
  );

  const persist = useCallback(
    (next: StoredCollections) => {
      cache(next);
      if (!userId) return;
      localMutationRevisionRef.current += 1;
      pendingCloudWriteRef.current = { owner: userId, value: next };
      if (cloudWriteInFlightRef.current) return;
      cloudWriteInFlightRef.current = true;
      setSyncState('loading');
      void (async () => {
        const failedOwners = new Set<string>();
        while (pendingCloudWriteRef.current) {
          const queued = pendingCloudWriteRef.current;
          pendingCloudWriteRef.current = null;
          const { error } = await supabase.from('user_table_studio_preferences').upsert(
            {
              user_id: queued.owner,
              favorites: queued.value.favorites,
              loadouts: queued.value.loadouts,
            },
            { onConflict: 'user_id' }
          );
          if (error) {
            failedOwners.add(queued.owner);
            reportError(error, 'TableStudio.Collections_sync_failed');
          }
        }
        cloudWriteInFlightRef.current = false;
        const activeOwner = activeOwnerRef.current;
        if (activeOwner) setSyncState(failedOwners.has(activeOwner) ? 'error' : 'synced');
      })();
    },
    [cache, userId]
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
    void supabase
      .from('user_table_studio_preferences')
      .select('favorites, loadouts')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
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
          // first cloud row on open so "sync across devices" is true without
          // requiring an unrelated extra tap.
          if (local.favorites.length || local.loadouts.some(Boolean)) persist(local);
          else setSyncState('synced');
          return;
        }
        const cloud = normalizeCollections(data.favorites, data.loadouts);
        favoritesRef.current = cloud.favorites;
        loadoutsRef.current = cloud.loadouts;
        setFavorites(cloud.favorites);
        setLoadouts(cloud.loadouts);
        cache(cloud);
        setSyncState('synced');
      });

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
          favoritesRef.current = next.favorites;
          loadoutsRef.current = next.loadouts;
          setFavorites(next.favorites);
          setLoadouts(next.loadouts);
          cache(next);
          setSyncState('synced');
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      void supabase.removeChannel(channel);
    };
  }, [cache, favoritesKey, isOpen, loadoutsKey, persist, recentKey, userId]);

  const toggleFavorite = useCallback(
    (key: string) => {
      const current = favoritesRef.current;
      const nextFavorites = current.includes(key)
        ? current.filter((item) => item !== key)
        : [key, ...current].slice(0, 100);
      favoritesRef.current = nextFavorites;
      setFavorites(nextFavorites);
      persist({ favorites: nextFavorites, loadouts: loadoutsRef.current });
    },
    [persist]
  );

  const saveLoadout = useCallback(
    (slot: number, value: TableStudioLoadout) => {
      const nextLoadouts = [...loadoutsRef.current];
      nextLoadouts[slot] = value;
      loadoutsRef.current = nextLoadouts;
      setLoadouts(nextLoadouts);
      persist({ favorites: favoritesRef.current, loadouts: nextLoadouts });
    },
    [persist]
  );

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
      toggleFavorite,
      saveLoadout,
      rememberRecent,
    }),
    [favorites, loadouts, recent, rememberRecent, saveLoadout, syncState, toggleFavorite]
  );
}
